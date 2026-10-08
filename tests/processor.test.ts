import { describe, expect, it } from 'vitest';
import { processorFor } from '../src/advisor/processor.js';

describe('processorFor', () => {
  it('maps Intel, AMD and Arm series', () => {
    expect(processorFor('Standard_DS2_v2')?.processor).toMatch(/Haswell/);
    expect(processorFor('Standard_D4s_v7')?.processor).toMatch(/Granite Rapids/);
    expect(processorFor('Standard_D4ads_v6')?.processor).toMatch(/Genoa/);
    expect(processorFor('Standard_D4ps_v6')?.processor).toMatch(/Cobalt/);
  });
  it('estimates newer generations as faster', () => {
    expect(processorFor('Standard_D4s_v7')!.perfIndex).toBeGreaterThan(processorFor('Standard_D4s_v3')!.perfIndex);
  });
  it('returns undefined for unknown names', () => {
    expect(processorFor('Standard_NC24ads_A100_v4')).toBeUndefined();
  });
});
