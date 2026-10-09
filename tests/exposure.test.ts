import { describe, it, expect } from 'vitest';
// @ts-ignore
import { computeExposure, protectedPassThrough } from '../web/exposure.js';

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
