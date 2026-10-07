import { describe, expect, it } from 'vitest';
import { buildCandidateTargets, loadCatalog, matchRetiringSeries, parseVcpuFromSize } from '../src/catalog/index.js';

const catalog = loadCatalog();

describe('retirement catalog', () => {
  it.each([
    ['Standard_D2s_v3', 'Dsv3', '2029-11-15'],
    ['Standard_D2_v3', 'Dv3', '2029-11-15'],
    ['Standard_DS2_v2', 'Dsv2', '2028-05-01'],
    ['Standard_D2_v2', 'Dv2', '2028-05-01'],
    ['Standard_DS12_v2', 'DSv2-memory', '2028-05-01'],
    ['Standard_E2s_v3', 'Esv3', '2029-11-15'],
    ['Standard_E8-4s_v3', 'Esv3', '2029-11-15'],
    ['Standard_A2_v2', 'Av2', '2028-11-15'],
    ['Standard_F2s_v2', 'Fsv2', '2028-11-15'],
    ['Standard_B2s', 'Bv1', '2028-11-15'],
    ['Standard_L8s_v2', 'Lsv2', '2028-11-15'],
    ['Standard_D2', 'Dv1', '2028-05-01'],
  ])('%s -> %s', (size, series, date) => {
    expect(matchRetiringSeries(catalog, size)).toMatchObject({ series, retirementDate: date });
  });

  it.each(['Standard_D2as_v7', 'Standard_D2s_v5', 'Standard_E4as_v6', 'Standard_B2as_v2', 'Standard_D2ads_v7'])(
    '%s is not retiring',
    (size) => {
      expect(matchRetiringSeries(catalog, size)).toBeUndefined();
    },
  );

  it('parses vCPU counts from names', () => {
    expect(parseVcpuFromSize('Standard_D4s_v3')).toBe(4);
    expect(parseVcpuFromSize('Standard_E8-4s_v3')).toBe(4);
    expect(parseVcpuFromSize('nonsense')).toBeUndefined();
  });
});

describe('candidate targets', () => {
  it('ranks v7 before v6, AMD diskless first for Linux, v5 optional excluded', () => {
    const c = buildCandidateTargets(catalog, 'Dsv3', { vcpu: 2, osType: 'Linux' });
    expect(c[0]).toMatchObject({ sku: 'Standard_D2as_v7', generation: 7, rank: 1 });
    expect(c.map((x) => x.sku)).toContain('Standard_D2as_v6');
    expect(c.some((x) => x.generation === 5)).toBe(false);
    expect(c.findIndex((x) => x.generation === 6)).toBeGreaterThan(c.map((x) => x.generation).lastIndexOf(7));
  });

  it('prefers temp-disk (d) targets for Windows', () => {
    const c = buildCandidateTargets(catalog, 'Esv3', { vcpu: 2, osType: 'Windows' });
    expect(c[0]).toMatchObject({ sku: 'Standard_E2ads_v7', tempDisk: true });
  });

  it('maps F-series to Falsv7 and includes v5 when optional is requested', () => {
    const c = buildCandidateTargets(catalog, 'Fsv2', { vcpu: 2, osType: 'Linux', includeOptional: true });
    expect(c[0]?.sku).toBe('Standard_F2als_v7');
    expect(c.at(-1)?.optional).toBe(true);
  });

  it('drops targets with too little memory', () => {
    const c = buildCandidateTargets(catalog, 'Dsv2', { vcpu: 2, memoryGb: 14, osType: 'Linux' });
    expect(c).toHaveLength(0);
  });

  it('returns nothing for flag-only series', () => {
    expect(buildCandidateTargets(catalog, 'NVv3', { vcpu: 6, osType: 'Linux' })).toEqual([]);
  });
});
