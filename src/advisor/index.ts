import type { ArmClient } from '../azure/arm.js';
import type { SkuInfo, SkuService, UsageInfo } from '../azure/skus.js';
import { buildCandidateTargets, parseVcpuFromSize, type Catalog } from '../catalog/index.js';
import type { VmInfo } from '../domain/types.js';
import type { PerfProvider, SizePerf } from './perf.js';
import { processorFor } from './processor.js';

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

/** Runtime pricing inputs (editable on the Settings page); defaults mirror the announced values. */
let regionalUplift: Record<string, number> = { ...REGIONAL_UPLIFT_PCT };
let seriesUplift: Record<string, number> = {};
const FAMILY_TO_SERIES: Record<string, string> = { D: 'Dv1', Ds: 'Dsv1', F: 'Fv1', Fs: 'Fsv1', G: 'Gv1', Gs: 'Gsv1', L: 'Ls' };

/** Customer-specific discounts applied on top of retail list prices (0 = list pricing). */
let paygoDiscountPct = 0;
let reservationDiscountPct = 0;
const discounted = (h: number, pct: number): number => h * (1 - pct / 100);

export function applyPricingSettings(s: {
  regions: { name: string; upliftPct: number }[];
  series: { id: string; upliftPct: number }[];
  customerPricing?: { paygoDiscountPct: number; reservationDiscountPct: number };
}): void {
  paygoDiscountPct = s.customerPricing?.paygoDiscountPct ?? 0;
  reservationDiscountPct = s.customerPricing?.reservationDiscountPct ?? 0;
  regionalUplift = Object.fromEntries(s.regions.map((r) => [r.name.toLowerCase(), r.upliftPct]));
  seriesUplift = Object.fromEntries(s.series.map((r) => [r.id, r.upliftPct]));
}

export function regionalPct(region: string): number | undefined {
  return regionalUplift[region.toLowerCase()];
}

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
  const r = regionalPct(region);
  return r ? { pct: r, kind: 'regional' } : { pct: 0, kind: 'none' };
}

const HOURS_PER_MONTH = 730;

export interface PriceProvider {
  /** Pay-as-you-go list price per hour in USD, or undefined when unavailable */
  hourlyPrice(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<number | undefined>;
  /** Effective hourly price with a 1- or 3-year reservation (Windows includes the license at PAYGO rate), when available */
  reservationHourly?(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<{ oneYear?: number; threeYear?: number }>;
}

interface RetailItem {
  reservationTerm?: string;
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

  reservationHourly(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<{ oneYear?: number; threeYear?: number }> {
    const key = `ri/${region}/${sku}/${os}`.toLowerCase();
    let p = this.riCache.get(key);
    if (!p) {
      p = this.fetchReservation(region, sku, os).catch(() => ({}));
      this.riCache.set(key, p);
      void p.then((r) => {
        if (r.oneYear === undefined && r.threeYear === undefined) this.riCache.delete(key);
      });
    }
    return p;
  }

  private readonly riCache = new Map<string, Promise<{ oneYear?: number; threeYear?: number }>>();

  private async fetchReservation(region: string, sku: string, os: 'Windows' | 'Linux'): Promise<{ oneYear?: number; threeYear?: number }> {
    const filter = `serviceName eq 'Virtual Machines' and priceType eq 'Reservation' and armRegionName eq '${region}' and armSkuName eq '${sku}'`;
    const items: RetailItem[] = [];
    let url: string | undefined = `https://prices.azure.com/api/retail/prices?$filter=${encodeURIComponent(filter)}`;
    for (let page = 0; url && page < 5; page++) {
      const res = await this.fetchImpl(url);
      if (!res.ok) throw new Error(`Retail Prices API ${res.status}`);
      const body = (await res.json()) as { Items?: RetailItem[]; NextPageLink?: string | null };
      items.push(...(body.Items ?? []));
      url = body.NextPageLink ?? undefined;
    }
    const term = (t: string, months: number): number | undefined => {
      const v = items.filter((i) => i.reservationTerm === t && i.retailPrice > 0).map((i) => i.retailPrice / (months * HOURS_PER_MONTH));
      return v.length ? Math.min(...v) : undefined;
    };
    const one = term('1 Year', 12);
    const three = term('3 Years', 36);
    let license = 0;
    if (os === 'Windows') {
      const [win, lin] = await Promise.all([this.hourlyPrice(region, sku, 'Windows'), this.hourlyPrice(region, sku, 'Linux')]);
      // Reservation shows the compute price; the Windows license is added only when both PAYGO lookups succeed.
      if (win !== undefined && lin !== undefined) license = Math.max(0, win - lin);
    }
    return {
      ...(one !== undefined ? { oneYear: one + license } : {}),
      ...(three !== undefined ? { threeYear: three + license } : {}),
    };
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
  processor?: string;
  perfIndex?: number;
  uncachedIops?: number;
  uncachedMBps?: number;
  cachedIops?: number;
  maxNics?: number;
  cpuArchitecture?: string;
  focus?: string;
  burstIops?: number;
  burstMBps?: number;
  networkMbps?: number;
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
    currentRegionalImpact?: string;
    proposedRegionalImpact?: string;
    currentMonthlyWithUplift?: number;
    proposedMonthlyWithUplift?: number;
    currentOneYearMonthly?: number;
    currentThreeYearMonthly?: number;
    proposedOneYearMonthly?: number;
    proposedThreeYearMonthly?: number;
    deltaPctWithUplift?: number;
    message: string;
  };
  reservation: { status: 'found' | 'none' | 'unknown'; matches: ReservationMatch[]; proposedMatches: ReservationMatch[]; currentLine: string; proposedLine: string; remarks: string; advice: string };
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
  perf?: PerfProvider;
}

const spec = (s: SkuInfo, perf?: SizePerf): SkuSpec => ({
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
  ...(processorFor(s.name) ?? {}),
  ...(s.uncachedIops !== undefined ? { uncachedIops: s.uncachedIops } : {}),
  ...(s.uncachedBytesPerSec !== undefined ? { uncachedMBps: Math.round(s.uncachedBytesPerSec / 1e6) } : {}),
  ...(s.cachedIops !== undefined ? { cachedIops: s.cachedIops } : {}),
  ...(s.maxNics !== undefined ? { maxNics: s.maxNics } : {}),
  ...(s.cpuArchitecture ? { cpuArchitecture: s.cpuArchitecture } : {}),
  ...(perf ?? {}),
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

export interface ExposureRow {
  vmId: string;
  name: string;
  subscriptionId: string;
  location: string;
  size: string;
  osType: 'Windows' | 'Linux';
  /** lifecycle = older-generation repricing, regional = regional VM pricing, excluded = in a region with an increase but exempt, none = no announced increase */
  rule: 'lifecycle' | 'regional' | 'excluded' | 'none';
  upliftPct: number;
  sovereign: boolean;
  priced: boolean;
  paygoMonthly: number;
  reservedMonthly: number | undefined;
  purchase: 'reserved' | 'payg' | 'unknown';
  reservationExpiry?: string;
  exemptFamily?: string;
  /** Proposed v7 target (retiring VMs only) used for the 36-month projection. */
  targetSku?: string;
  targetPaygMonthly?: number;
  targetUpliftPct?: number;
  targetRiMonthly?: number;
}

/** Discount percentages currently applied to list prices. */
export function customerDiscounts(): { paygoDiscountPct: number; reservationDiscountPct: number } {
  return { paygoDiscountPct, reservationDiscountPct };
}

export class SkuAdvisor {
  constructor(private readonly deps: AdvisorDeps) {}

  /** Per-VM raw inputs for the estate exposure analysis (aggregation happens in the UI). */
  async exposure(vms: VmInfo[]): Promise<ExposureRow[]> {
    const reservations = await this.loadReservations();
    const out: ExposureRow[] = [];
    for (const vm of vms) {
      const sovereign = /^(usgov|usdod|usnat|ussec|china|germany(central|northeast))/i.test(vm.location);
      const up = sovereign ? { pct: 0, kind: 'none' as UpliftKind } : priceUplift(vm.vmSize, vm.location);
      const hourly = await this.deps.prices.hourlyPrice(vm.location, vm.vmSize, vm.osType).catch(() => undefined);
      const resv = this.reservationAdvice(vm, undefined, reservations);
      const ri = this.deps.prices.reservationHourly ? await this.deps.prices.reservationHourly(vm.location, vm.vmSize, vm.osType).catch(() => undefined) : undefined;
      const riHourly = ri?.oneYear ?? ri?.threeYear;
      const covered = resv.matches.length > 0;
      const exemptFamily = regionalExcludedFamily(vm.vmSize);
      let target: Pick<ExposureRow, 'targetSku' | 'targetPaygMonthly' | 'targetUpliftPct' | 'targetRiMonthly'> = {};
      if (up.kind === 'lifecycle') {
        try {
          const adv = await this.adviseOne(vm, reservations);
          const c = adv.cost;
          if (adv.proposed && c?.proposedMonthly !== undefined) {
            target = {
              targetSku: adv.proposed.name,
              targetPaygMonthly: c.proposedMonthly,
              targetUpliftPct: c.proposedUpliftPct ?? 0,
              ...(c.proposedOneYearMonthly !== undefined ? { targetRiMonthly: c.proposedOneYearMonthly } : {}),
            };
          }
        } catch { /* target pricing is best-effort */ }
      }
      out.push({
        ...target,
        vmId: vm.id,
        name: vm.name,
        subscriptionId: vm.subscriptionId,
        location: vm.location,
        size: vm.vmSize,
        osType: vm.osType,
        rule: up.kind === 'none' ? (exemptFamily && regionalPct(vm.location) && !sovereign ? 'excluded' : 'none') : up.kind,
        upliftPct: up.pct,
        sovereign,
        priced: hourly !== undefined,
        paygoMonthly: hourly === undefined ? 0 : round(discounted(hourly, paygoDiscountPct) * HOURS_PER_MONTH),
        reservedMonthly: covered && riHourly !== undefined ? round(discounted(riHourly, reservationDiscountPct) * HOURS_PER_MONTH) : undefined,
        purchase: !reservations ? 'unknown' : covered ? 'reserved' : 'payg',
        ...(resv.matches[0]?.expiry ? { reservationExpiry: resv.matches[0].expiry } : {}),
        ...(exemptFamily ? { exemptFamily } : {}),
      });
    }
    return out;
  }

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

  private candidateNames(vm: VmInfo, source: SkuInfo | undefined, vcpuOverride?: number): string[] {
    const optional = vm.hyperVGeneration === 'V1' || (vm.osType === 'Windows' && (source?.maxResourceVolumeMB ?? 0) > 0);
    if (vm.retiringSeries) {
      const vcpu = vcpuOverride ?? (source?.vcpus || parseVcpuFromSize(vm.vmSize));
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
    let names = this.candidateNames(vm, source);
    // v6/v7 have no 1-vCPU sizes; fall back to the 2-vCPU equivalents.
    let bumped = false;
    if (names.length && !names.some(find) && (source?.vcpus || parseVcpuFromSize(vm.vmSize)) === 1) {
      const up = this.candidateNames(vm, source, 2);
      if (up.some(find)) {
        names = up;
        bumped = true;
      }
    }
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
    const pool = evaluated.some(clean) ? evaluated.filter(clean) : evaluated.some((e) => e.compatible) ? evaluated.filter((e) => e.compatible) : evaluated;
    const chosen = await this.cheapestOfTopGeneration(vm, pool);
    if (chosen) evaluated.splice(0, evaluated.length, chosen, ...evaluated.filter((e) => e !== chosen));

    const notes: string[] = [];
    if (!names.length) notes.push('No migration targets are defined for this size (it is not in a retiring series).');
    else if (!chosen) notes.push(`None of the candidate targets (${names.slice(0, 8).join(', ')}) exist in ${vm.location} for this subscription.`);
    if (bumped && chosen) notes.push('No 1-vCPU size exists in the v6/v7 series; proposing the 2-vCPU equivalent.');
    if (chosen && regionalPct(vm.location)) {
      const fam = regionalExcludedFamily(chosen.sku.name);
      if (fam) notes.push(`${chosen.sku.name} (${fam}) is not impacted by the ${vm.location} regional price increase.`);
      else notes.push(`No v7 size exempt from the ${vm.location} regional price increase was available for this VM; ${chosen.sku.name} carries the regional increase.`);
    }
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

    const [curPerf, newPerf] = await Promise.all([
      source ? this.deps.perf?.get(source.name).catch(() => undefined) : undefined,
      chosen ? this.deps.perf?.get(chosen.sku.name).catch(() => undefined) : undefined,
    ]);

    return {
      vmId: vm.id,
      vmName: vm.name,
      location: vm.location,
      osType: vm.osType,
      ...(source ? { current: spec(source, curPerf) } : {}),
      ...(chosen ? { proposed: spec(chosen.sku, newPerf) } : {}),
      hasIssues: !!chosen && !clean(chosen),
      alternatives: evaluated.filter((e) => e !== chosen).map((e) => e.sku.name),
      quota: chosen?.quota ?? { status: 'unknown', message: 'No proposed SKU.' },
      zones: chosen?.zones ?? { status: 'unknown', vmZones: vm.zones, offeredZones: [], message: 'No proposed SKU.' },
      cost,
      reservation: this.reservationAdvice(vm, chosen?.sku.name, reservations),
      notes,
    };
  }

  /** Among the newest-generation candidates, pick the lowest price from 1 Feb 2027 (uplifts included); ties and missing prices keep catalog order. */
  private async cheapestOfTopGeneration(vm: VmInfo, pool: Evaluated[]): Promise<Evaluated | undefined> {
    if (pool.length < 2) return pool[0];
    const gen = (e: Evaluated): number => Number(/_v(\d+)$/i.exec(e.sku.name)?.[1] ?? 0);
    const top = Math.max(...pool.map(gen));
    const tier = pool.filter((e) => gen(e) === top);
    if (tier.length < 2) return tier[0];
    // In a region with a regional increase, prefer v7 families that are exempt from it.
    const exempt = regionalPct(vm.location) ? tier.filter((e) => regionalExcludedFamily(e.sku.name)) : [];
    const candidates = exempt.length ? exempt : tier;
    const priced = await Promise.all(
      candidates.map(async (e) => {
        const hourly = await this.deps.prices.hourlyPrice(vm.location, e.sku.name, vm.osType).catch(() => undefined);
        return { e, price: hourly === undefined ? Infinity : hourly * (1 + priceUplift(e.sku.name, vm.location).pct / 100) };
      }),
    );
    let best = priced[0]!;
    for (const p of priced) if (p.price < best.price - 1e-9) best = p;
    return best.e;
  }

  private async cost(vm: VmInfo, from: string,   to: string): Promise<SkuAdvice['cost']> {
    const { prices } = this.deps;
    const [listCur, listNext] = await Promise.all([prices.hourlyPrice(vm.location, from, vm.osType), prices.hourlyPrice(vm.location, to, vm.osType)]);
    const cur = listCur === undefined ? undefined : discounted(listCur, paygoDiscountPct);
    const next = listNext === undefined ? undefined : discounted(listNext, paygoDiscountPct);
      const cu = priceUplift(from, vm.location);
      const pu = priceUplift(to, vm.location);
      const describe = (size: string, u: { pct: number; kind: UpliftKind }): string =>
        u.kind === 'lifecycle'
          ? `${size}: VM lifecycle +${u.pct}% (global, replaces any regional increase)`
          : u.kind === 'regional'
            ? `${size}: regional +${u.pct}% (${vm.location})`
            : regionalExcludedFamily(size) && regionalPct(vm.location)
              ? `${size}: excluded from the ${vm.location} regional increase (${regionalExcludedFamily(size)})`
              : `${size}: no announced increase`;
      const upliftNote = `Effective 1 Feb 2027 - ${describe(from, cu)}; ${describe(to, pu)}.`;
      const regional = (size: string, u: { pct: number; kind: UpliftKind }): string => {
        const r = regionalPct(vm.location);
        if (!r) return `No - ${vm.location} has no regional increase`;
        if (u.kind === 'regional') return `Yes - +${u.pct}% (${vm.location})`;
        if (u.kind === 'lifecycle') return `No - lifecycle +${u.pct}% applies instead (not stacked)`;
        return `No - excluded (${regionalExcludedFamily(size) ?? 'family'})`;
      };
      const common = {
        currentUpliftPct: cu.pct,
        proposedUpliftPct: pu.pct,
        currentUpliftKind: cu.kind,
        proposedUpliftKind: pu.kind,
        currentRegionalImpact: regional(from, cu),
        proposedRegionalImpact: regional(to, pu),
      };
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
    const noRi: { oneYear?: number; threeYear?: number } = {};
    const [listCurRi, listNextRi] = prices.reservationHourly
      ? await Promise.all([
          prices.reservationHourly(vm.location, from, vm.osType).catch(() => noRi),
          prices.reservationHourly(vm.location, to, vm.osType).catch(() => noRi),
        ])
      : [noRi, noRi];
    const disc = (r: { oneYear?: number; threeYear?: number }): { oneYear?: number; threeYear?: number } => ({
      ...(r.oneYear !== undefined ? { oneYear: discounted(r.oneYear, reservationDiscountPct) } : {}),
      ...(r.threeYear !== undefined ? { threeYear: discounted(r.threeYear, reservationDiscountPct) } : {}),
    });
    const curRi = disc(listCurRi);
    const nextRi = disc(listNextRi);
    const mo = (h: number | undefined): number | undefined => (h === undefined ? undefined : round(h * HOURS_PER_MONTH));
    const ri = {
      ...(mo(curRi.oneYear) !== undefined ? { currentOneYearMonthly: mo(curRi.oneYear) } : {}),
      ...(mo(curRi.threeYear) !== undefined ? { currentThreeYearMonthly: mo(curRi.threeYear) } : {}),
      ...(mo(nextRi.oneYear) !== undefined ? { proposedOneYearMonthly: mo(nextRi.oneYear) } : {}),
      ...(mo(nextRi.threeYear) !== undefined ? { proposedThreeYearMonthly: mo(nextRi.threeYear) } : {}),
    };
    return {
      status: 'ok',
      ...ri,
      currentHourly: cur,
      proposedHourly: next,
      currentMonthly: round(curM),
      proposedMonthly: round(nextM),
      deltaPct: round(((next - cur) / cur) * 100, 1),
      ...common,
      currentMonthlyWithUplift: round(curU),
      proposedMonthlyWithUplift: round(nextU),
      deltaPctWithUplift: round(((nextU - curU) / curU) * 100, 1),
      message: `Pay-as-you-go ${paygoDiscountPct || reservationDiscountPct ? `prices after customer discount (PAYGO -${paygoDiscountPct}%, reservations -${reservationDiscountPct}%)` : 'list prices'} (USD, ${vm.osType}, 730 h/month). ${upliftNote}`,
    };
  }

  private reservationAdvice(vm: VmInfo, proposed: string | undefined, reservations: RawReservation[] | undefined): SkuAdvice['reservation'] {
    if (!reservations) {
      return {
        status: 'unknown',
        matches: [],
        proposedMatches: [],
        currentLine: `Reservations covering ${vm.vmSize} could not be checked.`,
        proposedLine: `Reservations covering ${proposed ?? 'the replacement SKU'} could not be checked.`,
        remarks: 'Reading reservations needs Reservation Reader. Check Cost Management > Reservations manually.',
        advice: 'Reservations could not be read (needs Reservation Reader). Check Cost Management > Reservations manually.',
      };
    }
    const loc = vm.location.toLowerCase();
    const find = (size: string): ReservationMatch[] => {
      const key = seriesKey(size);
      const found: ReservationMatch[] = [];
      for (const r of reservations) {
        const p = r.properties ?? {};
        const sku = r.sku?.name;
        if (!sku || (p.reservedResourceType && p.reservedResourceType !== 'VirtualMachines')) continue;
        if (/expired|cancel|fail/i.test(p.displayProvisioningState ?? p.provisioningState ?? '')) continue;
        if (r.location && r.location.toLowerCase().replace(/\s/g, '') !== loc) continue;
        const exact = sku.toLowerCase() === size.toLowerCase();
        if (!exact && seriesKey(sku) !== key) continue;
        found.push({
          name: r.name ?? sku,
          sku,
          ...(p.quantity !== undefined ? { quantity: p.quantity } : {}),
          ...(p.expiryDate ? { expiry: p.expiryDate } : {}),
          match: exact ? 'exact' : 'series',
        });
      }
      return found;
    };
    const matches = find(vm.vmSize);
    const proposedMatches = proposed ? find(proposed) : [];
    const fam = lifecycleFamily(vm.vmSize);
    const noRenew = fam ? ' It cannot be renewed (no new RIs for older series since 1 Jul 2026).' : '';
    const line = (size: string, m: ReservationMatch[]): string =>
      m.length ? `Reservation covering ${size} found in Tenant (${m.length}).` : `No reservation covering ${size} found in Tenant.`;
    const currentLine = line(vm.vmSize, matches);
    const proposedLine = proposed ? line(proposed, proposedMatches) : 'No proposed SKU, so no reservation check.';
    const remarks: string[] = [];
    if (matches.length && noRenew) remarks.push(noRenew.trim());
    if (proposed) {
      if (proposedMatches.length) remarks.push('The reservation on the replacement SKU will be used after migration.');
      else if (matches.length) remarks.push('The current reservation will not discount the replacement; exchange/refund it or reuse it for other VMs of the same series, and buy a new reservation or savings plan for the new size.');
      else remarks.push('Consider a reservation or savings plan if it runs steadily.');
    }
    return {
      status: matches.length || proposedMatches.length ? 'found' : 'none',
      matches,
      proposedMatches,
      currentLine,
      proposedLine,
      remarks: remarks.join(' '),
      advice: [currentLine, proposedLine, ...remarks].join(' '),
    };
  }
}
