import { describe, expect, it } from 'vitest';
import { REGIONAL_UPLIFT_PCT, RetailPriceProvider, lifecycleFamily, priceUplift } from '../src/advisor/index.js';

const items = [
  { retailPrice: 0.2, productName: 'Virtual Machines Dsv6 Series', skuName: 'D2s v6', meterName: 'D2s v6' },
  { retailPrice: 0.05, productName: 'Virtual Machines Dsv6 Series', skuName: 'D2s v6 Spot', meterName: 'D2s v6 Spot' },
  { retailPrice: 0.4, productName: 'Virtual Machines Dsv6 Series Windows', skuName: 'D2s v6', meterName: 'D2s v6' },
];
const fakeFetch = (async () => ({ ok: true, json: async () => ({ Items: items }) })) as unknown as typeof fetch;

describe('advisor', () => {
  it('detects lifecycle families', () => {
    for (const s of ['Standard_B2s', 'Standard_D2', 'Standard_DS2', 'Standard_F4s', 'Standard_G2', 'Standard_GS2', 'Standard_L4s', 'Standard_NP10s', 'Standard_HC44rs', 'Standard_A2_v2', 'Standard_A2m_v2', 'Standard_D2_v2', 'Standard_DS2_v2', 'Standard_F2s_v2', 'Standard_L8s_v2'])
      expect(lifecycleFamily(s), s).toBeTruthy();
    for (const s of ['Standard_D2s_v3', 'Standard_D2s_v5', 'Standard_B2s_v2', 'Standard_F2s_v3', 'Standard_L8s_v3', 'Standard_E4s_v5', 'Standard_D2ds_v6'])
      expect(lifecycleFamily(s), s).toBeUndefined();
  });

  it('does not stack lifecycle with regional uplift', () => {
    expect(priceUplift('Standard_D2_v2', 'westeurope')).toEqual({ pct: 25, kind: 'lifecycle' });
    expect(priceUplift('Standard_D2s_v5', 'westeurope')).toEqual({ pct: 9, kind: 'regional' });
    expect(priceUplift('Standard_D2s_v5', 'swedencentral')).toEqual({ pct: 0, kind: 'none' });
    for (const s of ['Standard_D4s_v7', 'Standard_D4ds_v7', 'Standard_D4ls_v7', 'Standard_D4lds_v7', 'Standard_E8s_v7', 'Standard_E8ds_v7', 'Standard_E16-8ds_v7']) {
      expect(priceUplift(s, 'westeurope')).toEqual({ pct: 0, kind: 'none' });
    }
    expect(priceUplift('Standard_D4as_v7', 'westeurope')).toEqual({ pct: 9, kind: 'regional' });
  });

  it('announced regional uplifts are present', () => {
    expect(REGIONAL_UPLIFT_PCT.northeurope).toBe(17);
    expect(REGIONAL_UPLIFT_PCT.francecentral).toBe(11);
    expect(REGIONAL_UPLIFT_PCT.westeurope).toBe(9);
    expect(REGIONAL_UPLIFT_PCT.southeastasia).toBe(8);
    expect(REGIONAL_UPLIFT_PCT.norwaywest).toBe(9);
  });

  it('picks the Linux or Windows list price and ignores spot', async () => {
    const p = new RetailPriceProvider(fakeFetch);
    expect(await p.hourlyPrice('swedencentral', 'Standard_D2s_v6', 'Linux')).toBe(0.2);
    expect(await p.hourlyPrice('swedencentral', 'Standard_D2s_v6', 'Windows')).toBe(0.4);
  });

  it('derives hourly reservation prices from term totals', async () => {
    const ri = [
      { reservationTerm: '1 Year', retailPrice: 876, productName: 'VM', skuName: 'D2s v6', meterName: 'D2s v6' },
      { reservationTerm: '3 Years', retailPrice: 1314, productName: 'VM', skuName: 'D2s v6', meterName: 'D2s v6' },
    ];
    const f = (async () => ({ ok: true, json: async () => ({ Items: ri }) })) as unknown as typeof fetch;
    const r = await new RetailPriceProvider(f).reservationHourly('swedencentral', 'Standard_D2s_v6', 'Linux');
    expect(r.oneYear).toBeCloseTo(876 / 8760, 6);
    expect(r.threeYear).toBeCloseTo(1314 / 26280, 6);
  });

  it('follows pagination, keeps Windows RI when PAYGO lookups fail, and does not cache failures', async () => {
    const page1 = { Items: [{ reservationTerm: '1 Year', retailPrice: 876 }], NextPageLink: 'https://next' };
    const page2 = { Items: [{ reservationTerm: '3 Years', retailPrice: 1314 }], NextPageLink: null };
    const f = (async (u: string) => ({ ok: !u.includes('Consumption'), json: async () => (u === 'https://next' ? page2 : page1) })) as unknown as typeof fetch;
    const r = await new RetailPriceProvider(f).reservationHourly('swedencentral', 'Standard_D2s_v6', 'Windows');
    expect(r.oneYear).toBeCloseTo(876 / 8760, 6);
    expect(r.threeYear).toBeCloseTo(1314 / 26280, 6);

    let fail = true;
    const g = (async () => {
      if (fail) throw new Error('offline');
      return { ok: true, json: async () => ({ Items: page1.Items }) };
    }) as unknown as typeof fetch;
    const p = new RetailPriceProvider(g);
    expect(await p.reservationHourly('r', 's', 'Linux')).toEqual({});
    fail = false;
    expect((await p.reservationHourly('r', 's', 'Linux')).oneYear).toBeCloseTo(876 / 8760, 6);
  });

  it('falls back to a 2-vCPU target for 1-vCPU VMs and explains why', async () => {
    const mk = (name: string, vcpus: number, family: string) => ({
      name, family, vcpus, memoryGb: vcpus * 4, maxResourceVolumeMB: 0, generations: ['V1', 'V2'], diskControllers: ['SCSI', 'NVMe'],
      acceleratedNetworking: true, premiumIO: true, zones: [], restrictions: [],
    });
    const all = [mk('Standard_DS1_v2', 1, 'standardDSv2Family'), ...['Standard_D2s_v6', 'Standard_D2ds_v6', 'Standard_D2s_v7', 'Standard_D2ds_v7'].map((n) => mk(n, 2, 'standardDsv6Family'))];
    const skus = { getSkus: async () => all, getUsages: async () => undefined };
    const arm = { list: async () => [] };
    const prices = { hourlyPrice: async () => undefined, reservationHourly: async () => ({}) };
    const vm = {
      id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/v', name: 'v', subscriptionId: 's', location: 'northeurope',
      vmSize: 'Standard_DS1_v2', retiringSeries: 'Dsv2', osType: 'Linux', hyperVGeneration: 'V2', diskControllerType: 'SCSI', zones: [],
    };
    const { SkuAdvisor } = await import('../src/advisor/index.js');
    const { loadCatalog } = await import('../src/catalog/index.js');
    const advisor = new SkuAdvisor({ arm, skus, catalog: loadCatalog(), prices } as never);
    const [adv] = await advisor.advise([vm as never]);
    expect(adv?.proposed?.vcpus).toBe(2);
    expect(adv?.notes.join(' ')).toContain('2-vCPU');
  });

  it('returns undefined when the price API fails', async () => {
    const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await new RetailPriceProvider(bad).hourlyPrice('x', 'y', 'Linux')).toBeUndefined();
  });
});
