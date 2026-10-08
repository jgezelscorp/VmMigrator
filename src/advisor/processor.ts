export interface ProcessorInfo {
  processor: string;
  /** Rough per-vCPU performance index, Intel Skylake = 100. An estimate, not a benchmark. */
  perfIndex: number;
}

type Vendor = 'Intel' | 'AMD' | 'Arm';

const INTEL: Record<number, [string, number]> = {
  1: ['Intel Sandy Bridge / Ivy Bridge', 55],
  2: ['Intel Haswell / Broadwell', 75],
  3: ['Intel Broadwell / Skylake', 90],
  4: ['Intel Cascade Lake', 105],
  5: ['Intel Ice Lake', 130],
  6: ['Intel Emerald Rapids', 165],
  7: ['Intel Granite Rapids', 200],
};

const AMD: Record<number, [string, number]> = {
  2: ['AMD EPYC 7452 (Rome)', 100],
  3: ['AMD EPYC 7763 (Milan)', 125],
  4: ['AMD EPYC 7763 (Milan)', 125],
  5: ['AMD EPYC 7763 (Milan)', 130],
  6: ['AMD EPYC 9004 (Genoa)', 175],
  7: ['AMD EPYC 9005 (Turin)', 215],
};

const ARM: Record<number, [string, number]> = {
  5: ['Ampere Altra (Neoverse N1)', 115],
  6: ['Azure Cobalt 100 (Neoverse N2)', 170],
};

export function processorFor(size: string): ProcessorInfo | undefined {
  const m = /^Standard_([A-Za-z]+)\d+(?:-\d+)?([a-z_]*?)(?:_v(\d+))?$/i.exec(size);
  if (!m) return undefined;
  const mods = (m[2] ?? '').replace(/_/g, '').toLowerCase();
  const version = m[3] ? Number(m[3]) : 1;
  const vendor: Vendor = mods.includes('p') ? 'Arm' : mods.includes('a') ? 'AMD' : 'Intel';
  const table = vendor === 'AMD' ? AMD : vendor === 'Arm' ? ARM : INTEL;
  const hit = table[version];
  if (!hit) return undefined;
  return { processor: hit[0], perfIndex: hit[1] };
}
