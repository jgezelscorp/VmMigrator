import { COMPUTE_API } from '../discovery/discovery.js';
import type { DiskControllerType, MigrationJobOptions, MigrationPlan, PlannedAction, PreCheckResult, VmInfo } from '../domain/types.js';

export const DISK_API = '2024-03-02';
export const ARM_HOST = 'https://management.azure.com';

export const snapshotPath = (vm: VmInfo, name: string): string =>
  `/subscriptions/${vm.subscriptionId}/resourceGroups/${vm.resourceGroup}/providers/Microsoft.Compute/snapshots/${name}`;

export function snapshotName(vmName: string, role: 'os' | 'data', lun: number | undefined, jobId: string): string {
  const base = `${vmName}-${role === 'os' ? 'os' : `data${lun ?? 0}`}`.replace(/[^A-Za-z0-9_.-]/g, '-');
  const suffix = `-vmm-${jobId.slice(0, 8)}`;
  return `${base.slice(0, 80 - suffix.length)}${suffix}`;
}

export interface SnapshotTarget {
  role: 'os' | 'data';
  lun?: number;
  diskId: string;
  diskName: string;
  snapshotName: string;
}

/** Managed disks that can be snapshotted (ephemeral/unmanaged disks are skipped). */
export function snapshotTargets(vm: VmInfo, jobId: string): SnapshotTarget[] {
  const out: SnapshotTarget[] = [];
  if (vm.osDisk?.id && !vm.ephemeralOsDisk) {
    out.push({ role: 'os', diskId: vm.osDisk.id, diskName: vm.osDisk.name, snapshotName: snapshotName(vm.name, 'os', undefined, jobId) });
  }
  for (const d of vm.dataDisks ?? []) {
    if (!d.id) continue;
    out.push({ role: 'data', lun: d.lun ?? 0, diskId: d.id, diskName: d.name, snapshotName: snapshotName(vm.name, 'data', d.lun, jobId) });
  }
  return out;
}

export function snapshotBody(vm: VmInfo, t: SnapshotTarget, jobId: string): unknown {
  return {
    location: vm.location,
    sku: { name: 'Standard_LRS' },
    tags: { purpose: 'vmmigrator', sourceVm: vm.name, jobId },
    properties: { creationData: { createOption: 'Copy', sourceResourceId: t.diskId }, incremental: true },
  };
}

/** Body of the single VM update that changes size (and disk controller when it must change). */
export function updateBody(targetSku: string, controller: DiskControllerType | undefined, current: DiskControllerType | undefined): unknown {
  const change = controller !== undefined && controller !== (current ?? 'SCSI');
  return {
    properties: {
      hardwareProfile: { vmSize: targetSku },
      ...(change ? { storageProfile: { diskControllerType: controller } } : {}),
    },
  };
}

export interface PlanInput {
  vm: VmInfo;
  preCheck: PreCheckResult;
  jobId: string;
  dryRun: boolean;
  options?: MigrationJobOptions;
}

/** Builds the exact ARM operations a migration performs (also the dry-run output). */
export function buildPlan({ vm, preCheck, jobId, dryRun, options = {} }: PlanInput): MigrationPlan {
  const current: DiskControllerType = vm.diskControllerType ?? 'SCSI';
  const controller = preCheck.targetDiskController ?? current;
  const vmUrl = `${ARM_HOST}${vm.id}`;
  const actions: PlannedAction[] = [
    {
      step: 'Validated',
      description: `Re-run pre-checks for ${vm.vmSize} -> ${preCheck.targetSku}; refuse when any check is BLOCK`,
      method: 'GET',
      url: `${vmUrl}?api-version=${COMPUTE_API}&$expand=instanceView`,
    },
  ];

  if (!options.skipSnapshots) {
    for (const t of snapshotTargets(vm, jobId)) {
      actions.push({
        step: 'SnapshotTaken',
        description: `Incremental snapshot of ${t.role === 'os' ? 'OS' : `data (LUN ${t.lun})`} disk ${t.diskName}`,
        method: 'PUT',
        url: `${ARM_HOST}${snapshotPath(vm, t.snapshotName)}?api-version=${DISK_API}`,
        body: snapshotBody(vm, t, jobId),
      });
    }
  }

  const needsDealloc = vm.powerState !== 'deallocated';
  actions.push({
    step: 'Deallocated',
    description: needsDealloc ? 'Deallocate the VM (downtime starts; dynamic IPs and temp-disk data are lost)' : 'VM already deallocated; nothing to do',
    ...(needsDealloc ? { method: 'POST' as const, url: `${vmUrl}/deallocate?api-version=${COMPUTE_API}` } : {}),
  });

  actions.push({
    step: 'Updated',
    description:
      controller !== current
        ? `Set vmSize=${preCheck.targetSku} and diskControllerType=${controller} in one update`
        : `Set vmSize=${preCheck.targetSku} (disk controller stays ${current})`,
    method: 'PATCH',
    url: `${vmUrl}?api-version=${COMPUTE_API}`,
    body: updateBody(preCheck.targetSku, controller, current),
  });

  const shouldRun = vm.powerState !== 'deallocated' && vm.powerState !== 'stopped';
  actions.push(
    {
      step: 'Started',
      description: shouldRun ? 'Start the VM' : 'VM was not running before migration; it stays deallocated',
      ...(shouldRun ? { method: 'POST' as const, url: `${vmUrl}/start?api-version=${COMPUTE_API}` } : {}),
    },
    {
      step: 'Started',
      description: 'Wait until provisioningState is Succeeded and the power state matches',
      method: 'GET',
      url: `${vmUrl}?api-version=${COMPUTE_API}&$expand=instanceView`,
    },
    { step: 'PostChecked', description: 'Run post-checks (provisioning, power, size, controller, agent, extensions, optional guest probe)' },
    {
      step: 'Done',
      description:
        options.cleanupSnapshots && !options.skipSnapshots
          ? 'Delete the migration snapshots after a successful post-check'
          : 'Keep snapshots and the original VM model for rollback until sign-off',
    },
  );

  return {
    vmId: vm.id,
    vmName: vm.name,
    ...(vm.availabilitySetId ? { availabilitySetId: vm.availabilitySetId } : {}),
    sourceSku: vm.vmSize,
    targetSku: preCheck.targetSku,
    sourceDiskController: current,
    targetDiskController: controller,
    dryRun,
    actions,
    preCheck,
  };
}
