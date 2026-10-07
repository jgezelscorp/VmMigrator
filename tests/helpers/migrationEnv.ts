import { SkuService } from '../../src/azure/skus.js';
import { loadCatalog } from '../../src/catalog/index.js';
import { getVm } from '../../src/discovery/discovery.js';
import type { PostCheckResult } from '../../src/domain/types.js';
import { MigrationEngine, MigrationService, MemoryJobStore, type JobStore, type MigrationDeps } from '../../src/migration/index.js';
import { FakeArm } from '../../src/mock/fakeArm.js';
import { createDemoFakeArm } from '../../src/mock/fleet.js';
import { runPreChecks } from '../../src/prechecks/index.js';

export const catalog = loadCatalog();

export function vmIdOf(arm: FakeArm, name: string): string {
  const vm = arm.getVm(name);
  if (!vm) throw new Error(`no fake VM ${name}`);
  return vm.id as string;
}

export interface Env {
  arm: FakeArm;
  store: JobStore;
  engine: MigrationEngine;
  service: MigrationService;
  deps: MigrationDeps;
}

export function makeEnv(
  opts: { arm?: FakeArm; store?: JobStore; postCheck?: MigrationDeps['postCheck']; concurrency?: number } = {},
): Env {
  const arm = opts.arm ?? createDemoFakeArm();
  const store = opts.store ?? new MemoryJobStore();
  const skus = new SkuService(arm);
  const deps: MigrationDeps = {
    arm,
    store,
    getVm: (id) => getVm(arm, catalog, id),
    preCheck: (vm, targetSku) => runPreChecks({ arm, skus, catalog }, vm, targetSku ? { targetSku } : {}),
    ...(opts.postCheck ? { postCheck: opts.postCheck } : {}),
    sleep: async () => undefined,
    pollIntervalMs: 1,
    provisionTimeoutMs: 20,
  };
  const engine = new MigrationEngine(deps);
  const service = new MigrationService(engine, { concurrency: opts.concurrency ?? 1 });
  return { arm, store, engine, service, deps };
}

export const passingPostCheck =
  (): MigrationDeps['postCheck'] =>
  async (job): Promise<PostCheckResult> => ({
    vmId: job.plan.vmId,
    overall: 'PASS',
    checks: [{ checkId: 'ok', status: 'PASS', message: 'ok' }],
    ranAt: new Date().toISOString(),
  });
