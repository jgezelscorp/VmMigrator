import { randomUUID } from 'node:crypto';
import type { ArmClient } from '../azure/arm.js';
import { COMPUTE_API } from '../discovery/discovery.js';
import type {
  DiskControllerType,
  JobEvent,
  MigrationJob,
  MigrationJobOptions,
  MigrationState,
  MigrationStep,
  PostCheckResult,
  PreCheckResult,
  VmInfo,
} from '../domain/types.js';
import { buildPlan, DISK_API, snapshotBody, snapshotPath, snapshotTargets, updateBody } from './plan.js';
import type { JobStore } from './store.js';

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
  preCheck(vm: VmInfo, targetSku?: string): Promise<PreCheckResult>;
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
    const pre = await this.deps.preCheck(vm, input.targetSku);
    if (pre.overall === 'BLOCK' || !pre.targetSku) {
      const blockers = pre.checks.filter((c) => c.status === 'BLOCK').map((c) => `${c.checkId}: ${c.message}`);
      throw new MigrationRefusedError(`Pre-checks block the migration of ${vm.name}: ${blockers.join('; ') || 'no viable target'}`, pre);
    }
    const options = input.options ?? {};
    const dryRun = input.dryRun === true;
    if (!dryRun && !withinWindow(options, this.now())) {
      throw new MigrationRefusedError(`Current time is outside the maintenance window for ${vm.name}`);
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
    this.event(job, 'info', dryRun ? 'Validated' : undefined, dryRun ? 'Dry run: no changes were made' : `Queued ${vm.vmSize} -> ${pre.targetSku}`);
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
      for (const step of STEP_ORDER) {
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
        const pre = await this.deps.preCheck(vm, plan.targetSku);
        if (pre.overall === 'BLOCK') {
          const blockers = pre.checks.filter((c) => c.status === 'BLOCK').map((c) => `${c.checkId}: ${c.message}`);
          throw new MigrationRefusedError(`Pre-flight re-check blocks the migration: ${blockers.join('; ')}`, pre);
        }
        job.plan.preCheck = pre;
        job.original ??= { vmSize: vm.vmSize, diskControllerType: vm.diskControllerType ?? 'SCSI', powerState: vm.powerState };
        this.event(job, 'info', step, `Pre-flight re-check ${pre.overall}`);
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
        if (job.options?.cleanupSnapshots && job.postCheck?.overall !== 'FAIL') await this.deleteSnapshots(job);
        return;
      }
    }
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
