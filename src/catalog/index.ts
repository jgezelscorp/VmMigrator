import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TargetCandidate } from '../domain/types.js';

export interface RetirementSeries {
  id: string;
  pattern: string;
  retirementDate: string;
  note?: string;
}

export interface RetirementCatalog {
  version: number;
  series: RetirementSeries[];
}

export interface TargetTemplate {
  template: string;
  generation: number;
  vendor: 'AMD' | 'Intel';
  tempDisk: boolean;
  memoryGbPerVcpu: number;
  optional?: boolean;
}

export interface SkuMapping {
  version: number;
  groups: Record<string, TargetTemplate[]>;
  series: Record<string, string>;
}

export interface Catalog {
  retirement: RetirementCatalog;
  mapping: SkuMapping;
}

export interface SeriesMatch {
  series: string;
  retirementDate: string;
  note?: string;
}

export interface CandidateOptions {
  vcpu?: number;
  memoryGb?: number;
  osType: 'Windows' | 'Linux';
  /** Include optional (v5) fallbacks, e.g. for Gen1 sources */
  includeOptional?: boolean;
  /** Prefer AMD targets (default) or Intel */
  preferVendor?: 'AMD' | 'Intel';
}

export function findDataDir(start: string = path.dirname(fileURLToPath(import.meta.url))): string {
  const fromEnv = process.env['VMM_DATA_DIR'];
  if (fromEnv) return fromEnv;
  let dir = start;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'data');
    if (existsSync(path.join(candidate, 'retirement-series.json'))) return candidate;
    dir = path.dirname(dir);
  }
  throw new Error('Could not locate the data/ directory (set VMM_DATA_DIR)');
}

export function loadCatalog(dataDir: string = findDataDir()): Catalog {
  const read = <T>(file: string): T => JSON.parse(readFileSync(path.join(dataDir, file), 'utf8').replace(/^\uFEFF/, '')) as T;
  return {
    retirement: read<RetirementCatalog>('retirement-series.json'),
    mapping: read<SkuMapping>('sku-mapping.json'),
  };
}

/** Parse the vCPU count out of a size name; the Resource SKUs API is more accurate (e.g. DS12_v2 = 4 vCPU). */
export function parseVcpuFromSize(size: string): number | undefined {
  const m = /^(?:Standard|Basic)_[A-Za-z]+(\d+)(?:-(\d+))?/.exec(size);
  if (!m) return undefined;
  return Number(m[2] ?? m[1]);
}

export function matchRetiringSeries(catalog: Catalog, size: string): SeriesMatch | undefined {
  for (const s of catalog.retirement.series) {
    if (new RegExp(s.pattern, 'i').test(size)) {
      return { series: s.id, retirementDate: s.retirementDate, ...(s.note ? { note: s.note } : {}) };
    }
  }
  return undefined;
}

export function buildCandidateTargets(catalog: Catalog, seriesId: string, opts: CandidateOptions): TargetCandidate[] {
  const groupName = catalog.mapping.series[seriesId];
  const group = groupName ? catalog.mapping.groups[groupName] : undefined;
  if (!group || !opts.vcpu) return [];
  const vcpu = opts.vcpu;
  const preferVendor = opts.preferVendor ?? 'AMD';
  const wantTemp = opts.osType === 'Windows';

  const eligible = group.filter(
    (t) =>
      (opts.includeOptional || !t.optional) &&
      (opts.memoryGb === undefined || t.memoryGbPerVcpu * vcpu >= opts.memoryGb - 0.01),
  );
  const sorted = [...eligible].sort(
    (a, b) =>
      b.generation - a.generation ||
      Number(a.tempDisk !== wantTemp) - Number(b.tempDisk !== wantTemp) ||
      Number(a.vendor !== preferVendor) - Number(b.vendor !== preferVendor),
  );
  return sorted.map((t, i) => ({
    sku: t.template.replace('{vcpu}', String(vcpu)),
    generation: t.generation,
    rank: i + 1,
    vendor: t.vendor,
    tempDisk: t.tempDisk,
    ...(t.optional ? { optional: true } : {}),
  }));
}
