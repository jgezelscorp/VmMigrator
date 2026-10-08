import type { ArmClient } from '../azure/arm.js';
import type { SkuInfo, SkuService, UsageInfo } from '../azure/skus.js';
import { buildCandidateTargets, parseVcpuFromSize, type Catalog } from '../catalog/index.js';
import type { VmInfo } from '../domain/types.js';

/** Announced regional VM price increases (percent), keyed by ARM region name. */
export const REGIONAL_UPLIFT_PCT: Readonly<Record<string, number>> = {
  northeurope: 17,
  francecentral: 11,
  francesouth: 11,
  westeurope: 9,
  norwayeast: 9,
  norwaywest: 9,
  southeastasia: 8,
};

/** VM lifecycle increase (percent), effective 1 Feb 2027, for the retiring older families (global). */
export const LIFECYCLE_UPLIFT_PCT = 25;

export type UpliftKind = 'lifecycle' | 'regional' | 'none';

/** Older VM families covered by the lifecycle increase, or undefined for current families. */
export function lifecycleFamily(size: string): string | undefined {
  const m = /^Standard_([A-Za-z]+?)\d+(?:-\d+)?([a-z]*)(?:_([A-Za-z0-9]+))?/i.exec(size);
  if (!m) return undefined;
  const letters = m[1]!.toUpperCase();
  const sfx = (m[2] ?? '').toLowerCase();
  const ver = (m[3] ?? '').toLowerCase();
  if (!ver) {
    const plain: Record<string, string> = { B: 'Bv1', D: 'D', DS: 'Ds', F: 'F', G: 'G', GS: 'Gs', L: 'L', NP: 'NP', HC: 'HC' };
    if (letters === 'F' && sfx === 's') return 'Fs';
    return plain[letters];
  }
  if (ver !== 'v2') return undefined;
  if (letters === 'A') return sfx === 'm' ? 'Amv2' : sfx === '' ? 'Av2' : undefined;
  if (letters === 'D' && sfx === '') return 'Dv2';
  if (letters === 'DS' && sfx === '') return 'Dsv2';
  if (letters === 'F' && sfx === 's') return 'Fsv2';
  if (letters === 'L' && sfx === 's') return 'Lsv2';
  return undefined;
}

/** Intel v7 families excluded from the regional increase. */
export function regionalExcludedFamily(size: string): string | undefined {
  const m = /^Standard_(D|E)\d+(?:-\d+)?(s|ds|ls|lds)_v7$/i.exec(size);
  if (!m) return undefined;
  const fam = `${m[1]!.toUpperCase()}${m[2]!.toLowerCase()}v7`;
  return ['Dsv7', 'Ddsv7', 'Dlsv7', 'Dldsv7', 'Esv7', 'Edsv7'].find((f) => f === fam);
}

/** Lifecycle +25% wins and is never stacked with the regional uplift; selected Intel v7 families skip the regional uplift. */
export function priceUplift(size: string, region: string): { pct: number; kind: UpliftKind } {
  if (lifecycleFamily(size)) return { pct: LIFECYCLE_UPLIFT_PCT, kind: 'lifecycle' };
  if (regionalExcludedFamily(size)) return { pct: 0, kind: 'none' };
  const r = REGIONAL_UPLIFT_PCT[region.toLowerCase()];
  return r ? { pct: r, kind: 'regional' } : { pct: 0, kind: 'none' };
}

const HOURS_PER_MONTH = 730;

export interface PriceProvider {
  /** Pay-as-you-go list price per hour in USD, or undefined when unavailable */
  hourlyPrice(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<number | undefined>;
}

interface RetailItem {
  retailPrice: number;
  productName?: string;
  skuName?: string;
  meterName?: string;
}

/** Public Azure Retail Prices API (no authentication). */
export class RetailPriceProvider implements PriceProvider {
  private readonly cache = new Map<string, Promise<number | undefined>>();
  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  hourlyPrice(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<number | undefined> {
    const key = `${region}/${sku}/${os}`.toLowerCase();
    let p = this.cache.get(key);
    if (!p) {
      p = this.fetchPrice(region, sku, os).catch(() => undefined);
      this.cache.set(key, p);
    }
    return p;
  }

  private async fetchPrice(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<number | undefined> {
    const filter = `serviceName eq 'Virtual Machines' and priceType eq 'Consumption' and armRegionName eq '${region}' and armSkuName eq '${sku}'`;
    const res = await this.fetchImpl(`https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`);
    if (!res.ok) return undefined;
    const items = ((await res.json()) as { Items?: RetailItem[] }).Items ?? [];
    const matches = items.filter((i) => {
      const text = `${i.skuName ?? ''} ${i.meterName ?? ''}`;
      if (/spot|low priority/i.test(text) || i.retailPrice <= 0) return false;
      const windows = /windows/i.test(i.productName ?? '');
      return os === 'Windows' ? windows : !windows;
    });
    return matches.length ? Math.min(...matches.map((m) => m.retailPrice)) : undefined;
  }
}

export interface SkuSpec {
  name: string;
  family: string;
  vcpus: number;
  memoryGb: number;
  tempDiskMB: number;
  maxDataDisks?: number;
  generations: string[];
  diskControllers: string[];
  acceleratedNetworking: boolean;
  premiumIO: boolean;
}

export interface ReservationMatch {
  name: string;
  sku: string;
  quantity?: number;
  expiry?: string;
  match: 'exact' | 'series';
}

export interface SkuAdvice {
  vmId: string;
  vmName: string;
  location: string;
  osType: 'Windows' | 'Linux';
  current?: SkuSpec;
  proposed?: SkuSpec;
  hasIssues: boolean;
  alternatives: string[];
  quota: { status: 'ok' | 'insufficient' | 'unknown'; message: string };
  zones: { status: 'ok' | 'constrained' | 'unknown'; vmZones: string[]; offeredZones: string[]; message: string };
  cost: {
    status: 'ok' | 'unavailable';
    currentHourly?: number;
    proposedHourly?: number;
    currentMonthly?: number;
    proposedMonthly?: number;
    deltaPct?: number;
    currentUpliftPct: number;
    proposedUpliftPct: number;
    currentUpliftKind: UpliftKind;
    proposedUpliftKind: UpliftKind;
    currentMonthlyWithUplift?: number;
    proposedMonthlyWithUplift?: number;
    deltaPctWithUplift?: number;
    message: string;
  };
  reservation: { status: 'found' | 'none' | 'unknown'; matches: ReservationMatch[]; advice: string };
  notes: string[];
}

interface RawReservation {
  name?: string;
  location?: string;
  sku?: { name?: string };
  properties?: { reservedResourceType?: string; quantity?: number; expiryDate?: string; displayProvisioningState?: string; provisioningState?: string };
}

export interface AdvisorDeps {
  arm: ArmClient;
  skus: SkuService;
  catalog: Catalog;
  prices: PriceProvider;
}

const spec = (s: SkuInfo): SkuSpec => ({
  name: s.name,
  family: s.family,
  vcpus: s.vcpus,
  memoryGb: s.memoryGb,
  tempDiskMB: s.maxResourceVolumeMB,
  ...(s.maxDataDisks !== undefined ? { maxDataDisks: s.maxDataDisks } : {}),
  generations: s.generations,
  diskControllers: s.diskControllers,
  acceleratedNetworking: s.acceleratedNetworking,
  premiumIO: s.premiumIO,
});

/** "Standard_D2s_v3" -> "ds_v3" */
function seriesKey(size: string): string {
  const m = /^Standard_([A-Za-z]+)\d+(?:-\d+)?(.*)$/i.exec(size);
  return m ? `${m[1]}${m[2]}`.toLowerCase() : size.toLowerCase();
}

const round = (n: number, d = 2): number => Math.round(n * 10 ** d) / 10 ** d;

interface Evaluated {
  sku: SkuInfo;
  quota: SkuAdvice['quota'];
  zones: SkuAdvice['zones'];
  compatible: boolean;
  compatNote?: string;
}

function evalQuota(vm: VmInfo, source: SkuInfo | undefined, target: SkuInfo, usages: UsageInfo[] | undefined): SkuAdvice['quota'] {
  if (!usages) return { status: 'unknown', message: 'Could not read compute usages; verify vCPU quota in the portal.' };
  const find = (n: string): UsageInfo | undefined => usages.find((u) => u.name.toLowerCase() === n.toLowerCase());
  const family = find(target.family);
  const regional = find('cores');
  const sameFamily = !!source?.family && source.family === target.family;
  const needFamily = sameFamily ? Math.max(0, target.vcpus - (source?.vcpus ?? 0)) : target.vcpus;
  const needRegional = Math.max(0, target.vcpus - (source?.vcpus ?? 0));
  if (!family) return { status: 'unknown', message: `No usage entry for family ${target.family}; family quota is unverified.` };
  const free = family.limit - family.currentValue;
  if (free < needFamily) {
    return { status: 'insufficient', message: `Family ${target.family}: ${free} free vCPUs (limit ${family.limit}), ${needFamily} needed in ${vm.location}.` };
  }
  if (regional && regional.limit - regional.currentValue < needRegional) {
    return { status: 'insufficient', message: `Regional vCPU quota: ${regional.limit - regional.currentValue} free, ${needRegional} more needed in ${vm.location}.` };
  }
  return { status: 'ok', message: `Family ${target.family}: ${free} of ${family.limit} vCPUs free (need ${needFamily}).` };
}

function evalZones(vm: VmInfo, target: SkuInfo): SkuAdvice['zones'] {
  const base = { vmZones: vm.zones, offeredZones: target.zones };
  const loc = target.restrictions.find((r) => r.type === 'Location');
  if (loc) return { status: 'constrained', ...base, message: `${target.name} is restricted in ${vm.location} (${loc.reasonCode ?? 'restricted'}).` };
  if (vm.zones.length) {
    const zone = vm.zones[0] as string;
    const zr = target.restrictions.find((r) => r.type === 'Zone' && r.zones?.includes(zone));
    if (zr) return { status: 'constrained', ...base, message: `${target.name} is restricted in zone ${zone} (${zr.reasonCode ?? 'restricted'}).` };
    if (!target.zones.includes(zone)) {
      return { status: 'constrained', ...base, message: `${target.name} is not offered in zone ${zone} of ${vm.location} (offered: ${target.zones.join(', ') || 'none'}).` };
    }
    return { status: 'ok', ...base, message: `${target.name} is available in zone ${zone}.` };
  }
  const zoneRestricted = target.restrictions.filter((r) => r.type === 'Zone').flatMap((r) => r.zones ?? []);
  return {
    status: 'ok',
    ...base,
    message: target.zones.length
      ? `VM is not zonal; ${target.name} is offered in zones ${target.zones.join(', ')}${zoneRestricted.length ? ` (restricted in ${zoneRestricted.join(', ')})` : ''}.`
      : `VM is not zonal; ${target.name} is available in ${vm.location}.`,
  };
}

export class SkuAdvisor {
  constructor(private readonly deps: AdvisorDeps) {}

  async advise(vms: VmInfo[]): Promise<SkuAdvice[]> {
    const reservations = await this.loadReservations();
    const out: SkuAdvice[] = [];
    for (const vm of vms) out.push(await this.adviseOne(vm, reservations));
    return out;
  }

  private async loadReservations(): Promise<RawReservation[] | undefined> {
    try {
      return await this.deps.arm.list<RawReservation>('/providers/Microsoft.Capacity/reservations?api-version=2022-11-01');
    } catch {
      return undefined;
    }
  }

  private candidateNames(vm: VmInfo, source: SkuInfo | undefined): string[] {
    const optional = vm.hyperVGeneration === 'V1' || (vm.osType === 'Windows' && (source?.maxResourceVolumeMB ?? 0) > 0);
    if (vm.retiringSeries) {
      const vcpu = source?.vcpus || parseVcpuFromSize(vm.vmSize);
      const built = buildCandidateTargets(this.deps.catalog, vm.retiringSeries, {
        ...(vcpu ? { vcpu } : {}),
        ...(source?.memoryGb ? { memoryGb: source.memoryGb } : {}),
        osType: vm.osType,
        includeOptional: optional,
      });
      if (built.length) return built.map((c) => c.sku);
    }
    return (vm.candidateTargets ?? []).filter((c) => optional || !c.optional).map((c) => c.sku);
  }

  private async adviseOne(vm: VmInfo, reservations: RawReservation[] | undefined): Promise<SkuAdvice> {
    const { skus } = this.deps;
    const [all, usages] = await Promise.all([
      skus.getSkus(vm.subscriptionId, vm.location).catch(() => [] as SkuInfo[]),
      skus.getUsages(vm.subscriptionId, vm.location).catch(() => undefined),
    ]);
    const find = (n: string): SkuInfo | undefined => all.find((s) => s.name.toLowerCase() === n.toLowerCase());
    const source = find(vm.vmSize);
    const names = this.candidateNames(vm, source);
    const gen = vm.hyperVGeneration ?? 'V1';
    const ctrl = vm.diskControllerType ?? 'SCSI';

    const evaluated: Evaluated[] = [];
    for (const n of names) {
      const sku = find(n);
      if (!sku) continue;
      const genOk = sku.generations.length === 0 || sku.generations.includes(gen);
      const ctrlOk = sku.diskControllers.includes(ctrl);
      evaluated.push({
        sku,
        quota: evalQuota(vm, source, sku, usages),
        zones: evalZones(vm, sku),
        compatible: genOk && ctrlOk,
        ...(!genOk ? { compatNote: `${sku.name} does not support Hyper-V generation ${gen}.` } : !ctrlOk ? { compatNote: `${sku.name} does not support the ${ctrl} disk controller.` } : {}),
      });
    }
    const clean = (e: Evaluated): boolean => e.compatible && e.quota.status !== 'insufficient' && e.zones.status !== 'constrained';
    const chosen = evaluated.find(clean) ?? evaluated.find((e) => e.compatible) ?? evaluated[0];

    const notes: string[] = [];
    if (!names.length) notes.push('No migration targets are defined for this size (it is not in a retiring series).');
    else if (!chosen) notes.push(`None of the candidate targets (${names.slice(0, 8).join(', ')}) exist in ${vm.location} for this subscription.`);
    if (chosen?.compatNote) notes.push(chosen.compatNote);
    if (chosen && !clean(chosen)) notes.push('No candidate passed every check; the best-effort proposal has open issues.');

    const cost = chosen
      ? await this.cost(vm, vm.vmSize, chosen.sku.name)
      : ({
          status: 'unavailable',
          currentUpliftPct: 0,
          proposedUpliftPct: 0,
          currentUpliftKind: 'none',
          proposedUpliftKind: 'none',
          message: 'No proposed SKU, so no cost comparison.',
        } as SkuAdvice['cost']);

    return {
      vmId: vm.id,
      vmName: vm.name,
      location: vm.location,
      osType: vm.osType,
      ...(source ? { current: spec(source) } : {}),
      ...(chosen ? { proposed: spec(chosen.sku) } : {}),
      hasIssues: !!chosen && !clean(chosen),
      alternatives: evaluated.filter((e) => e !== chosen).map((e) => e.sku.name),
      quota: chosen?.quota ?? { status: 'unknown', message: 'No proposed SKU.' },
      zones: chosen?.zones ?? { status: 'unknown', vmZones: vm.zones, offeredZones: [], message: 'No proposed SKU.' },
      cost,
      reservation: this.reservationAdvice(vm, chosen?.sku.name, reservations),
      notes,
    };
  }

  private async cost(vm: VmInfo, from: string,   to: string): Promise<SkuAdvice['cost']> {
    const { prices } = this.deps;
    const [cur, next] = await Promise.all([prices.hourlyPrice(vm.location, from, vm.osType), prices.hourlyPrice(vm.location, to, vm.osType)]);
      const cu = priceUplift(from, vm.location);
      const pu = priceUplift(to, vm.location);
      const describe = (size: string, u: { pct: number; kind: UpliftKind }): string =>
        u.kind === 'lifecycle'
          ? `${size}: VM lifecycle +${u.pct}% (global, replaces any regional increase)`
          : u.kind === 'regional'
            ? `${size}: regional +${u.pct}% (${vm.location})`
            : regionalExcludedFamily(size) && REGIONAL_UPLIFT_PCT[vm.location.toLowerCase()]
              ? `${size}: excluded from the ${vm.location} regional increase (${regionalExcludedFamily(size)})`
              : `${size}: no announced increase`;
      const upliftNote = `Effective 1 Feb 2027 - ${describe(from, cu)}; ${describe(to, pu)}.`;
      const common = { currentUpliftPct: cu.pct, proposedUpliftPct: pu.pct, currentUpliftKind: cu.kind, proposedUpliftKind: pu.kind };
      if (cur === undefined || next === undefined) {
        return {
          status: 'unavailable',
          ...common,
        ...(cur !== undefined ? { currentHourly: cur, currentMonthly: round(cur * HOURS_PER_MONTH) } : {}),
        ...(next !== undefined ? { proposedHourly: next, proposedMonthly: round(next * HOURS_PER_MONTH) } : {}),
        message: `List price unavailable for ${cur === undefined ? from : to} (${vm.osType}, ${vm.location}); cost impact could not be computed. ${upliftNote}`,
      };
    }
    const curM = cur * HOURS_PER_MONTH;
    const nextM = next * HOURS_PER_MONTH;
    const curU = curM * (1 + cu.pct / 100);
    const nextU = nextM * (1 + pu.pct / 100);
    return {
      status: 'ok',
      currentHourly: cur,
      proposedHourly: next,
      currentMonthly: round(curM),
      proposedMonthly: round(nextM),
      deltaPct: round(((next - cur) / cur) * 100, 1),
      ...common,
      currentMonthlyWithUplift: round(curU),
      proposedMonthlyWithUplift: round(nextU),
      deltaPctWithUplift: round(((nextU - curU) / curU) * 100, 1),
      message: `Pay-as-you-go list prices (USD, ${vm.osType}, 730 h/month). ${upliftNote}`,
    };
  }

  private reservationAdvice(vm: VmInfo, proposed: string | undefined, reservations: RawReservation[] | undefined): SkuAdvice['reservation'] {
    if (!reservations) {
      return {
        status: 'unknown',
        matches: [],
        advice: 'Reservations could not be read (missing Reservation Reader permission?). Check Cost Management > Reservations for a reservation covering this size before migrating.',
      };
    }
    const loc = vm.location.toLowerCase();
    const key = seriesKey(vm.vmSize);
    const matches: ReservationMatch[] = [];
    for (const r of reservations) {
      const p = r.properties ?? {};
      const sku = r.sku?.name;
      if (!sku || (p.reservedResourceType && p.reservedResourceType !== 'VirtualMachines')) continue;
      if (/expired|cancel|fail/i.test(p.displayProvisioningState ?? p.provisioningState ?? '')) continue;
      if (r.location && r.location.toLowerCase().replace(/\s/g, '') !== loc) continue;
      const exact = sku.toLowerCase() === vm.vmSize.toLowerCase();
      if (!exact && seriesKey(sku) !== key) continue;
      matches.push({
        name: r.name ?? sku,
        sku,
        ...(p.quantity !== undefined ? { quantity: p.quantity } : {}),
        ...(p.expiryDate ? { expiry: p.expiryDate } : {}),
        match: exact ? 'exact' : 'series',
      });
    }
    const target = proposed ?? 'the new size';
    const fam = lifecycleFamily(vm.vmSize);
    const riNote = fam
      ? ` Note: since 1 Jul 2026 new purchases and renewals of Reserved VM Instances are no longer available for older series such as ${fam}, so this reservation cannot be renewed.`
      : '';
    if (!matches.length) {
      return {
        status: 'none',
        matches,
        advice: `No reservation covering ${vm.vmSize} found.${riNote} If ${target} will run steadily, evaluate a 1- or 3-year reservation or an Azure savings plan for compute.`,
      };
    }
    return {
      status: 'found',
      matches,
      advice: `${vm.vmSize} is covered by a reservation. A reservation for the ${seriesKey(vm.vmSize)} series does not discount ${target} (different instance size flexibility group), so after migration the VM bills pay-as-you-go while the reservation sits unused. Options: (1) check in the Azure portal whether the reservation can be exchanged or refunded for ${target} [verify current exchange policy]; (2) let it cover other VMs of the same series; (3) buy a reservation or savings plan for ${target}. Time the migration against the reservation expiry.${riNote}`,
    };
  }
}
