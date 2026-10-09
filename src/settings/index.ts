import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { applyPricingSettings, LIFECYCLE_UPLIFT_PCT, REGIONAL_UPLIFT_PCT } from '../advisor/index.js';
import type { Catalog } from '../catalog/index.js';

export interface SeriesSetting {
  id: string;
  retirementDate: string;
  upliftPct: number;
}
export interface RegionSetting {
  name: string;
  upliftPct: number;
}
export interface PricingSettings {
  version: 1;
  /** Date the announced price changes take effect (informational). */
  effectiveDate: string;
  series: SeriesSetting[];
  regions: RegionSetting[];
  /** Customer-specific discount vs. retail list price (0 = list pricing). Optional in stored files. */
  customerPricing: { paygoDiscountPct: number; reservationDiscountPct: number };
}

/** Series that receive the global lifecycle increase by default. */
const LIFECYCLE_SERIES = new Set(['Dv1', 'Dsv1', 'Dv2', 'Dsv2', 'Ls', 'Amv2', 'Av2', 'Bv1', 'Fv1', 'Fsv1', 'Fsv2', 'Gv1', 'Gsv1', 'Lsv2', 'NP', 'HC']);

export function defaultSettings(catalog: Catalog): PricingSettings {
  return {
    version: 1,
    effectiveDate: '2027-02-01',
    series: catalog.retirement.series.map((s) => ({
      id: s.id,
      retirementDate: s.retirementDate,
      upliftPct: LIFECYCLE_SERIES.has(s.id) ? LIFECYCLE_UPLIFT_PCT : 0,
    })),
    regions: Object.entries(REGIONAL_UPLIFT_PCT).map(([name, upliftPct]) => ({ name, upliftPct })),
    customerPricing: { paygoDiscountPct: 0, reservationDiscountPct: 0 },
  };
}

export class SettingsError extends Error {}

const pct = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 500) throw new SettingsError(`${what} must be a number between 0 and 500`);
  return v;
};

export function validateSettings(input: unknown): PricingSettings {
  const o = input as Partial<PricingSettings> | undefined;
  if (!o || typeof o !== 'object') throw new SettingsError('settings must be an object');
  const effectiveDate = String(o.effectiveDate ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new SettingsError('effectiveDate must be YYYY-MM-DD');
  if (!Array.isArray(o.series) || !Array.isArray(o.regions)) throw new SettingsError('series and regions must be arrays');
  const seen = new Set<string>();
  const series = o.series.map((s) => {
    const id = String(s?.id ?? '').trim();
    if (!id) throw new SettingsError('series id is required');
    if (seen.has(id)) throw new SettingsError(`duplicate series ${id}`);
    seen.add(id);
    const retirementDate = String(s.retirementDate ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(retirementDate)) throw new SettingsError(`series ${id}: retirementDate must be YYYY-MM-DD`);
    return { id, retirementDate, upliftPct: pct(s.upliftPct, `series ${id} uplift`) };
  });
  const seenR = new Set<string>();
  const regions = o.regions.map((r) => {
    const name = String(r?.name ?? '').trim().toLowerCase().replace(/\s+/g, '');
    if (!name) throw new SettingsError('region name is required');
    if (seenR.has(name)) throw new SettingsError(`duplicate region ${name}`);
    seenR.add(name);
    return { name, upliftPct: pct(r.upliftPct, `region ${name} uplift`) };
  });
  const cp = (o as { customerPricing?: Partial<PricingSettings['customerPricing']> }).customerPricing ?? {};
  const disc = (v: unknown, what: string): number => {
    const n = v ?? 0;
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 100) throw new SettingsError(`${what} must be a number between 0 and 100`);
    return n;
  };
  const customerPricing = { paygoDiscountPct: disc(cp.paygoDiscountPct, 'PAYGO discount'), reservationDiscountPct: disc(cp.reservationDiscountPct, 'reservation discount') };
  return { version: 1, effectiveDate, series, regions, customerPricing };
}

/** File-backed settings that feed the catalog (retirement dates) and the advisor (uplift percentages). */
export class SettingsStore {
  private current: PricingSettings;
  private readonly defaults: PricingSettings;

  constructor(private readonly catalog: Catalog, private readonly file?: string) {
    this.defaults = defaultSettings(catalog);
    this.current = this.defaults;
    if (file && existsSync(file)) {
      try {
        this.current = validateSettings(JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')));
      } catch {
        this.current = this.defaults;
      }
    }
    this.apply();
  }

  get(): PricingSettings {
    return this.current;
  }

  getDefaults(): PricingSettings {
    return this.defaults;
  }

  set(input: unknown): PricingSettings {
    this.current = validateSettings(input);
    if (this.file) {
      mkdirSync(path.dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.current, null, 2));
    }
    this.apply();
    return this.current;
  }

  reset(): PricingSettings {
    return this.set(this.defaults);
  }

  private apply(): void {
    for (const s of this.catalog.retirement.series) {
      const o = this.current.series.find((x) => x.id === s.id);
      if (o) s.retirementDate = o.retirementDate;
    }
    applyPricingSettings(this.current);
  }
}
