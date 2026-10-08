import { describe, expect, it } from 'vitest';
import { REGIONAL_UPLIFT_PCT, RetailPriceProvider } from '../src/advisor/index.js';

const items = [
  { retailPrice: 0.2, productName: 'Virtual Machines Dsv6 Series', skuName: 'D2s v6', meterName: 'D2s v6' },
  { retailPrice: 0.05, productName: 'Virtual Machines Dsv6 Series', skuName: 'D2s v6 Spot', meterName: 'D2s v6 Spot' },
  { retailPrice: 0.4, productName: 'Virtual Machines Dsv6 Series Windows', skuName: 'D2s v6', meterName: 'D2s v6' },
];
const fakeFetch = (async () => ({ ok: true, json: async () => ({ Items: items }) })) as unknown as typeof fetch;

describe('advisor', () => {
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
