import type { CheckResult, CheckStatus, DiskControllerType, VmInfo } from '../domain/types.js';
import type { SkuInfo } from '../azure/skus.js';
import type { PreCheck, TargetRequirement } from './types.js';

const result = (checkId: string, status: CheckStatus, message: string, remediation?: string): CheckResult => ({
  checkId,
  status,
  message,
  ...(remediation ? { remediation } : {}),
});
const pass = (id: string, message: string): CheckResult => result(id, 'PASS', message);
const warn = (id: string, message: string, remediation?: string): CheckResult => result(id, 'WARN', message, remediation);
const block = (id: string, message: string, remediation?: string): CheckResult => result(id, 'BLOCK', message, remediation);

export function targetGenerationOf(sku: string): number {
  const m = /_v(\d+)$/i.exec(sku);
  return m ? Number(m[1]) : 0;
}

/** Disk controller the migration has to set for this target; NVMe only when the size cannot do SCSI. */
export function requiredController(vm: VmInfo, target: SkuInfo | undefined): TargetRequirement {
  const current: DiskControllerType = vm.diskControllerType ?? 'SCSI';
  if (!target) return { controller: current, conversion: false };
  const types = target.diskControllers.map((c) => c.toUpperCase());
  const controller: DiskControllerType =
    !types.includes('SCSI') && types.includes('NVME') ? 'NVMe' : types.includes(current.toUpperCase()) ? current : 'SCSI';
  return { controller, conversion: controller !== current };
}

export type OsSupport = 'supported' | 'unsupported' | 'unknown';

/** Heuristic NVMe-readiness of the OS image (research.md section 3); the guest cannot be inspected through ARM. */
export function assessNvmeOs(vm: VmInfo): { support: OsSupport; detail: string } {
  const img = vm.imageReference;
  if (!img || (!img.publisher && !img.offer)) {
    return { support: 'unknown', detail: img?.id ? 'custom/gallery image' : 'no image reference (attached disk)' };
  }
  const publisher = (img.publisher ?? '').toLowerCase();
  const offer = (img.offer ?? '').toLowerCase();
  const sku = (img.sku ?? '').toLowerCase();
  const label = [img.publisher, img.offer, img.sku].filter(Boolean).join(':');
  const verdict = (ok: boolean | undefined): { support: OsSupport; detail: string } =>
    ok === undefined ? { support: 'unknown', detail: label } : { support: ok ? 'supported' : 'unsupported', detail: label };

  if (vm.osType === 'Windows') {
    if (/^windows-?(10|11)/.test(offer)) return verdict(true);
    const year = /(?:ws)?(20\d\d)/.exec(sku)?.[1] ?? /(?:ws)?(20\d\d)/.exec(offer)?.[1];
    return verdict(year ? Number(year) >= 2019 : undefined);
  }

  if (publisher === 'canonical') {
    const text = `${offer} ${sku}`;
    if (/(bionic|focal|jammy|noble|oracular|plucky)/.test(text)) return verdict(true);
    if (/(xenial|trusty)/.test(text)) return verdict(false);
    const v = /(\d\d)[._-](\d\d)/.exec(text);
    return verdict(v ? Number(v[1]) >= 18 : undefined);
  }
  if (publisher === 'redhat' || publisher === 'redhat-rhel') {
    const v = /^(\d+)(?:[._-](\d+))?/.exec(sku);
    if (!v) return verdict(undefined);
    const major = Number(v[1]);
    const minor = v[2] === undefined ? undefined : Number(v[2]);
    if (major >= 9) return verdict(true);
    if (major === 8) return verdict(minor === undefined ? undefined : minor >= 6);
    if (major === 7) return verdict(minor === undefined ? undefined : minor >= 9);
    return verdict(false);
  }
  if (publisher === 'suse') {
    const v = /sles-?(\d+)(?:-sp(\d+))?/.exec(`${offer} ${sku}`);
    if (!v) return verdict(undefined);
    return verdict(Number(v[1]) > 15 || (Number(v[1]) === 15 && Number(v[2] ?? 0) >= 4));
  }
  if (publisher === 'debian') {
    const v = /(\d+)/.exec(offer) ?? /(\d+)/.exec(sku);
    return verdict(v ? Number(v[1]) >= 11 : undefined);
  }
  return verdict(undefined);
}

const isPremium = (t?: string): boolean => !!t && /^(premium|ultra)/i.test(t);
const hasTemp = (s: SkuInfo | undefined, fallback: boolean): boolean => (s ? s.maxResourceVolumeMB > 0 : fallback);

export const PRE_CHECKS: PreCheck[] = [
  {
    id: 'vm-state',
    run: ({ vm }) => {
      if (vm.provisioningState && vm.provisioningState !== 'Succeeded') {
        return block('vm-state', `VM provisioning state is ${vm.provisioningState}.`, 'Wait for the current operation to finish or repair the VM before migrating.');
      }
      if (vm.powerState === 'running') return warn('vm-state', 'VM is running; it will be deallocated during migration (downtime).', 'Schedule a maintenance window.');
      if (vm.powerState === 'deallocated') return pass('vm-state', 'VM is deallocated and healthy.');
      return warn('vm-state', `VM power state is ${vm.powerState}.`, 'Bring the VM to a stable running or deallocated state first.');
    },
  },
  {
    id: 'sku-availability',
    run: ({ vm, target, targetSku }) => {
      if (!target) {
        return block('sku-availability', `${targetSku} is not offered in ${vm.location} for this subscription.`, 'Pick another target size/region or check regional availability with the Resource SKUs API.');
      }
      const loc = target.restrictions.find((r) => r.type === 'Location');
      if (loc) {
        return block('sku-availability', `${targetSku} is restricted in ${vm.location} (${loc.reasonCode ?? 'restricted'}).`, 'Request access via a support case/quota request or choose another size or region.');
      }
      if (vm.zones.length) {
        const zone = vm.zones[0] as string;
        const zr = target.restrictions.find((r) => r.type === 'Zone' && r.zones?.includes(zone));
        if (zr) return block('sku-availability', `${targetSku} is restricted in zone ${zone} (${zr.reasonCode ?? 'restricted'}).`, 'Choose a size offered in the VM zone.');
        if (!target.zones.includes(zone)) {
          return block('sku-availability', `${targetSku} is not offered in zone ${zone} of ${vm.location} (zones: ${target.zones.join(',') || 'none'}).`, 'Choose a size offered in the VM zone or redeploy to another zone.');
        }
      }
      return pass('sku-availability', `${targetSku} is available in ${vm.location}${vm.zones.length ? ` zone ${vm.zones[0]}` : ''}.`);
    },
  },
  {
    id: 'quota',
    run: ({ vm, target, source, usages, loadErrors }) => {
      if (!target) return warn('quota', 'Quota not evaluated because the target size is unavailable.');
      if (!usages) return warn('quota', `Could not read compute usages (${loadErrors['usages'] ?? 'unknown error'}); quota not verified.`, 'Verify vCPU quota in the portal.');
      const find = (n: string) => usages.find((u) => u.name.toLowerCase() === n.toLowerCase());
      const family = find(target.family);
      const regional = find('cores');
      const sameFamily = !!source?.family && source.family === target.family;
      const needFamily = sameFamily ? Math.max(0, target.vcpus - (source?.vcpus ?? 0)) : target.vcpus;
      const needRegional = Math.max(0, target.vcpus - (source?.vcpus ?? 0));
      if (!family) return warn('quota', `No usage entry for family ${target.family}; family quota is unverified.`, 'Check quota for this family in the portal.');
      const familyFree = family.limit - family.currentValue;
      if (familyFree < needFamily) {
        return block('quota', `Family ${target.family} has ${familyFree} free vCPUs (limit ${family.limit}), ${needFamily} needed.`, `Request a quota increase for ${target.family} in ${vm.location}.`);
      }
      if (regional && regional.limit - regional.currentValue < needRegional) {
        return block('quota', `Regional vCPU quota has ${regional.limit - regional.currentValue} free, ${needRegional} more needed.`, `Request a regional vCPU quota increase in ${vm.location}.`);
      }
      return pass('quota', `Family ${target.family} has ${familyFree} free vCPUs (need ${needFamily}).`);
    },
  },
  {
    id: 'generation',
    run: ({ vm, target, targetSku, targetGeneration }) => {
      const gen2Only = target ? !target.generations.includes('V1') : targetGeneration >= 6;
      if (!vm.hyperVGeneration) return warn('generation', 'Hyper-V generation of the VM is unknown.', 'Verify the VM is Generation 2 before migrating to v6/v7.');
      if (vm.hyperVGeneration === 'V1' && gen2Only) {
        return block('generation', `VM is Generation 1 and ${targetSku} only supports Generation 2.`, 'Rebuild from a Gen2 image, convert via snapshot/MBR2GPT, or fall back to a v5 target (Gen1 capable).');
      }
      return pass('generation', `VM is ${vm.hyperVGeneration === 'V2' ? 'Generation 2' : 'Generation 1'}; compatible with ${targetSku}.`);
    },
  },
  {
    id: 'disk-controller',
    run: ({ vm, target, targetSku }) => {
      if (!target) return warn('disk-controller', 'Disk controller not evaluated because the target size is unavailable.');
      const types = target.diskControllers.map((c) => c.toUpperCase());
      const current = vm.diskControllerType ?? 'SCSI';
      if (current === 'NVMe' && !types.includes('NVME')) {
        return block('disk-controller', `VM uses NVMe but ${targetSku} only supports ${types.join(',')}.`, 'Choose a target that supports NVMe or convert the VM back to SCSI first.');
      }
      const req = requiredController(vm, target);
      if (req.conversion) {
        return warn('disk-controller', `${targetSku} requires NVMe; the migration will deallocate the VM and set diskControllerType=NVMe together with the new size.`, 'Make sure the guest OS has NVMe drivers (initramfs/fstab UUIDs on Linux).');
      }
      return pass('disk-controller', `Disk controller ${req.controller} is supported by ${targetSku}.`);
    },
  },
  {
    id: 'nvme-image',
    run: ({ vm, target, targetSku, targetGeneration, imageControllers }) => {
      const needsNvme = (target ? requiredController(vm, target).controller === 'NVMe' : false) || targetGeneration >= 6;
      if (!needsNvme) return pass('nvme-image', 'Target does not require an NVMe-ready image.');
      if (imageControllers?.some((c) => c.toUpperCase() === 'NVME')) {
        return pass('nvme-image', 'Image is tagged NVMe-capable (DiskControllerTypes).');
      }
      const os = assessNvmeOs(vm);
      if (os.support === 'unsupported') {
        return block('nvme-image', `OS image ${os.detail} has no NVMe driver support, required by ${targetSku}.`, 'Upgrade the OS (WS2019+, Ubuntu 18.04+, RHEL 8.6+/9, SLES 15 SP4+, Debian 11+) or choose a v5 target.');
      }
      if (os.support === 'unknown') {
        return warn('nvme-image', `Cannot verify NVMe support of ${os.detail}.`, 'Validate NVMe driver, MANA and fstab/UUID usage in the guest; consider a pilot clone first.');
      }
      return pass('nvme-image', `OS image ${os.detail} supports NVMe (verified by OS version).`);
    },
  },
  {
    id: 'temp-disk',
    run: ({ vm, source, target, targetSku }) => {
      if (!target) return warn('temp-disk', 'Temp disk compatibility not evaluated because the target size is unavailable.');
      const src = hasTemp(source, true);
      const dst = hasTemp(target, false);
      if (src && !dst) {
        if (vm.osType === 'Windows') {
          return block('temp-disk', `Windows cannot resize from a size with a temp disk to the diskless ${targetSku}.`, 'Choose a "d" size (e.g. Dadsv7), or move the pagefile to C:, snapshot, and create a new VM from the disk.');
        }
        return warn('temp-disk', `${targetSku} has no temp disk; /mnt, swap and scratch data will be gone.`, 'Remove temp-disk dependencies (fstab /mnt, waagent ResourceDisk) before migrating.');
      }
      if (!src && dst && vm.osType === 'Windows') {
        return block('temp-disk', `Windows cannot resize from a diskless size to ${targetSku}, which has a temp disk.`, 'Choose a diskless target.');
      }
      if (src && dst) return warn('temp-disk', `${targetSku} presents its temp disk as local NVMe; contents are lost and device names can change.`, 'Do not keep pagefile/swap data you need on the temp disk.');
      return pass('temp-disk', 'Neither source nor target has a temp disk.');
    },
  },
  {
    id: 'accelerated-networking',
    run: ({ vm, target, targetGeneration }) => {
      if (!target) return warn('accelerated-networking', 'Networking not evaluated because the target size is unavailable.');
      if (vm.acceleratedNetworking && !target.acceleratedNetworking) {
        return warn('accelerated-networking', 'NIC uses accelerated networking but the target size does not support it.', 'Expect lower network performance; pick a size with accelerated networking.');
      }
      if (vm.acceleratedNetworking === false && target.acceleratedNetworking) {
        return warn('accelerated-networking', 'Accelerated networking is supported by the target but disabled on the NIC.', 'Enable accelerated networking on the NIC while the VM is deallocated.');
      }
      if (targetGeneration >= 6) return pass('accelerated-networking', 'Target uses MANA/NetVSC networking; supported by current Windows/Linux images.');
      return pass('accelerated-networking', 'Accelerated networking configuration is compatible.');
    },
  },
  {
    id: 'azure-disk-encryption',
    run: ({ vm, target, targetSku, targetGeneration }) => {
      if (!vm.encryption?.ade) return pass('azure-disk-encryption', 'Azure Disk Encryption is not used.');
      const nvmeFirst = targetGeneration >= 6 || (target ? !target.diskControllers.map((c) => c.toUpperCase()).includes('SCSI') : false);
      if (nvmeFirst) {
        return block('azure-disk-encryption', `Azure Disk Encryption is not supported on ${targetSku} (v6/v7 / NVMe).`, 'Rebuild with encryption at host (not possible on a VM that ever had ADE) or choose a v5 target.');
      }
      return warn('azure-disk-encryption', 'VM uses Azure Disk Encryption (retires 2028-09-15).', 'Plan the move to encryption at host.');
    },
  },
  {
    id: 'ephemeral-os-disk',
    run: ({ vm, target, targetSku }) => {
      if (!vm.ephemeralOsDisk) return pass('ephemeral-os-disk', 'OS disk is not ephemeral.');
      const diskless = target ? target.maxResourceVolumeMB === 0 : false;
      if (!target || !target.ephemeralOsDisk || diskless) {
        return block('ephemeral-os-disk', `Ephemeral OS disk is not supported on ${targetSku}${diskless ? ' (diskless size)' : ''}.`, 'Choose a "d" size that supports ephemeral OS disks, or redeploy with a managed OS disk.');
      }
      return warn('ephemeral-os-disk', 'Ephemeral OS disk: the OS is re-imaged on resize/deallocate.', 'Ensure the workload is stateless and the image is reproducible.');
    },
  },
  {
    id: 'availability-set',
    run: ({ vm, availabilitySetVms }) => {
      if (!vm.availabilitySetId) return pass('availability-set', 'VM is not in an availability set.');
      const others = (availabilitySetVms ?? []).filter((v) => v.id.toLowerCase() !== vm.id.toLowerCase()).map((v) => v.name);
      return warn(
        'availability-set',
        `VM is in an availability set${others.length ? ` with ${others.join(', ')}` : ''}; the target family may not exist on the pinned hardware cluster.`,
        'Migrate one VM per availability set at a time; if allocation fails, deallocate all VMs in the set and resize them together.',
      );
    },
  },
  {
    id: 'proximity-placement-group',
    run: ({ vm }) =>
      vm.proximityPlacementGroupId
        ? warn('proximity-placement-group', 'VM is in a proximity placement group; the new size must be available in the PPG datacenter.', 'Expect allocation failures; deallocate all PPG VMs and resize together if needed.')
        : pass('proximity-placement-group', 'VM is not in a proximity placement group.'),
  },
  {
    id: 'reserved-ip',
    run: ({ vm }) => {
      const ips = (vm.nics ?? []).flatMap((n) => n.publicIps);
      const volatile = ips.filter((i) => i.allocationMethod?.toLowerCase() === 'dynamic' || i.sku?.toLowerCase() === 'basic');
      if (volatile.length) {
        return warn('reserved-ip', `${volatile.length} public IP(s) are dynamic/Basic and will change or be released on deallocation.`, 'Convert to static Standard public IPs before migrating if the address must be preserved.');
      }
      return pass('reserved-ip', ips.length ? 'Public IPs are static and survive deallocation.' : 'No public IPs attached.');
    },
  },
  {
    id: 'backup',
    run: ({ backup, loadErrors }) => {
      if (backup?.protected) return pass('backup', `Protected by Azure Backup${backup.lastRecoveryPoint ? ` (last recovery point ${backup.lastRecoveryPoint})` : ''}.`);
      if (loadErrors['backup']) return warn('backup', `Backup state could not be read (${loadErrors['backup']}).`, 'The migration still snapshots all disks before changing the VM.');
      return warn('backup', 'VM is not protected by Azure Backup.', 'The migration snapshots OS and data disks first; enable backup for ongoing protection.');
    },
  },
  {
    id: 'resource-locks',
    run: ({ locks, loadErrors }) => {
      if (!locks) return warn('resource-locks', `Resource locks could not be read (${loadErrors['locks'] ?? 'unknown'}).`, 'Verify no ReadOnly lock covers the VM.');
      const ro = locks.find((l) => l.level === 'ReadOnly');
      if (ro) return block('resource-locks', `ReadOnly lock "${ro.name}" on ${ro.scope} prevents changing the VM.`, 'Remove the lock for the migration window and restore it afterwards.');
      const cnd = locks.find((l) => l.level === 'CanNotDelete');
      if (cnd) return warn('resource-locks', `CanNotDelete lock "${cnd.name}" present; resize is allowed but snapshots cannot be cleaned up automatically while it applies.`, 'Review the lock before removing snapshots after sign-off.');
      return pass('resource-locks', 'No resource locks affect the VM.');
    },
  },
  {
    id: 'placement-constraints',
    run: ({ vm }) => {
      const notes: string[] = [];
      let status: CheckStatus = 'PASS';
      if (vm.virtualMachineScaleSetId) {
        status = 'BLOCK';
        notes.push('VM belongs to a scale set; resize it through the scale set model.');
      }
      if (vm.priority === 'Spot' || vm.priority === 'Low') {
        if (status !== 'BLOCK') status = 'WARN';
        notes.push('Spot VM: allocation of the new size can fail or be evicted.');
      }
      if (vm.capacityReservationGroupId) {
        if (status !== 'BLOCK') status = 'WARN';
        notes.push('Capacity reservation: the reservation is size specific; disassociate or create a reservation for the target size.');
      }
      if (vm.dedicatedHostId) {
        if (status !== 'BLOCK') status = 'WARN';
        notes.push('Dedicated host: the target family must be supported by the host.');
      }
      return status === 'PASS'
        ? pass('placement-constraints', 'No spot, capacity reservation, dedicated host or scale set constraints.')
        : result('placement-constraints', status, notes.join(' '), status === 'BLOCK' ? 'Migrate via the scale set model.' : 'Resolve the listed constraints before migrating.');
    },
  },
  {
    id: 'premium-storage',
    run: ({ vm, target, targetSku }) => {
      const disks = [vm.osDisk, ...(vm.dataDisks ?? [])].filter((d) => d && isPremium(d.storageAccountType));
      if (!disks.length) return pass('premium-storage', 'No premium disks attached.');
      if (target && !target.premiumIO) return block('premium-storage', `VM uses premium disks but ${targetSku} does not support Premium Storage.`, 'Choose an "s" size.');
      return pass('premium-storage', 'Target supports Premium Storage.');
    },
  },
  {
    id: 'disk-limits',
    run: ({ vm, target, targetSku }) => {
      const count = vm.dataDisks?.length ?? 0;
      if (target?.maxDataDisks !== undefined && count > target.maxDataDisks) {
        return block('disk-limits', `VM has ${count} data disks but ${targetSku} supports ${target.maxDataDisks}.`, 'Choose a larger size or detach disks.');
      }
      return pass('disk-limits', `${count} data disk(s) within the target limit${target?.maxDataDisks ? ` of ${target.maxDataDisks}` : ''}.`);
    },
  },
  {
    id: 'shared-disks',
    run: ({ vm, targetGeneration, target }) => {
      const shared = [vm.osDisk, ...(vm.dataDisks ?? [])].filter((d) => d?.shared);
      if (!shared.length) return pass('shared-disks', 'No shared disks attached.');
      const nvme = target ? requiredController(vm, target).controller === 'NVMe' : targetGeneration >= 6;
      const ws2019 = vm.osType === 'Windows' && /2019/.test(`${vm.imageReference?.sku ?? ''}${vm.imageReference?.offer ?? ''}`);
      if (nvme && ws2019) return block('shared-disks', 'Shared disks are not supported on NVMe with Windows Server 2019.', 'Use Windows Server 2022+ or keep a SCSI target.');
      return warn('shared-disks', `${shared.length} shared disk(s) attached; cluster behaviour on the new size must be validated.`, 'Migrate cluster nodes one at a time and test failover.');
    },
  },
  {
    id: 'extensions',
    run: ({ vm }) => {
      const bad = (vm.extensions ?? []).filter((e) => e.provisioningState && e.provisioningState !== 'Succeeded');
      if (bad.length) return warn('extensions', `Extensions not healthy: ${bad.map((e) => `${e.name} (${e.provisioningState})`).join(', ')}.`, 'Repair or remove failing extensions so they can be verified after migration.');
      return pass('extensions', `${vm.extensions?.length ?? 0} extension(s) provisioned successfully.`);
    },
  },
  {
    id: 'security-type',
    run: ({ vm }) => {
      if (vm.securityType === 'ConfidentialVM') return block('security-type', 'Confidential VMs cannot be migrated to general-purpose v6/v7 sizes.', 'Use a confidential VM size family.');
      if (vm.securityType === 'TrustedLaunch') return pass('security-type', 'Trusted Launch is supported by v6/v7 sizes.');
      return pass('security-type', 'Standard security type.');
    },
  },
  {
    id: 'deallocation-required',
    run: ({ vm, target }) => {
      const req = requiredController(vm, target);
      if (vm.powerState === 'deallocated') return pass('deallocation-required', 'VM is already deallocated.');
      return req.conversion
        ? warn('deallocation-required', 'Deallocation is required (controller change); dynamic IPs and temp-disk data are lost.', 'Plan downtime.')
        : pass('deallocation-required', 'Migration deallocates the VM for a safe resize (brief downtime).');
    },
  },
];
