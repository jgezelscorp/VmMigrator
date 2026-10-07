import path from 'node:path';
import { AzureCliCredentialProvider } from '../azure/credential.js';
import { HttpArmClient, type ArmClient } from '../azure/arm.js';
import { SkuService } from '../azure/skus.js';
import { findDataDir, loadCatalog, type Catalog } from '../catalog/index.js';
import { discoverVms, getVm } from '../discovery/discovery.js';
import type { MigrationStrategy, PreCheckResult, VmInfo } from '../domain/types.js';
import { FileJobStore, MemoryJobStore, MigrationEngine, MigrationService, type JobStore } from '../migration/index.js';
import { createDemoFakeArm } from '../mock/fleet.js';
import { createPostCheckHook } from '../postchecks/index.js';
import { runPreChecks } from '../prechecks/index.js';

export interface AppContext {
  arm: ArmClient;
  skus: SkuService;
  catalog: Catalog;
  store: JobStore;
  engine: MigrationEngine;
  service: MigrationService;
  mock: boolean;
  getVm(vmId: string): Promise<VmInfo>;
  discover(opts: { subscriptionIds?: string[]; retiringOnly?: boolean }): Promise<VmInfo[]>;
  preCheck(vm: VmInfo, targetSku?: string, opts?: { strategy?: MigrationStrategy }): Promise<PreCheckResult>;
}

export interface ContextOptions {
  arm?: ArmClient;
  mock?: boolean;
  jobsDir?: string;
  store?: JobStore;
  concurrency?: number;
  /** Test hook: skip real waiting */
  fast?: boolean;
}

export const isMockEnv = (env: NodeJS.ProcessEnv = process.env): boolean => /^(1|true|yes)$/i.test(env['VMM_MOCK'] ?? '');

export function createContext(opts: ContextOptions = {}): AppContext {
  const mock = opts.mock ?? isMockEnv();
  const catalog = loadCatalog();
  const arm: ArmClient =
    opts.arm ??
    (mock ? createDemoFakeArm({ latencyMs: opts.fast ? 0 : 400 }) : new HttpArmClient({ credential: new AzureCliCredentialProvider() }));
  const skus = new SkuService(arm);
  const jobsDir = opts.jobsDir ?? process.env['VMM_JOBS_DIR'] ?? path.join(process.env['VMM_DATA_DIR'] ?? findDataDir(), 'jobs');
  // Mock jobs refer to an in-memory fake ARM that does not survive a restart, so they are not persisted
  const store = opts.store ?? (mock ? new MemoryJobStore() : new FileJobStore(jobsDir));

  const getVmInfo = (id: string): Promise<VmInfo> => getVm(arm, catalog, id);
  const preCheck = (vm: VmInfo, targetSku?: string, o?: { strategy?: MigrationStrategy }): Promise<PreCheckResult> =>
    runPreChecks({ arm, skus, catalog }, vm, { ...(targetSku ? { targetSku } : {}), ...(o?.strategy ? { strategy: o.strategy } : {}) });
  const engine = new MigrationEngine({
    arm,
    store,
    getVm: getVmInfo,
    preCheck,
    postCheck: createPostCheckHook({
      arm,
      getVm: getVmInfo,
      ...(opts.fast || mock ? { agentWaitMs: 100, agentPollMs: 50 } : {}),
    }),
    ...(opts.fast ? { sleep: async () => undefined, pollIntervalMs: 1, provisionTimeoutMs: 50 } : mock ? { pollIntervalMs: 200 } : {}),
  });
  const service = new MigrationService(engine, { concurrency: opts.concurrency ?? 2 });
  return {
    arm,
    skus,
    catalog,
    store,
    engine,
    service,
    mock,
    getVm: getVmInfo,
    discover: (o) => discoverVms(arm, skus, catalog, { ...(o.subscriptionIds?.length ? { subscriptionIds: o.subscriptionIds } : {}), ...(o.retiringOnly ? { retiringOnly: true } : {}) }),
    preCheck,
  };
}
