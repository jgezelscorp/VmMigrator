import { randomUUID } from 'node:crypto';
import { ArmError, type ArmClient } from '../azure/arm.js';
import { COMPUTE_API, parseResourceId } from '../discovery/discovery.js';
import type {
  DiskControllerType,
  JobEvent,
  MigrationJob,
  MigrationJobOptions,
  MigrationState,
  MigrationStep,
  PostCheckResult,
  PreCheckResult,
  RebuildState,
  VmInfo,
} from '../domain/types.js';
import { buildPlan, DISK_API, snapshotBody, snapshotPath, snapshotTargets, updateBody } from './plan.js';
import {
  detachBody,
  diskPath,
  extensionBodies,
  newDiskBody,
  PAGEFILE_SCRIPT,
  rebuildDiskName,
  recreateVmBody,
  trustedLaunchBody,
  type AttachedDisk,
} from './rebuild.js';
import type { JobStore } from './store.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Raw = any;

export class MigrationRefusedError extends Error {
  constructor(
    message: string,
    readonly preCheck?: PreCheckResult,
  ) {
    super(message);
    this.name = 'MigrationRefusedError';
  }
}

export class JobNotFoundError extends Error {
  constructor(id: string) {
    super(`Migration ${id} not found`);
    this.name = 'JobNotFoundError';
  }
}

export class InvalidJobStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidJobStateError';
  }
}

export interface MigrationDeps {
  arm: ArmClient;
  store: JobStore;
  getVm(vmId: string): Promise<VmInfo>;
  /** Pre-check for a VM; with targetSku set the target is explicit */
  preCheck(vm: VmInfo, targetSku?: string, opts?: { strategy?: 'inPlace' | 'rebuild' }): Promise<PreCheckResult>;
  /** Post-check engine hook (run after the VM is started) */
  postCheck?(job: MigrationJob, vm: VmInfo): Promise<PostCheckResult>;
  sleep?(ms: number): Promise<void>;
  now?(): Date;
  newId?(): string;
  pollIntervalMs?: number;
  /** Max time to wait for a VM to reach the expected power/provisioning state */
  provisionTimeoutMs?: number;
}

export interface CreateJobInput {
  vmId: string;
  targetSku?: string;
  dryRun?: boolean;
  options?: MigrationJobOptions;
}

const STEP_ORDER: MigrationStep[] = ['Validated', 'SnapshotTaken', 'Deallocated', 'Updated', 'Started', 'PostChecked', 'Done'];
const REBUILD_STEP_ORDER: MigrationStep[] = ['Validated', 'Prepared', 'SnapshotTaken', 'Deallocated', 'Rebuilt', 'Started', 'PostChecked', 'Done'];
const stepsOf = (job: MigrationJob): MigrationStep[] => (job.plan.strategy === 'rebuild' ? REBUILD_STEP_ORDER : STEP_ORDER);
const isNotFound = (e: unknown): boolean => e instanceof ArmError && e.status === 404;
const TERMINAL: MigrationState[] = ['Done', 'Failed', 'Restored'];
export const isTerminal = (s: MigrationState): boolean => TERMINAL.includes(s);

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function withinWindow(options: MigrationJobOptions | undefined, now: Date): boolean {
  const w = options?.maintenanceWindow;
  if (!w) return true;
  return now.getTime() >= new Date(w.start).getTime() && now.getTime() <= new Date(w.end).getTime();
}

export class MigrationEngine {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly pollIntervalMs: number;
  private readonly maxPolls: number;

  constructor(private readonly deps: MigrationDeps) {
    this.sleep = deps.sleep ?? ((ms): Promise<void> => new Promise((r) => setTimeout(r, ms)));
    this.now = deps.now ?? ((): Date => new Date());
    this.pollIntervalMs = deps.pollIntervalMs ?? 5000;
    this.maxPolls = Math.max(1, Math.ceil((deps.provisionTimeoutMs ?? 30 * 60_000) / this.pollIntervalMs));
  }

  get(id: string): MigrationJob {
    const job = this.deps.store.load(id);
    if (!job) throw new JobNotFoundError(id);
    return job;
  }

  list(): MigrationJob[] {
    return this.deps.store.list();
  }

  /**
   * Plans a migration (pre-check included) without persisting. Throws MigrationRefusedError for BLOCK pre-checks or
   * when outside the maintenance window. A dry-run job is stored as Done and never writes to Azure.
   */
  async plan(input: CreateJobInput): Promise<MigrationJob> {
    const vm = await this.deps.getVm(input.vmId);
    const wantsRebuild = input.options?.strategy === 'rebuild';
    const pre = await this.deps.preCheck(vm, input.targetSku, wantsRebuild ? { strategy: 'rebuild' } : undefined);
    if (pre.overall === 'BLOCK' || !pre.targetSku) {
      const blockers = pre.checks.filter((c) => c.status === 'BLOCK').map((c) => `${c.checkId}: ${c.message}`);
      const hint = pre.rebuildAvailable && !wantsRebuild ? ' The opt-in "rebuild" strategy can handle this (options.strategy=rebuild, options.confirmRebuild=true).' : '';
      throw new MigrationRefusedError(`Pre-checks block the migration of ${vm.name}: ${blockers.join('; ') || 'no viable target'}${hint}`, pre);
    }
    const options = input.options ?? {};
    const dryRun = input.dryRun === true;
    if (!dryRun && !withinWindow(options, this.now())) {
      throw new MigrationRefusedError(`Current time is outside the maintenance window for ${vm.name}`);
    }
    if (wantsRebuild && pre.rebuildKind && !dryRun) {
      if (options.skipSnapshots) throw new MigrationRefusedError(`The rebuild strategy needs snapshots; skipSnapshots cannot be combined with it (${vm.name})`);
      if (options.confirmRebuild !== true) {
        throw new MigrationRefusedError(`The rebuild strategy deletes and recreates ${vm.name} (downtime); set options.confirmRebuild=true to confirm`);
      }
    }
    const id = (this.deps.newId ?? randomUUID)();
    const at = this.now().toISOString();
    const job: MigrationJob = {
      id,
      plan: buildPlan({ vm, preCheck: pre, jobId: id, dryRun, options }),
      state: dryRun ? 'Done' : 'Queued',
      completedSteps: dryRun ? ['Validated'] : [],
      startedAt: at,
      updatedAt: at,
      vmName: vm.name,
      options,
      events: [],
    };
    this.event(job, 'info', dryRun ? 'Validated' : undefined, dryRun ? 'Dry run: no changes were made' : `Queued ${vm.vmSize} -> ${pre.targetSku}${job.plan.strategy === 'rebuild' ? ` (rebuild: ${job.plan.rebuildKind})` : ''}`);
    if (wantsRebuild && job.plan.strategy !== 'rebuild') {
      this.event(job, 'info', undefined, 'Rebuild was requested but an in-place resize is possible; the in-place strategy is used');
    }
    return job;
  }

  async create(input: CreateJobInput): Promise<MigrationJob> {
    const job = await this.plan(input);
    this.save(job);
    return job;
  }

  persist(job: MigrationJob): void {
    this.save(job);
  }

  /** Executes (or resumes) a job. Migration failures are recorded on the job, not thrown. */
  async run(id: string): Promise<MigrationJob> {
    const job = this.get(id);
    if (job.plan.dryRun || job.state === 'Done' || job.state === 'Restored' || job.state === 'Failed') return job;
    if (job.state === 'RollingBack') return this.rollbackJob(job, job.error ?? 'resumed rollback', 'automatic');

    try {
      for (const step of stepsOf(job)) {
        if (job.completedSteps.includes(step)) continue;
        await this.execute(job, step);
        job.completedSteps.push(step);
        job.state = step;
        this.save(job);
      }
      return job;
    } catch (e) {
      return this.fail(job, e);
    }
  }

  /** Manual rollback to the original size/controller (also valid after a successful migration until sign-off). */
  async rollback(id: string, reason = 'Manual rollback requested'): Promise<MigrationJob> {
    const job = this.get(id);
    if (job.plan.dryRun) throw new InvalidJobStateError('A dry-run job changed nothing; there is nothing to roll back');
    if (!job.original) throw new InvalidJobStateError('The migration has not captured the original VM model yet; nothing to roll back');
    if (job.state === 'Restored') return job;
    return this.rollbackJob(job, reason, 'manual');
  }

  /** Deletes the snapshots taken by a job (optional cleanup after sign-off). */
  async cleanupSnapshots(id: string): Promise<MigrationJob> {
    const job = this.get(id);
    if (!isTerminal(job.state)) throw new InvalidJobStateError(`Job is ${job.state}; clean up snapshots after it finished`);
    await this.deleteSnapshots(job);
    await this.deleteOriginalDisks(job);
    this.save(job);
    return job;
  }

  private async deleteSnapshots(job: MigrationJob): Promise<void> {
    for (const s of job.snapshots ?? []) {
      await this.deps.arm.send('DELETE', `${s.snapshotId}?api-version=${DISK_API}`);
      this.event(job, 'info', 'Cleanup', `Deleted snapshot ${s.snapshotName}`);
    }
    job.snapshotsCleaned = true;
  }

  private async execute(job: MigrationJob, step: MigrationStep): Promise<void> {
    const { arm } = this.deps;
    const plan = job.plan;
    const vmId = plan.vmId;

    switch (step) {
      case 'Validated': {
        const vm = await this.deps.getVm(vmId);
        const pre = await this.deps.preCheck(vm, plan.targetSku, plan.strategy === 'rebuild' ? { strategy: 'rebuild' } : undefined);
        if (pre.overall === 'BLOCK') {
          const blockers = pre.checks.filter((c) => c.status === 'BLOCK').map((c) => `${c.checkId}: ${c.message}`);
          throw new MigrationRefusedError(`Pre-flight re-check blocks the migration: ${blockers.join('; ')}`, pre);
        }
        job.plan.preCheck = pre;
        job.original ??= {
          vmSize: vm.vmSize,
          diskControllerType: vm.diskControllerType ?? 'SCSI',
          powerState: vm.powerState,
          dataDiskLuns: (vm.dataDisks ?? []).map((d) => d.lun ?? 0),
          tags: vm.tags,
          publicIps: (vm.nics ?? []).flatMap((n) => n.publicIps.map((p) => ({ id: p.id, ...(p.allocationMethod ? { allocationMethod: p.allocationMethod } : {}) }))),
          backupProtected: pre.checks.some((c) => c.checkId === 'backup' && c.status === 'PASS'),
        };
        if (plan.strategy === 'rebuild' && plan.rebuildKind && !job.original.rebuild) job.original.rebuild = await this.captureRebuildState(vm, plan.rebuildKind);
        this.event(job, 'info', step, `Pre-flight re-check ${pre.overall}`);
        return;
      }

      case 'Prepared': {
        if (job.plan.rebuildKind !== 'recreate' || job.options?.movePagefile === false) return;
        const vm = await this.deps.getVm(vmId);
        if (vm.osType !== 'Windows') return;
        if (vm.powerState !== 'running') {
          this.event(job, 'info', step, 'VM is not running; pagefile move skipped (Windows recreates the pagefile on C: when D: is missing)');
          return;
        }
        try {
          const res = await arm.send<{ value?: { message?: string }[] } | undefined>('POST', `${vmId}/runCommand?api-version=${COMPUTE_API}`, {
            commandId: 'RunPowerShellScript',
            script: PAGEFILE_SCRIPT,
          });
          const text = (res?.value ?? []).map((v) => v.message ?? '').join('\n');
          const after = /VMM_PAGEFILE_AFTER=(.*)/.exec(text)?.[1]?.trim() ?? '';
          if (job.original?.rebuild) job.original.rebuild.pagefile = after;
          this.event(job, after && !/^[dDeEfF]:/.test(after) ? 'info' : 'warn', step, `Pagefile setting after move: ${after || 'unknown'}`);
        } catch (e) {
          this.event(job, 'warn', step, `Could not move the pagefile (${errText(e)}); continuing, Windows recreates it on C: when D: is missing`);
        }
        return;
      }

      case 'SnapshotTaken': {
        if (job.options?.skipSnapshots) {
          this.event(job, 'warn', step, 'Snapshots skipped by option; rollback relies on the VM model only');
          return;
        }
        const vm = await this.deps.getVm(vmId);
        job.snapshots ??= [];
        for (const t of snapshotTargets(vm, job.id)) {
          if (job.snapshots.some((s) => s.diskId === t.diskId)) continue;
          const path = snapshotPath(vm, t.snapshotName);
          await arm.send('PUT', `${path}?api-version=${DISK_API}`, snapshotBody(vm, t, job.id));
          job.snapshots.push({
            diskId: t.diskId,
            diskName: t.diskName,
            snapshotId: path,
            snapshotName: t.snapshotName,
            role: t.role,
            ...(t.lun !== undefined ? { lun: t.lun } : {}),
          });
          this.save(job);
          this.event(job, 'info', step, `Snapshot ${t.snapshotName} of ${t.diskName} created`);
        }
        if (!job.snapshots.length) this.event(job, 'warn', step, 'No managed disks could be snapshotted');
        return;
      }

      case 'Deallocated': {
        if (!withinWindow(job.options, this.now())) {
          throw new MigrationRefusedError('Maintenance window closed before the VM could be deallocated');
        }
        job.mutated = true;
        this.save(job);
        const vm = await this.deps.getVm(vmId);
        if (vm.powerState === 'deallocated') {
          this.event(job, 'info', step, 'VM already deallocated');
          return;
        }
        await arm.send('POST', `${vmId}/deallocate?api-version=${COMPUTE_API}`);
        await this.waitFor(vmId, 'deallocated');
        this.event(job, 'info', step, 'VM deallocated');
        return;
      }

      case 'Updated': {
        const vm = await this.deps.getVm(vmId);
        const target = plan.targetDiskController ?? vm.diskControllerType ?? 'SCSI';
        if (vm.vmSize.toLowerCase() === plan.targetSku.toLowerCase() && (vm.diskControllerType ?? 'SCSI') === target) {
          this.event(job, 'info', step, 'VM model already has the target size and controller');
          return;
        }
        await arm.send('PATCH', `${vmId}?api-version=${COMPUTE_API}`, updateBody(plan.targetSku, target, vm.diskControllerType));
        this.event(job, 'info', step, `VM updated to ${plan.targetSku} (${target})`);
        return;
      }

      case 'Rebuilt': {
        const rb = job.original?.rebuild;
        if (!rb) throw new Error('Rebuild state was not captured');
        if (rb.kind === 'gen1-upgrade') await this.gen1Upgrade(job, rb);
        else await this.recreate(job, rb);
        return;
      }

      case 'Started': {
        const wasRunning = job.original?.powerState === 'running' || job.original?.powerState === 'starting';
        if (!wasRunning) {
          await this.waitFor(vmId, 'deallocated');
          this.event(job, 'info', step, 'VM was not running before; left deallocated');
          return;
        }
        const vm = await this.deps.getVm(vmId);
        if (vm.powerState !== 'running') await arm.send('POST', `${vmId}/start?api-version=${COMPUTE_API}`);
        await this.waitFor(vmId, 'running');
        this.event(job, 'info', step, 'VM running');
        return;
      }

      case 'PostChecked': {
        if (!this.deps.postCheck) {
          this.event(job, 'warn', step, 'No post-check engine configured');
          return;
        }
        const vm = await this.deps.getVm(vmId);
        const result = await this.deps.postCheck(job, vm);
        job.postCheck = result;
        this.event(job, result.overall === 'FAIL' ? 'error' : 'info', step, `Post-check ${result.overall}${result.recommendation ? `: ${result.recommendation}` : ''}`);
        if (result.overall === 'FAIL' && job.options?.autoRollbackOnPostCheckFail) {
          throw new Error(`Post-check failed: ${result.checks.filter((c) => c.status === 'FAIL').map((c) => c.message).join('; ')}`);
        }
        return;
      }

      case 'Done': {
        if (job.options?.cleanupSnapshots && job.postCheck?.overall !== 'FAIL') {
          await this.deleteSnapshots(job);
          await this.deleteOriginalDisks(job);
        }
        return;
      }
    }
  }

  private async captureRebuildState(vm: VmInfo, kind: RebuildState['kind']): Promise<RebuildState> {
    const { arm } = this.deps;
    const definition = await arm.get<Raw>(`${vm.id}?api-version=${COMPUTE_API}`);
    let extensions: Raw[];
    try {
      extensions = await arm.list<Raw>(`${vm.id}/extensions?api-version=${COMPUTE_API}`);
    } catch {
      extensions = definition.resources ?? [];
    }
    const disks: RebuildState['disks'] = [];
    if (vm.osDisk?.id) disks.push({ role: 'os', originalDiskId: vm.osDisk.id, originalDiskName: vm.osDisk.name });
    for (const d of vm.dataDisks ?? []) {
      if (d.id) disks.push({ role: 'data', lun: d.lun ?? 0, originalDiskId: d.id, originalDiskName: d.name });
    }
    return { kind, definition, extensions, disks };
  }

  /** Gen1 -> Trusted launch (Gen2) upgrade on the deallocated VM, then the size/controller update. */
  private async gen1Upgrade(job: MigrationJob, rb: RebuildState): Promise<void> {
    const { arm } = this.deps;
    const plan = job.plan;
    const vmId = plan.vmId;
    let vm = await this.deps.getVm(vmId);
    if (vm.securityType !== 'TrustedLaunch') {
      rb.upgradeStarted = true;
      this.save(job);
      await arm.send('PATCH', `${vmId}?api-version=${COMPUTE_API}`, trustedLaunchBody);
      this.event(job, 'info', 'Rebuilt', 'VM upgraded to Trusted launch (Generation 2)');
      vm = await this.deps.getVm(vmId);
    }
    const target = plan.targetDiskController ?? vm.diskControllerType ?? 'SCSI';
    if (vm.vmSize.toLowerCase() !== plan.targetSku.toLowerCase() || (vm.diskControllerType ?? 'SCSI') !== target) {
      await arm.send('PATCH', `${vmId}?api-version=${COMPUTE_API}`, updateBody(plan.targetSku, target, vm.diskControllerType));
      this.event(job, 'info', 'Rebuilt', `VM updated to ${plan.targetSku} (${target})`);
    }
  }

  /** Windows temp-disk path: new disks from the snapshots, delete the VM definition, create the VM again. */
  private async recreate(job: MigrationJob, rb: RebuildState): Promise<void> {
    const { arm } = this.deps;
    const plan = job.plan;
    const vmId = plan.vmId;
    const def: Raw = rb.definition;
    const ids = parseResourceId(vmId);
    const location: string = def.location;

    for (const d of rb.disks) {
      if (d.newDiskId) continue;
      const snap = (job.snapshots ?? []).find((s) => s.diskId.toLowerCase() === d.originalDiskId.toLowerCase());
      if (!snap) throw new Error(`No snapshot of ${d.originalDiskName}; the rebuild needs one for every disk`);
      d.snapshotId = snap.snapshotId;
      const name = rebuildDiskName(d.originalDiskName, job.id);
      const path = diskPath(ids.subscriptionId, ids.resourceGroup, name);
      const original = await this.tryGet(d.originalDiskId, DISK_API);
      await arm.send('PUT', `${path}?api-version=${DISK_API}`, newDiskBody({ location, ...(def.zones ? { zones: def.zones } : {}), snapshotId: snap.snapshotId, original, osType: def.properties?.storageProfile?.osDisk?.osType, tags: { sourceVm: ids.name, jobId: job.id } }));
      d.newDiskId = path;
      d.newDiskName = name;
      this.save(job);
      this.event(job, 'info', 'Rebuilt', `Disk ${name} created from snapshot ${snap.snapshotName}`);
    }

    if (!rb.vmDeleted) {
      await this.detachIfNeeded(vmId);
      await arm.send('DELETE', `${vmId}?api-version=${COMPUTE_API}`);
      rb.vmDeleted = true;
      this.save(job);
      this.event(job, 'info', 'Rebuilt', `VM definition ${ids.name} deleted (disks and NICs kept)`);
    }

    if (!rb.vmCreated) {
      const target = plan.targetDiskController ?? 'SCSI';
      await this.createVm(job, rb, plan.targetSku, target, rb.disks.map((d) => ({ role: d.role, ...(d.lun !== undefined ? { lun: d.lun } : {}), id: d.newDiskId ?? '', name: d.newDiskName ?? '' })));
      rb.vmCreated = true;
      this.save(job);
      this.event(job, 'info', 'Rebuilt', `VM ${ids.name} created as ${plan.targetSku} (${target})`);
    }
  }

  /** PUTs the VM from the captured definition, restores extensions and leaves it in its original power state. */
  private async createVm(
    job: MigrationJob,
    rb: RebuildState,
    vmSize: string,
    controller: DiskControllerType,
    disks: { role: 'os' | 'data'; lun?: number; id: string; name: string }[],
  ): Promise<void> {
    const { arm } = this.deps;
    const vmId = job.plan.vmId;
    const def: Raw = rb.definition;
    const os = disks.find((d) => d.role === 'os');
    if (!os) throw new Error('No OS disk to attach');
    const data = new Map<number, AttachedDisk>(disks.filter((d) => d.role === 'data').map((d) => [d.lun ?? 0, { id: d.id, name: d.name }]));
    await arm.send('PUT', `${vmId}?api-version=${COMPUTE_API}`, recreateVmBody({ definition: def, vmSize, controller, os: { id: os.id, name: os.name }, data }));
    for (const ext of extensionBodies(rb.extensions as Raw[], def.location)) {
      try {
        await arm.send('PUT', `${vmId}/extensions/${ext.name}?api-version=${COMPUTE_API}`, ext.body);
        this.event(job, 'info', undefined, `Extension ${ext.name} restored`);
      } catch (e) {
        this.event(job, 'warn', undefined, `Extension ${ext.name} could not be restored (${errText(e)}); reinstall it manually`);
      }
    }
    const wasRunning = job.original?.powerState === 'running' || job.original?.powerState === 'starting';
    if (!wasRunning) {
      await arm.send('POST', `${vmId}/deallocate?api-version=${COMPUTE_API}`);
      await this.waitFor(vmId, 'deallocated');
    }
  }

  private async tryGet(id: string, api: string): Promise<Raw | undefined> {
    try {
      return await this.deps.arm.get<Raw>(`${id}?api-version=${api}`);
    } catch {
      return undefined;
    }
  }

  /** Disks/NICs with deleteOption=Delete would be removed together with the VM definition; flip them first. */
  private async detachIfNeeded(vmId: string): Promise<void> {
    const live = await this.deps.arm.get<Raw>(`${vmId}?api-version=${COMPUTE_API}`);
    const body = detachBody(live);
    if (body) await this.deps.arm.send('PATCH', `${vmId}?api-version=${COMPUTE_API}`, body);
  }

  private async deleteOriginalDisks(job: MigrationJob): Promise<void> {
    const rb = job.original?.rebuild;
    if (!rb || rb.kind !== 'recreate' || rb.originalDisksDeleted || ['Restored', 'Failed', 'RollingBack'].includes(job.state)) return;
    for (const d of rb.disks) {
      await this.deps.arm.send('DELETE', `${d.originalDiskId}?api-version=${DISK_API}`);
      this.event(job, 'info', 'Cleanup', `Deleted original disk ${d.originalDiskName}`);
    }
    rb.originalDisksDeleted = true;
  }

  private async fail(job: MigrationJob, e: unknown): Promise<MigrationJob> {
    job.error = errText(e);
    this.event(job, 'error', undefined, job.error);
    if (job.mutated && job.original) return this.rollbackJob(job, job.error, 'automatic');
    job.state = 'Failed';
    this.save(job);
    return job;
  }

  private async rollbackJob(job: MigrationJob, reason: string, trigger: 'automatic' | 'manual'): Promise<MigrationJob> {
    const { arm } = this.deps;
    const orig = job.original;
    const vmId = job.plan.vmId;
    job.state = 'RollingBack';
    this.event(job, 'warn', 'Rollback', `Rolling back to ${orig?.vmSize} (${orig?.diskControllerType}): ${reason}`);
    this.save(job);
    try {
      if (!orig) throw new Error('original VM model was not captured');
      if (orig.rebuild && (orig.rebuild.vmDeleted || orig.rebuild.upgradeStarted)) {
        await this.rollbackRebuild(job, orig.rebuild);
        job.state = 'Restored';
        delete job.error;
        job.rollback = { reason, at: this.now().toISOString(), trigger, succeeded: true };
        this.event(job, 'info', 'Rollback', 'Rollback complete');
        this.save(job);
        return job;
      }
      const vm = await this.deps.getVm(vmId);
      const ctl: DiskControllerType = vm.diskControllerType ?? 'SCSI';
      if (vm.vmSize.toLowerCase() !== orig.vmSize.toLowerCase() || ctl !== orig.diskControllerType) {
        if (vm.powerState !== 'deallocated') {
          await arm.send('POST', `${vmId}/deallocate?api-version=${COMPUTE_API}`);
          await this.waitFor(vmId, 'deallocated');
        }
        await arm.send('PATCH', `${vmId}?api-version=${COMPUTE_API}`, updateBody(orig.vmSize, orig.diskControllerType, ctl));
        this.event(job, 'info', 'Rollback', `VM model restored to ${orig.vmSize} (${orig.diskControllerType})`);
      }
      if (orig.powerState === 'running' || orig.powerState === 'starting') {
        const cur = await this.deps.getVm(vmId);
        if (cur.powerState !== 'running') await arm.send('POST', `${vmId}/start?api-version=${COMPUTE_API}`);
        await this.waitFor(vmId, 'running');
      }
      job.state = 'Restored';
      job.rollback = { reason, at: this.now().toISOString(), trigger, succeeded: true };
      this.event(job, 'info', 'Rollback', 'Rollback complete');
    } catch (e) {
      job.state = 'Failed';
      job.rollback = { reason, at: this.now().toISOString(), trigger, succeeded: false };
      const snaps = (job.snapshots ?? []).map((s) => s.snapshotId).join(', ');
      job.error = `${job.error ? `${job.error} ` : ''}Rollback failed: ${errText(e)}.${snaps ? ` If the VM model is broken, recreate the VM from the snapshots: ${snaps}.` : ''}`;
      this.event(job, 'error', 'Rollback', job.error);
    }
    this.save(job);
    return job;
  }

  /**
   * Recreates the original VM from the captured definition: on the original disks (recreate) or on fresh disks made
   * from the snapshots (Gen1 upgrade, where the original disks were converted to Gen2).
   */
  private async rollbackRebuild(job: MigrationJob, rb: RebuildState): Promise<void> {
    const { arm } = this.deps;
    const orig = job.original;
    if (!orig) throw new Error('original VM model was not captured');
    const vmId = job.plan.vmId;
    const ids = parseResourceId(vmId);
    const def: Raw = rb.definition;
    const fromSnapshots = rb.kind === 'gen1-upgrade';

    let exists = true;
    try {
      await this.deps.arm.get(`${vmId}?api-version=${COMPUTE_API}`);
    } catch (e) {
      if (!isNotFound(e)) throw e;
      exists = false;
    }
    if (exists) {
      await this.detachIfNeeded(vmId);
      await arm.send('DELETE', `${vmId}?api-version=${COMPUTE_API}`);
      this.event(job, 'info', 'Rollback', `Deleted the ${rb.kind === 'recreate' ? 'rebuilt' : 'upgraded'} VM ${ids.name}`);
    }

    const attach: { role: 'os' | 'data'; lun?: number; id: string; name: string }[] = [];
    for (const d of rb.disks) {
      if (!fromSnapshots) {
        attach.push({ role: d.role, ...(d.lun !== undefined ? { lun: d.lun } : {}), id: d.originalDiskId, name: d.originalDiskName });
        continue;
      }
      const snap = (job.snapshots ?? []).find((s) => s.diskId.toLowerCase() === d.originalDiskId.toLowerCase());
      if (!snap) throw new Error(`No snapshot of ${d.originalDiskName}; the Gen1 VM cannot be recreated`);
      const name = rebuildDiskName(d.originalDiskName, job.id, 'orig');
      const path = diskPath(ids.subscriptionId, ids.resourceGroup, name);
      // hyperVGeneration is not copied, so the disk inherits Gen1 from the snapshot even though the original disk is Gen2 now
      const originalDisk = await this.tryGet(d.originalDiskId, DISK_API);
      await arm.send('PUT', `${path}?api-version=${DISK_API}`, newDiskBody({ location: def.location, ...(def.zones ? { zones: def.zones } : {}), snapshotId: snap.snapshotId, original: originalDisk && (d.role === 'os' ? { ...originalDisk, properties: { ...originalDisk.properties, hyperVGeneration: 'V1' } } : originalDisk), osType: def.properties?.storageProfile?.osDisk?.osType, tags: { sourceVm: ids.name, jobId: job.id } }));
      attach.push({ role: d.role, ...(d.lun !== undefined ? { lun: d.lun } : {}), id: path, name });
      this.event(job, 'info', 'Rollback', `Disk ${name} recreated from snapshot ${snap.snapshotName}`);
    }

    await this.createVm(job, rb, orig.vmSize, orig.diskControllerType, attach);
    if (orig.powerState === 'running' || orig.powerState === 'starting') await this.waitFor(vmId, 'running');
    this.event(job, 'info', 'Rollback', `VM ${ids.name} recreated as ${orig.vmSize} (${orig.diskControllerType}) from ${fromSnapshots ? 'the snapshots' : 'the original disks'}`);

    // Disks that only the rebuilt VM used are no longer needed
    for (const d of rb.disks) {
      for (const id of [d.newDiskId, fromSnapshots ? d.originalDiskId : undefined]) {
        if (!id) continue;
        try {
          await arm.send('DELETE', `${id}?api-version=${DISK_API}`);
        } catch (e) {
          this.event(job, 'warn', 'Rollback', `Could not delete leftover disk ${id.split('/').pop()}: ${errText(e)}`);
        }
      }
    }
    rb.vmDeleted = false;
    rb.vmCreated = false;
    rb.upgradeStarted = false;
  }

  /** Polls until provisioning succeeded and the power state matches. */
  private async waitFor(vmId: string, power: 'running' | 'deallocated'): Promise<VmInfo> {
    let last = '';
    for (let i = 0; i < this.maxPolls; i++) {
      const vm = await this.deps.getVm(vmId);
      if (vm.provisioningState === 'Failed') throw new Error('VM provisioning failed');
      last = `${vm.provisioningState ?? '?'}/${vm.powerState}`;
      if ((vm.provisioningState === undefined || vm.provisioningState === 'Succeeded') && vm.powerState === power) return vm;
      await this.sleep(this.pollIntervalMs);
    }
    throw new Error(`Timed out waiting for the VM to become ${power} (last seen ${last})`);
  }

  private event(job: MigrationJob, level: JobEvent['level'], step: JobEvent['step'], message: string): void {
    (job.events ??= []).push({ at: this.now().toISOString(), level, ...(step ? { step } : {}), message });
  }

  private save(job: MigrationJob): void {
    job.updatedAt = this.now().toISOString();
    this.deps.store.save(job);
  }
}
