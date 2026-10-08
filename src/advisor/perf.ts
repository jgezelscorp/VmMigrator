export interface SizePerf {
  focus?: string;
  burstIops?: number;
  burstMBps?: number;
  networkMbps?: number;
}

export interface PerfProvider {
  get(size: string): Promise<SizePerf | undefined>;
}

const BASE = 'https://raw.githubusercontent.com/MicrosoftDocs/azure-compute-docs/main/articles/virtual-machines/sizes';
const FOLDERS: [string, string][] = [
  ['general-purpose', 'General purpose'],
  ['compute-optimized', 'Compute optimized'],
  ['memory-optimized', 'Memory optimized'],
  ['storage-optimized', 'Storage optimized'],
];

/** "Standard_D2s_v3" -> ["dsv3"]; sizes without a version are also tried as v1. */
export function seriesSlugs(size: string): string[] {
  const m = /^Standard_([A-Za-z]+)\d+(?:-\d+)?([a-z]*)(?:_([A-Za-z]+))?(?:_(v\d+))?$/i.exec(size);
  if (!m) return [];
  const base = `${m[1]}${m[2]}${m[3] ? m[3] : ''}`.toLowerCase();
  return m[4] ? [`${base}${m[4].toLowerCase()}`] : [base, `${base}v1`];
}

const toNumber = (s: string | undefined): number | undefined => {
  const n = Number((s ?? '').replace(/[,\s]/g, ''));
  return s && Number.isFinite(n) && n > 0 ? n : undefined;
};

/** Parses the per-size tables of a Microsoft Learn size-series page. */
export function parseSeriesPage(md: string): Map<string, SizePerf> {
  const out = new Map<string, SizePerf>();
  const lines = md.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const head = lines[i]!;
    if (!/^\|\s*Size Name/i.test(head)) continue;
    const cols = head.split('|').slice(1, -1).map((c) => c.trim());
    const find = (re: RegExp, not?: RegExp): number => cols.findIndex((c) => re.test(c) && !(not && not.test(c)));
    const bi = find(/burst iops/i, /ultra|v2/i);
    const bt = find(/burst throughput/i, /ultra|v2/i);
    const ni = find(/max network bandwidth/i);
    if (bi < 0 && bt < 0 && ni < 0) continue;
    for (let j = i + 2; j < lines.length && lines[j]!.startsWith('|'); j++) {
      const cells = lines[j]!.split('|').slice(1, -1).map((c) => c.trim());
      const name = cells[0]?.replace(/\\/g, '');
      if (!name) continue;
      const cur = out.get(name.toLowerCase()) ?? {};
      const burstIops = bi >= 0 ? toNumber(cells[bi]) : undefined;
      const burstMBps = bt >= 0 ? toNumber(cells[bt]) : undefined;
      const networkMbps = ni >= 0 ? toNumber(cells[ni]) : undefined;
      out.set(name.toLowerCase(), {
        ...cur,
        ...(burstIops !== undefined ? { burstIops } : {}),
        ...(burstMBps !== undefined ? { burstMBps } : {}),
        ...(networkMbps !== undefined ? { networkMbps } : {}),
      });
    }
  }
  return out;
}

/** Reads burst disk and network figures, plus the size focus, from the public Microsoft Learn source. Best effort. */
export class DocsPerfProvider implements PerfProvider {
  private readonly pages = new Map<string, Promise<{ focus: string; sizes: Map<string, SizePerf> } | undefined>>();
  constructor(private readonly fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  async get(size: string): Promise<SizePerf | undefined> {
    for (const slug of seriesSlugs(size)) {
      const page = await this.page(slug);
      const hit = page?.sizes.get(size.toLowerCase());
      if (page) return { focus: page.focus, ...(hit ?? {}) };
    }
    return undefined;
  }

  private page(slug: string): Promise<{ focus: string; sizes: Map<string, SizePerf> } | undefined> {
    let p = this.pages.get(slug);
    if (!p) {
      p = this.load(slug).catch(() => undefined);
      this.pages.set(slug, p);
    }
    return p;
  }

  private async load(slug: string): Promise<{ focus: string; sizes: Map<string, SizePerf> } | undefined> {
    for (const [folder, focus] of FOLDERS) {
      const res = await this.fetchImpl(`${BASE}/${folder}/${slug}-series.md`);
      if (res.ok) return { focus, sizes: parseSeriesPage(await res.text()) };
    }
    return undefined;
  }
}
