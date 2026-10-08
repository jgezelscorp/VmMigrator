import { describe, expect, it } from 'vitest';
import { parseSeriesPage, seriesSlugs } from '../src/advisor/perf.js';

const page = `
| Size Name | vCPU | Premium SSD Max burst IOPS | Premium SSD Max burst throughput (MBps) | Max network bandwidth (Mbps) |
|---|---|---|---|---|
| Standard_D2as_v7 | 2 | 44,000 | 1,412 | 16,000 |
| Standard_D4as_v7 | 4 | 44,000 | 1,412 | 16,000 |
`;

describe('perf', () => {
  it('derives series slugs', () => {
    expect(seriesSlugs('Standard_D2s_v3')).toEqual(['dsv3']);
    expect(seriesSlugs('Standard_D2as_v7')).toEqual(['dasv7']);
    expect(seriesSlugs('Standard_F2')).toEqual(['f', 'fv1']);
  });

  it('parses burst and network figures', () => {
    const m = parseSeriesPage(page);
    expect(m.get('standard_d2as_v7')).toEqual({ burstIops: 44000, burstMBps: 1412, networkMbps: 16000 });
  });
});
