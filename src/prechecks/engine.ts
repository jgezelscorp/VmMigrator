import type { ArmClient } from '../azure/arm.js';
import type { SkuInfo, SkuService } from '../azure/skus.js';
import { buildCandidateTargets, parseVcpuFromSize, type Catalog } from '../catalog/index.js';
import { COMPUTE_API } from '../discovery/discovery.js';
import type { CheckResult, CheckStatus, PreCheckResult, VmInfo } from '../domain/types.js';
import { PRE_CHECKS, requiredController, targetGenerationOf } from './checks.js';
import type { BackupState, PreCheck, PreCheckContext, ResourceLock } from './types.js';

export interface PreCheckDeps {
  arm: ArmClient;
  skus: SkuService;
  catalog: Catalog;
  /** Extra or replacement checks (pluggable) */
  checks?: PreCheck[];
  now?: () => Date;
}

export interface PreCheckOptions {
  /** Explicit target; when omitted the best viable candidate is selected automatically */
  targetSku?: string;
  includeOptionalTargets?: boolean;
  preferVendor?: 'AMD' | 'Intel';
  /** Max candidates evaluated in auto mode */
  maxCandidates?: number;
}

const RANK: Record<CheckStatus, number> = { PASS: 0, WARN: 1, BLOCK: 2 };
export const worstStatus = (checks: CheckResult[]): CheckStatus =>
  checks.reduce<CheckStatus>((w, c) => (RANK[c.status] > RANK[w] ? c.status : w), 'PASS');

interface VmFacts {
  usages?: PreCheckContext['usages'];
  locks?: ResourceLock[];
  backup?: BackupState;
  availabilitySetVms?: PreCheckContext['availabilitySetVms'];
  imageControllers?: string[];
  loadErrors: Record<string, string>;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function loadFacts(deps: PreCheckDeps, vm: VmInfo): Promise<VmFacts> {
  const { arm, skus } = deps;
  const facts: VmFacts = { loadErrors: {} };
  const attempt = async (key: string, fn: () => Promise<void>): Promise<void> => {
    try {
      await fn();
    } catch (e) {
      facts.loadErrors[key] = errText(e);
    }
  };

  await Promise.all([
    attempt('usages', async () => void (facts.usages = await skus.getUsages(vm.subscriptionId, vm.location))),
    attempt('locks', async () => {
      const all = await arm.list<{ name: string; id: string; properties: { level: ResourceLock['level'] } }>(
        `/subscriptions/${vm.subscriptionId}/providers/Microsoft.Authorization/locks?api-version=2016-09-01`,
      );
      const vmId = vm.id.toLowerCase();
      facts.locks = all
        .map((l) => ({ name: l.name, level: l.properties.level, scope: l.id.split('/providers/Microsoft.Authorization/locks/')[0] ?? '' }))
        .filter((l) => vmId === l.scope.toLowerCase() || vmId.startsWith(`${l.scope.toLowerCase()}/`));
    }),
    attempt('backup', async () => {
      const res = await arm.send<{ data?: { lastRecoveryPoint?: string; protectionState?: string }[] }>(
        'POST',
        '/providers/Microsoft.ResourceGraph/resources?api-version=2022-10-01',
        {
          subscriptions: [vm.subscriptionId],
          options: { resultFormat: 'objectArray' },
          query: `RecoveryServicesResources | where type =~ 'microsoft.recoveryservices/vaults/backupfabrics/protectioncontainers/protecteditems' | where tolower(tostring(properties.sourceResourceId)) == '${vm.id.toLowerCase()}' | project lastRecoveryPoint = tostring(properties.lastRecoveryPoint), protectionState = tostring(properties.protectionState)`,
        },
      );
      const item = res?.data?.[0];
      facts.backup = item
        ? { protected: true, ...(item.lastRecoveryPoint ? { lastRecoveryPoint: item.lastRecoveryPoint } : {}), ...(item.protectionState ? { protectionState: item.protectionState } : {}) }
        : { protected: false };
    }),
    attempt('availabilitySet', async () => {
      if (!vm.availabilitySetId) return;
      const avs = await arm.get<{ properties?: { virtualMachines?: { id: string }[] } }>(`${vm.availabilitySetId}?api-version=${COMPUTE_API}`);
      facts.availabilitySetVms = (avs.properties?.virtualMachines ?? []).map((v) => ({ id: v.id, name: v.id.split('/').pop() ?? v.id }));
    }),
    attempt('image', async () => {
      const img = vm.imageReference;
      if (!img?.publisher || !img.offer || !img.sku || !img.version || img.version === 'latest') return;
      const res = await arm.get<{ properties?: { features?: { name: string; value: string }[] } }>(
        `/subscriptions/${vm.subscriptionId}/providers/Microsoft.Compute/locations/${vm.location}/publishers/${img.publisher}/artifacttypes/vmimage/offers/${img.offer}/skus/${img.sku}/versions/${img.version}?api-version=${COMPUTE_API}`,
      );
      const feature = res.properties?.features?.find((f) => f.name === 'DiskControllerTypes');
      if (feature) facts.imageControllers = feature.value.split(',').map((s) => s.trim());
    }),
  ]);
  return facts;
}

/** Best-effort ranked target names for a VM: its discovered candidates, else rebuilt from the catalog. */
function candidateSkus(deps: PreCheckDeps, vm: VmInfo, source: SkuInfo | undefined, opts: PreCheckOptions): string[] {
  const optional = opts.includeOptionalTargets || vm.hyperVGeneration === 'V1';
  const series = vm.retiringSeries;
  if (series) {
    const vcpu = source?.vcpus || parseVcpuFromSize(vm.vmSize);
    const built = buildCandidateTargets(deps.catalog, series, {
      ...(vcpu ? { vcpu } : {}),
      ...(source?.memoryGb ? { memoryGb: source.memoryGb } : {}),
      osType: vm.osType,
      includeOptional: optional,
      ...(opts.preferVendor ? { preferVendor: opts.preferVendor } : {}),
    });
    if (built.length) return built.map((c) => c.sku);
  }
  return (vm.candidateTargets ?? []).filter((c) => optional || !c.optional).map((c) => c.sku);
}

async function evaluate(deps: PreCheckDeps, ctx: PreCheckContext): Promise<CheckResult[]> {
  const checks = deps.checks ?? PRE_CHECKS;
  const out: CheckResult[] = [];
  for (const c of checks) {
    try {
      out.push(await c.run(ctx));
    } catch (e) {
      out.push({ checkId: c.id, status: 'WARN', message: `Check failed to run: ${errText(e)}` });
    }
  }
  return out;
}

/** Read-only: runs all checks for one VM and one target (explicit or auto-selected). Never mutates Azure. */
export async function runPreChecks(deps: PreCheckDeps, vm: VmInfo, opts: PreCheckOptions = {}): Promise<PreCheckResult> {
  const now = deps.now?.() ?? new Date();
  const facts = await loadFacts(deps, vm);
  let allSkus: SkuInfo[] = [];
  try {
    allSkus = await deps.skus.getSkus(vm.subscriptionId, vm.location);
  } catch (e) {
    facts.loadErrors['skus'] = errText(e);
  }
  const find = (name: string): SkuInfo | undefined => allSkus.find((s) => s.name.toLowerCase() === name.toLowerCase());
  const source = find(vm.vmSize);

  const contextFor = (targetSku: string): PreCheckContext => {
    const target = find(targetSku);
    return {
      vm,
      targetSku,
      ...(target ? { target } : {}),
      ...(source ? { source } : {}),
      targetGeneration: targetGenerationOf(targetSku),
      ...(facts.usages ? { usages: facts.usages } : {}),
      ...(facts.locks ? { locks: facts.locks } : {}),
      ...(facts.backup ? { backup: facts.backup } : {}),
      ...(facts.imageControllers ? { imageControllers: facts.imageControllers } : {}),
      ...(facts.availabilitySetVms ? { availabilitySetVms: facts.availabilitySetVms } : {}),
      loadErrors: facts.loadErrors,
      now,
    };
  };

  const build = (ctx: PreCheckContext, checks: CheckResult[], extra: Partial<PreCheckResult>): PreCheckResult => ({
    vmId: vm.id,
    targetSku: ctx.targetSku,
    sourceSku: vm.vmSize,
    overall: worstStatus(checks),
    checks,
    ranAt: now.toISOString(),
    ...(ctx.target ? { targetDiskController: requiredController(vm, ctx.target).controller } : {}),
    ...extra,
  });

  if (opts.targetSku) {
    const ctx = contextFor(opts.targetSku);
    return build(ctx, await evaluate(deps, ctx), { targetSelection: 'explicit' });
  }

  const names = candidateSkus(deps, vm, source, opts);
  const evaluated: { sku: string; overall: CheckStatus }[] = [];
  let best: { ctx: PreCheckContext; checks: CheckResult[] } | undefined;
  let firstExisting: typeof best;
  for (const sku of names.slice(0, opts.maxCandidates ?? 20)) {
    const ctx = contextFor(sku);
    if (!ctx.target && facts.loadErrors['skus'] === undefined) {
      evaluated.push({ sku, overall: 'BLOCK' });
      continue;
    }
    const checks = await evaluate(deps, ctx);
    const overall = worstStatus(checks);
    evaluated.push({ sku, overall });
    firstExisting ??= { ctx, checks };
    if (overall !== 'BLOCK') {
      best = { ctx, checks };
      break;
    }
  }

  const chosen = best ?? firstExisting;
  if (!chosen) {
    const message = names.length
      ? `None of the candidate targets (${names.slice(0, 20).join(', ')}) exist in ${vm.location} for this subscription.`
      : `No migration target is defined for ${vm.vmSize}.`;
    const checks: CheckResult[] = [
      { checkId: 'target-selection', status: 'BLOCK', message, remediation: 'Specify a target size explicitly or extend data/sku-mapping.json.' },
    ];
    return {
      vmId: vm.id,
      targetSku: '',
      sourceSku: vm.vmSize,
      overall: 'BLOCK',
      checks,
      ranAt: now.toISOString(),
      targetSelection: 'auto',
      candidatesEvaluated: evaluated,
    };
  }
  return build(chosen.ctx, chosen.checks, { targetSelection: 'auto', candidatesEvaluated: evaluated });
}

/** Human-readable summary of a pre-check result. */
export function formatPreCheckReport(vm: Pick<VmInfo, 'name'>, r: PreCheckResult): string {
  const icon: Record<CheckStatus, string> = { PASS: 'PASS ', WARN: 'WARN ', BLOCK: 'BLOCK' };
  const lines = [`${vm.name}: ${r.sourceSku ?? '?'} -> ${r.targetSku || '(none)'}  [${r.overall}]`];
  for (const c of r.checks) {
    lines.push(`  ${icon[c.status]} ${c.checkId}: ${c.message}`);
    if (c.status !== 'PASS' && c.remediation) lines.push(`        fix: ${c.remediation}`);
  }
  return lines.join('\n');
}
