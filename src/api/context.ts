import path from 'node:path';
import { SkuAdvisor, RetailPriceProvider, type PriceProvider, type SkuAdvice } from '../advisor/index.js';
import { DocsPerfProvider, type PerfProvider } from '../advisor/perf.js';
import { AzureCliCredentialProvider } from '../azure/credential.js';
import { HttpArmClient, type ArmClient } from '../azure/arm.js';
import { SkuService } from '../azure/skus.js';
import { findDataDir, loadCatalog, type Catalog } from '../catalog/index.js';
import { discoverVms, getVm } from '../discovery/discovery.js';
import type { MigrationStrategy, PreCheckResult, VmInfo } from '../domain/types.js';
import { FileJobStore, MigrationEngine, MigrationService, type JobStore } from '../migration/index.js';
import { createPostCheckHook } from '../postchecks/index.js';
import { runPreChecks } from '../prechecks/index.js';
import { SettingsStore } from '../settings/index.js';

export interface AppContext {
  arm: ArmClient;
  skus: SkuService;
  catalog: Catalog;
  settings: SettingsStore;
  store: JobStore;
  engine: MigrationEngine;
  service: MigrationService;
  getVm(vmId: string): Promise<VmInfo>;
  advise(vms: VmInfo[]): Promise<SkuAdvice[]>;
  discover(opts: { subscriptionIds?: string[]; retiringOnly?: boolean }): Promise<VmInfo[]>;
  preCheck(vm: VmInfo, targetSku?: string, opts?: { strategy?: MigrationStrategy }): Promise<PreCheckResult>;
}

export interface ContextOptions {
  arm?: ArmClient;
  jobsDir?: string;
  settingsFile?: string;
  /** Where editable pricing settings persist; omit for in-memory defaults */

  store?: JobStore;
  concurrency?: number;
  prices?: PriceProvider;
  perf?: PerfProvider;
  /** Test hook: skip real waiting */
  fast?: boolean;
}

export function createContext(opts: ContextOptions = {}): AppContext {
  const catalog = loadCatalog();
  const arm: ArmClient = opts.arm ?? new HttpArmClient({ credential: new AzureCliCredentialProvider() });
  const skus = new SkuService(arm);
  const settingsFile = opts.settingsFile ?? (process.env['VMM_SETTINGS_FILE'] || (opts.arm ? undefined : path.join(process.env['VMM_DATA_DIR'] ?? findDataDir(), 'settings.json')));
  const settings = new SettingsStore(catalog, settingsFile);
  const jobsDir = opts.jobsDir ?? process.env['VMM_JOBS_DIR'] ?? path.join(process.env['VMM_DATA_DIR'] ?? findDataDir(), 'jobs');
  const store = opts.store ?? new FileJobStore(jobsDir);

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
      ...(opts.fast ? { agentWaitMs: 100, agentPollMs: 50 } : {}),
    }),
    ...(opts.fast ? { sleep: async () => undefined, pollIntervalMs: 1, provisionTimeoutMs: 50 } : {}),
  });
  const advisor = new SkuAdvisor({ arm, skus, catalog, prices: opts.prices ?? new RetailPriceProvider(), perf: opts.perf ?? (opts.prices ? undefined : new DocsPerfProvider()) });
  const service = new MigrationService(engine, { concurrency: opts.concurrency ?? 2 });
  return {
    arm,
    skus,
    catalog,
    settings,
    store,
    engine,
    service,
    getVm: getVmInfo,
    advise: (vms) => advisor.advise(vms),
    discover: (o) => discoverVms(arm, skus, catalog, { ...(o.subscriptionIds?.length ? { subscriptionIds: o.subscriptionIds } : {}), ...(o.retiringOnly ? { retiringOnly: true } : {}) }),
    preCheck,
  };
}
