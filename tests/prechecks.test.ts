import { describe, expect, it } from 'vitest';
import { SkuService, normalizeSku } from '../src/azure/skus.js';
import { loadCatalog } from '../src/catalog/index.js';
import { normalizeVm } from '../src/discovery/index.js';
import type { CheckStatus, VmInfo } from '../src/domain/types.js';
import {
  PRE_CHECKS,
  assessNvmeOs,
  formatPreCheckReport,
  requiredController,
  runPreChecks,
  targetGenerationOf,
  type PreCheckContext,
} from '../src/prechecks/index.js';
import { DEFAULT_SKUS, SUB, nicId, rawSku, rawVm, standardEnv, type RawSkuOptions, type RawVmOptions } from './helpers/fixtures.js';
import { MockArm } from './helpers/mockArm.js';

const catalog = loadCatalog();
const vmOf = (o: RawVmOptions): VmInfo => normalizeVm(rawVm(o), undefined, catalog);
const skuOf = (o: RawSkuOptions) => normalizeSku(rawSku(o) as never);

const DASV7 = { name: 'Standard_D2as_v7', family: 'standardDasv7Family', vcpus: 2, memoryGb: 8, gens: 'V2', controllers: 'NVMe' } satisfies RawSkuOptions;
const DADSV7 = { ...DASV7, name: 'Standard_D2ads_v7', family: 'standardDadsv7Family', tempMb: 76800 } satisfies RawSkuOptions;
const SRC = { name: 'Standard_D2s_v3', family: 'standardDSv3Family', vcpus: 2, memoryGb: 8, tempMb: 16384, controllers: 'SCSI' } satisfies RawSkuOptions;

function ctx(vm: VmInfo, target: RawSkuOptions | undefined, over: Partial<PreCheckContext> = {}): PreCheckContext {
  const name = target?.name ?? 'Standard_D2as_v7';
  return {
    vm,
    targetSku: name,
    ...(target ? { target: skuOf(target) } : {}),
    source: skuOf(SRC),
    targetGeneration: targetGenerationOf(name),
    loadErrors: {},
    now: new Date('2026-10-07T00:00:00Z'),
    ...over,
  };
}

async function run(id: string, c: PreCheckContext): Promise<CheckStatus> {
  const check = PRE_CHECKS.find((x) => x.id === id);
  if (!check) throw new Error(`unknown check ${id}`);
  return (await check.run(c)).status;
}

describe('individual checks', () => {
  const linux = vmOf({ name: 'l', controller: 'SCSI' });
  const win = vmOf({ name: 'w', os: 'Windows', controller: 'SCSI' });

  it('vm-state', async () => {
    expect(await run('vm-state', ctx(vmOf({ name: 'a', power: 'deallocated' }), DASV7))).toBe('PASS');
    expect(await run('vm-state', ctx(linux, DASV7))).toBe('WARN');
    expect(await run('vm-state', ctx({ ...linux, provisioningState: 'Failed' }, DASV7))).toBe('BLOCK');
  });

  it('sku-availability: missing, restricted, zone', async () => {
    expect(await run('sku-availability', ctx(linux, undefined))).toBe('BLOCK');
    expect(await run('sku-availability', ctx(linux, DASV7))).toBe('PASS');
    expect(await run('sku-availability', ctx(linux, { ...DASV7, restrictions: [{ type: 'Location' }] }))).toBe('BLOCK');
    const zonal = vmOf({ name: 'z', zones: ['2'] });
    expect(await run('sku-availability', ctx(zonal, { ...DASV7, zones: ['1', '2'] }))).toBe('PASS');
    expect(await run('sku-availability', ctx(zonal, { ...DASV7, zones: ['1', '3'] }))).toBe('BLOCK');
    expect(await run('sku-availability', ctx(zonal, { ...DASV7, restrictions: [{ type: 'Zone', zones: ['2'] }] }))).toBe('BLOCK');
  });

  it('quota: family and regional', async () => {
    const usages = (family: [number, number], cores: [number, number]) => [
      { name: 'standardDasv7Family', currentValue: family[0], limit: family[1] },
      { name: 'cores', currentValue: cores[0], limit: cores[1] },
    ];
    expect(await run('quota', ctx(linux, DASV7, { usages: usages([0, 10], [0, 100]) }))).toBe('PASS');
    expect(await run('quota', ctx(linux, DASV7, { usages: usages([0, 0], [0, 100]) }))).toBe('BLOCK');
    expect(await run('quota', ctx(linux, DASV7, { usages: usages([0, 10], [100, 100]) }))).toBe('PASS'); // same vCPU count: no regional delta
    expect(await run('quota', ctx(linux, { ...DASV7, vcpus: 4 }, { usages: usages([0, 10], [100, 100]) }))).toBe('BLOCK');
    expect(await run('quota', ctx(linux, DASV7, { usages: [] }))).toBe('WARN');
    expect(await run('quota', ctx(linux, DASV7, { loadErrors: { usages: '403' } }))).toBe('WARN');
  });

  it('generation: Gen1 is BLOCK for Gen2-only targets and PASS for v5', async () => {
    const gen1 = vmOf({ name: 'g1', gen: 'V1' });
    expect(await run('generation', ctx(gen1, DASV7))).toBe('BLOCK');
    expect(await run('generation', ctx(gen1, { ...DASV7, name: 'Standard_D2as_v5', gens: 'V1,V2' }))).toBe('PASS');
    expect(await run('generation', ctx(linux, DASV7))).toBe('PASS');
    expect(await run('generation', ctx({ ...linux, hyperVGeneration: undefined as never }, DASV7))).toBe('WARN');
  });

  it('disk-controller: conversion is WARN, NVMe VM to SCSI-only target is BLOCK', async () => {
    expect(await run('disk-controller', ctx(linux, DASV7))).toBe('WARN');
    expect(await run('disk-controller', ctx(linux, { ...DASV7, controllers: 'SCSI,NVMe' }))).toBe('PASS');
    expect(await run('disk-controller', ctx({ ...linux, diskControllerType: 'NVMe' }, DASV7))).toBe('PASS');
    expect(await run('disk-controller', ctx({ ...linux, diskControllerType: 'NVMe' }, { ...DASV7, controllers: 'SCSI' }))).toBe('BLOCK');
    expect(requiredController(linux, skuOf(DASV7))).toEqual({ controller: 'NVMe', conversion: true });
    expect(requiredController(linux, skuOf({ ...DASV7, controllers: 'SCSI,NVMe' }))).toEqual({ controller: 'SCSI', conversion: false });
  });

  it('nvme-image: OS support heuristics and image tag', async () => {
    const ws2016 = { ...win, imageReference: { publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2016-datacenter' } };
    expect(await run('nvme-image', ctx(linux, DASV7))).toBe('PASS');
    expect(await run('nvme-image', ctx(ws2016, DASV7))).toBe('BLOCK');
    expect(await run('nvme-image', ctx(ws2016, DASV7, { imageControllers: ['SCSI', 'NVMe'] }))).toBe('PASS');
    expect(await run('nvme-image', ctx({ ...linux, imageReference: { id: '/gallery/x' } }, DASV7))).toBe('WARN');
    expect(await run('nvme-image', ctx(ws2016, { ...DASV7, controllers: 'SCSI,NVMe', name: 'Standard_D2as_v5', gens: 'V1,V2' }))).toBe('PASS');
  });

  it.each([
    [{ publisher: 'Canonical', offer: '0001-com-ubuntu-server-jammy', sku: '22_04-lts-gen2' }, 'Linux', 'supported'],
    [{ publisher: 'Canonical', offer: 'UbuntuServer', sku: '16.04-LTS' }, 'Linux', 'unsupported'],
    [{ publisher: 'RedHat', offer: 'RHEL', sku: '8_5' }, 'Linux', 'unsupported'],
    [{ publisher: 'RedHat', offer: 'RHEL', sku: '9_4' }, 'Linux', 'supported'],
    [{ publisher: 'SUSE', offer: 'sles-15-sp5', sku: 'gen2' }, 'Linux', 'supported'],
    [{ publisher: 'Debian', offer: 'debian-12', sku: '12-gen2' }, 'Linux', 'supported'],
    [{ publisher: 'MicrosoftWindowsDesktop', offer: 'windows-11', sku: 'win11-23h2-pro' }, 'Windows', 'supported'],
    [{ publisher: 'MicrosoftWindowsServer', offer: 'WindowsServer', sku: '2019-datacenter' }, 'Windows', 'supported'],
    [{ publisher: 'Contoso', offer: 'x', sku: 'y' }, 'Linux', 'unknown'],
  ] as const)('assessNvmeOs %j', (image, os, expected) => {
    expect(assessNvmeOs({ ...vmOf({ name: 'x', os }), imageReference: image }).support).toBe(expected);
  });

  it('temp-disk: Windows temp->diskless is BLOCK, Linux WARN, d->d WARN', async () => {
    expect(await run('temp-disk', ctx(win, DASV7))).toBe('BLOCK');
    expect(await run('temp-disk', ctx(linux, DASV7))).toBe('WARN');
    expect(await run('temp-disk', ctx(win, DADSV7))).toBe('WARN');
    expect(await run('temp-disk', ctx(win, DASV7, { source: skuOf({ ...SRC, tempMb: 0 }) }))).toBe('PASS');
    expect(await run('temp-disk', ctx(win, { ...DADSV7 }, { source: skuOf({ ...SRC, tempMb: 0 }) }))).toBe('BLOCK');
  });

  it('accelerated-networking', async () => {
    expect(await run('accelerated-networking', ctx({ ...linux, acceleratedNetworking: true }, DASV7))).toBe('PASS');
    expect(await run('accelerated-networking', ctx({ ...linux, acceleratedNetworking: true }, { ...DASV7, an: false }))).toBe('WARN');
    expect(await run('accelerated-networking', ctx({ ...linux, acceleratedNetworking: false }, DASV7))).toBe('WARN');
  });

  it('azure-disk-encryption: BLOCK on v6/v7, WARN on v5', async () => {
    const ade = { ...linux, encryption: { ade: true, encryptionAtHost: false } };
    expect(await run('azure-disk-encryption', ctx(ade, DASV7))).toBe('BLOCK');
    expect(await run('azure-disk-encryption', ctx(ade, { ...DASV7, name: 'Standard_D2as_v5', controllers: 'SCSI', gens: 'V1,V2' }))).toBe('WARN');
    expect(await run('azure-disk-encryption', ctx(linux, DASV7))).toBe('PASS');
  });

  it('ephemeral-os-disk: BLOCK for diskless, WARN for d sizes that support it', async () => {
    const eph = { ...linux, ephemeralOsDisk: true };
    expect(await run('ephemeral-os-disk', ctx(eph, DASV7))).toBe('BLOCK');
    expect(await run('ephemeral-os-disk', ctx(eph, { ...DADSV7, ephemeral: true }))).toBe('WARN');
    expect(await run('ephemeral-os-disk', ctx(linux, DASV7))).toBe('PASS');
  });

  it('availability-set / ppg / reserved-ip', async () => {
    expect(await run('availability-set', ctx(linux, DASV7))).toBe('PASS');
    expect(await run('availability-set', ctx({ ...linux, availabilitySetId: '/avs' }, DASV7))).toBe('WARN');
    expect(await run('proximity-placement-group', ctx({ ...linux, proximityPlacementGroupId: '/ppg' }, DASV7))).toBe('WARN');
    const dyn = { ...linux, nics: [{ id: 'n', acceleratedNetworking: true, publicIps: [{ id: 'i', allocationMethod: 'Dynamic', sku: 'Basic' }] }] };
    const stat = { ...linux, nics: [{ id: 'n', acceleratedNetworking: true, publicIps: [{ id: 'i', allocationMethod: 'Static', sku: 'Standard' }] }] };
    expect(await run('reserved-ip', ctx(dyn, DASV7))).toBe('WARN');
    expect(await run('reserved-ip', ctx(stat, DASV7))).toBe('PASS');
  });

  it('backup and resource-locks', async () => {
    expect(await run('backup', ctx(linux, DASV7, { backup: { protected: true } }))).toBe('PASS');
    expect(await run('backup', ctx(linux, DASV7, { backup: { protected: false } }))).toBe('WARN');
    expect(await run('resource-locks', ctx(linux, DASV7, { locks: [] }))).toBe('PASS');
    expect(await run('resource-locks', ctx(linux, DASV7, { locks: [{ name: 'l', level: 'ReadOnly', scope: '/s' }] }))).toBe('BLOCK');
    expect(await run('resource-locks', ctx(linux, DASV7, { locks: [{ name: 'l', level: 'CanNotDelete', scope: '/s' }] }))).toBe('WARN');
  });

  it('placement-constraints, premium-storage, disk-limits, shared-disks, extensions, security-type', async () => {
    expect(await run('placement-constraints', ctx({ ...linux, priority: 'Spot' }, DASV7))).toBe('WARN');
    expect(await run('placement-constraints', ctx({ ...linux, virtualMachineScaleSetId: '/vmss' }, DASV7))).toBe('BLOCK');
    expect(await run('placement-constraints', ctx(linux, DASV7))).toBe('PASS');
    expect(await run('premium-storage', ctx(linux, { ...DASV7, premium: false }))).toBe('BLOCK');
    expect(await run('premium-storage', ctx(linux, DASV7))).toBe('PASS');
    const many = { ...linux, dataDisks: Array.from({ length: 9 }, (_, i) => ({ name: `d${i}` })) };
    expect(await run('disk-limits', ctx(many, DASV7))).toBe('BLOCK');
    const shared = { ...linux, dataDisks: [{ name: 'd', shared: true }] };
    expect(await run('shared-disks', ctx(shared, DASV7))).toBe('WARN');
    const ws19 = { ...win, dataDisks: [{ name: 'd', shared: true }], imageReference: { offer: 'WindowsServer', sku: '2019-datacenter' } };
    expect(await run('shared-disks', ctx(ws19, DASV7))).toBe('BLOCK');
    expect(await run('extensions', ctx({ ...linux, extensions: [{ name: 'e', provisioningState: 'Failed' }] }, DASV7))).toBe('WARN');
    expect(await run('security-type', ctx({ ...linux, securityType: 'ConfidentialVM' }, DASV7))).toBe('BLOCK');
    expect(await run('deallocation-required', ctx(vmOf({ name: 'x', power: 'deallocated' }), DASV7))).toBe('PASS');
  });
});

describe('runPreChecks engine', () => {
  const deps = (arm: MockArm) => ({ arm, skus: new SkuService(arm), catalog });
  const withUsages = (arm: MockArm, familyLimit = 20): MockArm =>
    arm
      .onList('/usages', [
        { name: { value: 'cores' }, currentValue: 0, limit: 100 },
        ...DEFAULT_SKUS.map((s) => ({ name: { value: String((s as { family: string }).family) }, currentValue: 0, limit: familyLimit })),
      ])
      .onList('/providers/Microsoft.Authorization/locks', [])
      .onSend('POST', '/providers/Microsoft.ResourceGraph/resources', () => ({ data: [] }));

  it('auto-selects the best viable target (v7) and is read-only', async () => {
    const raw = rawVm({ name: 'lnx', size: 'Standard_D2s_v3', zones: ['1'] });
    const arm = withUsages(standardEnv([raw]));
    const vm = normalizeVm({ ...raw, properties: { ...(raw['properties'] as object) } }, undefined, catalog);
    const r = await runPreChecks(deps(arm), vm);
    expect(r.targetSku).toBe('Standard_D2as_v7');
    expect(r.targetSelection).toBe('auto');
    expect(r.targetDiskController).toBe('NVMe');
    expect(r.overall).toBe('WARN');
    expect(r.checks.length).toBeGreaterThanOrEqual(20);
    expect(arm.calls.filter((c) => !['GET', 'POST'].includes(c.method))).toHaveLength(0);
    expect(arm.calls.filter((c) => c.method === 'POST').every((c) => c.path.includes('ResourceGraph'))).toBe(true);
    expect(formatPreCheckReport(vm, r)).toContain('Standard_D2s_v3 -> Standard_D2as_v7');
  });

  it('falls back to v6 when v7 is restricted in the zone/quota', async () => {
    const skus = DEFAULT_SKUS.map((s) =>
      (s as { name: string }).name === 'Standard_D2as_v7' ? rawSku({ ...DASV7, restrictions: [{ type: 'Location' }] }) : s,
    );
    const raw = rawVm({ name: 'lnx', size: 'Standard_D2s_v3' });
    const arm = withUsages(standardEnv([raw])).onList('/providers/Microsoft.Compute/skus', skus);
    const vm = normalizeVm(raw, undefined, catalog);
    const r = await runPreChecks(deps(arm), vm);
    expect(r.targetSku).toBe('Standard_D2ads_v7');
    expect(r.candidatesEvaluated?.[0]).toEqual({ sku: 'Standard_D2as_v7', overall: 'BLOCK' });
  });

  it('BLOCKs Gen1 VMs on v6/v7 and offers the v5 fallback', async () => {
    const raw = rawVm({ name: 'g1', size: 'Standard_D2s_v3', gen: 'V1' });
    const arm = withUsages(standardEnv([raw]));
    const vm = normalizeVm(raw, undefined, catalog);
    const explicit = await runPreChecks(deps(arm), vm, { targetSku: 'Standard_D2as_v7' });
    expect(explicit.overall).toBe('BLOCK');
    expect(explicit.checks.find((c) => c.checkId === 'generation')?.status).toBe('BLOCK');
    const auto = await runPreChecks(deps(arm), vm);
    expect(auto.targetSku).toBe('Standard_D2as_v5');
    expect(auto.overall).not.toBe('BLOCK');
    expect(auto.targetDiskController).toBe('SCSI');
  });

  it('reports a target-selection BLOCK when nothing exists', async () => {
    const raw = rawVm({ name: 'x', size: 'Standard_M128s' });
    const arm = withUsages(standardEnv([raw]));
    const r = await runPreChecks(deps(arm), normalizeVm(raw, undefined, catalog));
    expect(r.overall).toBe('BLOCK');
    expect(r.checks[0]?.checkId).toBe('target-selection');
  });

  it('degrades load failures to WARN instead of failing', async () => {
    const raw = rawVm({ name: 'lnx', size: 'Standard_D2s_v3' });
    const arm = standardEnv([raw]);
    const r = await runPreChecks(deps(arm), normalizeVm(raw, undefined, catalog), { targetSku: 'Standard_D2as_v7' });
    expect(r.checks.find((c) => c.checkId === 'quota')?.status).toBe('WARN');
    expect(r.checks.find((c) => c.checkId === 'resource-locks')?.status).toBe('WARN');
    expect(r.checks.find((c) => c.checkId === 'backup')?.status).toBe('WARN');
  });

  it('supports pluggable checks and detects backup and locks', async () => {
    const raw = rawVm({ name: 'lnx', size: 'Standard_D2s_v3' });
    const arm = withUsages(standardEnv([raw]))
      .onList('/providers/Microsoft.Authorization/locks', [
        { name: 'ro', id: `${raw['id']}/providers/Microsoft.Authorization/locks/ro`, properties: { level: 'ReadOnly' } },
        { name: 'other', id: `/subscriptions/${SUB}/resourceGroups/other/providers/Microsoft.Authorization/locks/o`, properties: { level: 'ReadOnly' } },
      ])
      .onSend('POST', '/providers/Microsoft.ResourceGraph/resources', () => ({ data: [{ lastRecoveryPoint: '2026-10-06', protectionState: 'Protected' }] }));
    const r = await runPreChecks(
      { ...deps(arm), checks: [...PRE_CHECKS, { id: 'custom', run: () => ({ checkId: 'custom', status: 'PASS', message: 'ok' }) }] },
      normalizeVm(raw, undefined, catalog),
      { targetSku: 'Standard_D2as_v7' },
    );
    expect(r.checks.find((c) => c.checkId === 'custom')).toBeDefined();
    expect(r.checks.find((c) => c.checkId === 'resource-locks')?.status).toBe('BLOCK');
    expect(r.checks.find((c) => c.checkId === 'backup')?.status).toBe('PASS');
    expect(nicId('x')).toContain('x-nic');
  });
});
