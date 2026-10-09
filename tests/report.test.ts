import { describe, it, expect } from 'vitest';
// @ts-expect-error untyped browser module
import { buildReport } from '../web/report.js';

describe('report finance', () => {
  const vm = { id: 'v1', name: 'vm1', vmSize: 'Standard_D2s_v3', resourceGroup: 'rg', osType: 'Linux', location: 'northeurope' };
  const advice = { v1: { current: { name: 'Standard_D2s_v3' }, proposed: { name: 'Standard_D2as_v5' }, reservation: { matches: [] },
    cost: { status: 'ok', currentMonthlyWithUplift: 100, currentUpliftKind: 'regional', currentUpliftPct: 17, proposedMonthlyWithUplift: 90, proposedOneYearMonthly: 60, proposedThreeYearMonthly: 40 } } };
  it('shows gain/loss with RI simulation when Auto-SKU target is used', () => {
    const html = buildReport({ vms: [vm], targets: { v1: 'Standard_D2as_v5' }, advice });
    expect(html).toContain('Financial impact (Auto-SKU)');
    expect(html).toContain('1-year reservation');
    expect(html).toContain('-$40.00');
    expect(html).toContain('-$480.00');
  });
  it('omits finance when target was changed manually', () => {
    expect(buildReport({ vms: [vm], targets: { v1: 'Standard_D4s_v5' }, advice })).not.toContain('Financial impact');
  });
});
