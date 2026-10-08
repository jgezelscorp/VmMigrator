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

  it('returns undefined when the price API fails', async () => {
    const bad = (async () => { throw new Error('offline'); }) as unknown as typeof fetch;
    expect(await new RetailPriceProvider(bad).hourlyPrice('x', 'y', 'Linux')).toBeUndefined();
  });
});
