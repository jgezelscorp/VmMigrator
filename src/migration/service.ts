import type { MigrationJob } from '../domain/types.js';
import { InvalidJobStateError, isTerminal, MigrationRefusedError, type CreateJobInput, type MigrationEngine } from './engine.js';

export interface MigrationServiceOptions {
  /** Max VMs migrated at the same time (default 1 = serial) */
  concurrency?: number;
  onError?: (jobId: string, error: unknown) => void;
}

/** Runs jobs in the background with bounded concurrency and one VM per availability set at a time. */
export class MigrationService {
  private readonly queue: MigrationJob[] = [];
  private readonly running = new Set<string>();
  private readonly busyKeys = new Set<string>();
  private idleWaiters: (() => void)[] = [];
  private readonly concurrency: number;

  constructor(
    readonly engine: MigrationEngine,
    private readonly opts: MigrationServiceOptions = {},
  ) {
    this.concurrency = Math.max(1, opts.concurrency ?? 1);
  }

  /**
   * Plans every VM first (all-or-nothing: one BLOCK refuses the whole request), then persists the jobs and, unless
   * dry-run, queues them for execution.
   */
  async start(inputs: CreateJobInput[]): Promise<MigrationJob[]> {
    const refusals: string[] = [];
    const planned: MigrationJob[] = [];
    for (const input of inputs) {
      try {
        planned.push(await this.engine.plan(input));
      } catch (e) {
        if (e instanceof MigrationRefusedError) refusals.push(e.message);
        else throw e;
      }
    }
    if (refusals.length) throw new MigrationRefusedError(refusals.join(' | '));
    for (const job of planned) {
      this.engine.persist(job);
      if (!job.plan.dryRun) this.enqueue(job);
    }
    return planned;
  }

  /** Re-queues interrupted jobs (after a restart); steps are idempotent so they continue where they stopped. */
  resumeIncomplete(): MigrationJob[] {
    const jobs = this.engine.list().filter((j) => !j.plan.dryRun && !isTerminal(j.state) && !this.running.has(j.id) && !this.queue.some((q) => q.id === j.id));
    jobs.forEach((j) => this.enqueue(j));
    return jobs;
  }

  isBusy(id: string): boolean {
    return this.running.has(id) || this.queue.some((j) => j.id === id);
  }

  async rollback(id: string, reason?: string): Promise<MigrationJob> {
    if (this.isBusy(id)) throw new InvalidJobStateError('The migration is still running; wait for it to finish before rolling back');
    this.running.add(id);
    try {
      return await this.engine.rollback(id, reason);
    } finally {
      this.running.delete(id);
    }
  }

  whenIdle(): Promise<void> {
    if (!this.running.size && !this.queue.length) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  private enqueue(job: MigrationJob): void {
    this.queue.push(job);
    this.pump();
  }

  private pump(): void {
    for (const job of [...this.queue]) {
      if (this.running.size >= this.concurrency) break;
      const key = job.plan.availabilitySetId?.toLowerCase();
      if (key && this.busyKeys.has(key)) continue;
      this.queue.splice(this.queue.indexOf(job), 1);
      this.running.add(job.id);
      if (key) this.busyKeys.add(key);
      void this.engine
        .run(job.id)
        .catch((e) => this.opts.onError?.(job.id, e))
        .finally(() => {
          this.running.delete(job.id);
          if (key) this.busyKeys.delete(key);
          this.pump();
          if (!this.running.size && !this.queue.length) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }
}
