import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/index.js';
import { createDemoFakeArm } from './helpers/fleet.js';
import { MemoryJobStore } from '../src/migration/index.js';
import { REGIONAL_UPLIFT_PCT } from '../src/advisor/index.js';

const mk = () => buildApp({ arm: createDemoFakeArm({ latencyMs: 0 }), store: new MemoryJobStore(), fast: true });

describe('pricing settings', () => {
  afterEach(async () => {
    const app = mk();
    await app.inject({ method: 'POST', url: '/api/settings/reset' });
    await app.close();
  });

  it('serves defaults prepopulated from known values', async () => {
    const app = mk();
    const r = (await app.inject({ url: '/api/settings' })).json();
    expect(r.settings.regions.find((x: { name: string; upliftPct: number }) => x.name === 'northeurope').upliftPct).toBe(REGIONAL_UPLIFT_PCT.northeurope);
    expect(r.settings.series.length).toBeGreaterThan(10);
    expect(r.defaults.series.length).toBe(r.settings.series.length);
    await app.close();
  });

  it('validates input', async () => {
    const app = mk();
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { version: 1, effectiveDate: 'x', series: [], regions: [] } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });

  it('stores customer discounts and rejects invalid ones', async () => {
    const app = mk();
    const cur = (await app.inject({ url: '/api/settings' })).json().settings;
    expect(cur.customerPricing).toEqual({ paygoDiscountPct: 0, reservationDiscountPct: 0 });
    const bad = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...cur, customerPricing: { paygoDiscountPct: 120, reservationDiscountPct: 0 } } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PUT', url: '/api/settings', payload: { ...cur, customerPricing: { paygoDiscountPct: 15, reservationDiscountPct: 5 } } });
    expect(ok.json().settings.customerPricing).toEqual({ paygoDiscountPct: 15, reservationDiscountPct: 5 });
    await app.close();
  });

  it('saves, persists in memory and resets', async () => {
    const app = mk();
    const cur = (await app.inject({ url: '/api/settings' })).json().settings;
    cur.regions.push({ name: 'testregion', upliftPct: 42 });
    const put = await app.inject({ method: 'PUT', url: '/api/settings', payload: cur });
    expect(put.statusCode).toBe(200);
    const again = (await app.inject({ url: '/api/settings' })).json().settings;
    expect(again.regions.some((x: { name: string; upliftPct: number }) => x.name === 'testregion' && x.upliftPct === 42)).toBe(true);
    const reset = (await app.inject({ method: 'POST', url: '/api/settings/reset' })).json().settings;
    expect(reset.regions.some((x: { name: string; upliftPct: number }) => x.name === 'testregion')).toBe(false);
    await app.close();
  });
});
