import { describe, it, expect } from 'vitest';
// @ts-ignore
import { computeExposure, protectedPassThrough, projectCosts } from '../web/exposure.js';

const row = (o: object) => ({ vmId: 'a', name: 'a', subscriptionId: 's', location: 'northeurope', size: 'Standard_D2s_v3', rule: 'lifecycle', upliftPct: 25, sovereign: false, priced: true, paygoMonthly: 100, purchase: 'payg', ...o });

describe('exposure', () => {
  it('bounds protection by the discount', () => {
    expect(protectedPassThrough(25, 0)).toBe(0);
    expect(protectedPassThrough(25, 20)).toBeCloseTo(0.25);
    expect(protectedPassThrough(17, 10)).toBeCloseTo(0.111, 2);
  });
  it('aggregates payg, reserved and unpriced', () => {
    const x = computeExposure([
      row({}),
      row({ vmId: 'b', purchase: 'reserved', reservedMonthly: 60 }),
      row({ vmId: 'c', priced: false }),
    ], { paygoDiscountPct: 0 });
    expect(x.total.high).toBeCloseTo(25);
    expect(x.total.low).toBe(0);
    expect(x.total.reserved).toBe(60);
    expect(x.total.unpriced).toBe(1);
  });
  it('excluded rule has no increase', () => {
    const x = computeExposure([row({ rule: 'excluded', upliftPct: 0 })], {});
    expect(x.total.high).toBe(0);
    expect(x.total.excluded).toBe(1);
  });
});

describe('projectCosts', () => {
  const now = new Date('2026-06-15T00:00:00Z');
  it('uses RI price until expiry then uplifted PAYG', () => {
    const p = projectCosts([row({ purchase: 'reserved', reservedMonthly: 60, reservationExpiry: '2027-06-15T00:00:00Z' })] as any, {}, '2027-02-01', 36, now);
    const n = p.options.find((o: any) => o.key === 'nothing');
    expect(n.series[0].cost).toBe(60);
    expect(n.series[35].cost).toBeCloseTo(125);
    expect(p.expiries[0].date).toBe('2027-06-15');
    expect(p.hasRi).toBe(true);
  });
  it('falls back to Azure PAYG without RI and ranks migration cheaper', () => {
    const p = projectCosts([row({ targetPaygMonthly: 90, targetUpliftPct: 0, targetRiMonthly: 60 })] as any, {}, '2027-02-01', 36, now);
    expect(p.hasRi).toBe(false);
    expect(p.options[0].key).toBe('v7ri');
    expect(p.options[2].key).toBe('nothing');
  });
});
