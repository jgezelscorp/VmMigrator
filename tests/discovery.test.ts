import { describe, expect, it } from 'vitest';
import { HttpArmClient } from '../src/azure/arm.js';
import { SkuService } from '../src/azure/skus.js';
import { loadCatalog } from '../src/catalog/index.js';
import { discoverVms } from '../src/discovery/index.js';
import { SUB, diskId, nicId, rawVm, standardEnv } from './helpers/fixtures.js';
import { MockArm } from './helpers/mockArm.js';

const catalog = loadCatalog();

describe('discoverVms', () => {
  it('flags retiring series, enriches VM facts and ranks candidate targets', async () => {
    const arm = standardEnv([
      rawVm({ name: 'lnx-dsv3', size: 'Standard_D2s_v3', zones: ['1'], dataDisks: 1, extensions: [{ name: 'ade', type: 'AzureDiskEncryptionForLinux' }] }),
      rawVm({ name: 'win-esv3', size: 'Standard_E2s_v3', os: 'Windows', controller: 'SCSI' }),
      rawVm({ name: 'modern', size: 'Standard_D2as_v7', controller: 'NVMe' }),
      rawVm({ name: 'old-gen1', size: 'Standard_A2_v2', gen: 'V1', availabilitySetId: '/subscriptions/x/availabilitySets/avs', ephemeral: false }),
    ]);
    const vms = await discoverVms(arm, new SkuService(arm), catalog, {});
    expect(vms.map((v) => v.name)).toEqual(['lnx-dsv3', 'modern', 'old-gen1', 'win-esv3']);

    const lnx = vms[0]!;
    expect(lnx).toMatchObject({
      subscriptionId: SUB,
      resourceGroup: 'rg-demo',
      retiringSeries: 'Dsv3',
      retirementDate: '2029-11-15',
      hyperVGeneration: 'V2',
      diskControllerType: 'SCSI',
      powerState: 'running',
      zones: ['1'],
      osType: 'Linux',
    });
    expect(lnx.encryption?.ade).toBe(true);
    expect(lnx.extensions?.[0]).toMatchObject({ name: 'ade', provisioningState: 'Succeeded', statusCode: 'ProvisioningState/succeeded' });
    expect(lnx.dataDisks).toHaveLength(1);
    expect(lnx.candidateTargets?.[0]).toMatchObject({ sku: 'Standard_D2as_v7', rank: 1 });

    expect(vms[1]).toMatchObject({ name: 'modern', diskControllerType: 'NVMe' });
    expect(vms[1]?.retiringSeries).toBeUndefined();
    expect(vms[1]?.candidateTargets).toBeUndefined();

    const gen1 = vms[2]!;
    expect(gen1.hyperVGeneration).toBe('V1');
    expect(gen1.availabilitySetId).toBe('/subscriptions/x/availabilitySets/avs');
    expect(gen1.candidateTargets?.some((c) => c.optional)).toBe(true);

    const win = vms[3]!;
    expect(win.candidateTargets?.[0]).toMatchObject({ tempDisk: true, sku: 'Standard_E2ads_v7' });
    expect(win.acceleratedNetworking).toBe(true);
  });

  it('filters to retiring VMs and honours explicit subscriptions without listing them', async () => {
    const arm = standardEnv([rawVm({ name: 'a', size: 'Standard_D2s_v3' }), rawVm({ name: 'b', size: 'Standard_D2as_v7' })]);
    const vms = await discoverVms(arm, new SkuService(arm), catalog, { subscriptionIds: [SUB], retiringOnly: true });
    expect(vms.map((v) => v.name)).toEqual(['a']);
    expect(arm.calls.some((c) => c.path.startsWith('/subscriptions?api-version'))).toBe(false);
  });

  it('detects shared disks, public IPs and ephemeral OS disks from sub-resources', async () => {
    const arm = new MockArm()
      .onList('/providers/Microsoft.Compute/virtualMachines?', [rawVm({ name: 'v', dataDisks: 1, ephemeral: true })])
      .onList('/providers/Microsoft.Compute/skus', [])
      .onList('/providers/Microsoft.Network/networkInterfaces', [
        {
          id: nicId('v'),
          properties: { enableAcceleratedNetworking: false, ipConfigurations: [{ properties: { publicIPAddress: { id: '/ip/1' } } }] },
        },
      ])
      .onList('/providers/Microsoft.Network/publicIPAddresses', [{ id: '/ip/1', sku: { name: 'Basic' }, properties: { publicIPAllocationMethod: 'Dynamic' } }])
      .onList('/providers/Microsoft.Compute/disks', [{ id: diskId('v-data0'), name: 'v-data0', properties: { maxShares: 2 } }]);
    const [vm] = await discoverVms(arm, new SkuService(arm), catalog, { subscriptionIds: [SUB] });
    expect(vm?.ephemeralOsDisk).toBe(true);
    expect(vm?.dataDisks?.[0]?.shared).toBe(true);
    expect(vm?.nics?.[0]?.publicIps[0]).toEqual({ id: '/ip/1', allocationMethod: 'Dynamic', sku: 'Basic' });
    expect(vm?.acceleratedNetworking).toBe(false);
  });

  it('warns and continues when sub-resource listing fails', async () => {
    const arm = new MockArm().onList('/providers/Microsoft.Compute/virtualMachines?', [rawVm({ name: 'v' })]);
    const warnings: string[] = [];
    const vms = await discoverVms(arm, new SkuService(arm), catalog, { subscriptionIds: [SUB], onWarning: (m) => warnings.push(m) });
    expect(vms).toHaveLength(1);
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
});

describe('HttpArmClient', () => {
  const credential = { getToken: async () => ({ token: 't', expiresOnTimestamp: Date.now() + 3_600_000 }) };
  const json = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), { status: 200, ...init });

  it('follows nextLink pagination', async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return url.endsWith('p1') ? json({ value: [1, 2], nextLink: 'https://management.azure.com/p2' }) : json({ value: [3] });
    }) as unknown as typeof fetch;
    const arm = new HttpArmClient({ credential, fetchImpl });
    expect(await arm.list('/p1')).toEqual([1, 2, 3]);
    expect(urls).toEqual(['https://management.azure.com/p1', 'https://management.azure.com/p2']);
  });

  it('retries 429 honouring Retry-After', async () => {
    let n = 0;
    const slept: number[] = [];
    const fetchImpl = (async () => (n++ < 2 ? new Response('{}', { status: 429, headers: { 'retry-after': '2' } }) : json({ ok: true }))) as unknown as typeof fetch;
    const arm = new HttpArmClient({ credential, fetchImpl, sleep: async (ms) => void slept.push(ms) });
    expect(await arm.get('/x')).toEqual({ ok: true });
    expect(slept).toEqual([2000, 2000]);
  });

  it('gives up after maxRetries and surfaces ArmError', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ error: { code: 'TooMany', message: 'slow down' } }), { status: 429 })) as unknown as typeof fetch;
    const arm = new HttpArmClient({ credential, fetchImpl, maxRetries: 1, sleep: async () => undefined });
    await expect(arm.get('/x')).rejects.toMatchObject({ status: 429, code: 'TooMany' });
  });

  it('polls long-running operations until Succeeded', async () => {
    const calls: string[] = [];
    let polls = 0;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push(`${init.method} ${url}`);
      if (init.method === 'POST') return new Response(null, { status: 202, headers: { 'azure-asyncoperation': 'https://management.azure.com/op/1' } });
      return json({ status: ++polls < 2 ? 'InProgress' : 'Succeeded' });
    }) as unknown as typeof fetch;
    const arm = new HttpArmClient({ credential, fetchImpl, sleep: async () => undefined });
    await arm.send('POST', '/vm/deallocate');
    expect(polls).toBe(2);
  });

  it('throws when the operation fails', async () => {
    const fetchImpl = (async (_url: string, init: RequestInit) =>
      init.method === 'PATCH'
        ? new Response(null, { status: 202, headers: { location: 'https://management.azure.com/op/2' } })
        : json({ status: 'Failed', error: { code: 'AllocationFailed', message: 'no capacity' } })) as unknown as typeof fetch;
    const arm = new HttpArmClient({ credential, fetchImpl, sleep: async () => undefined });
    await expect(arm.send('PATCH', '/vm')).rejects.toMatchObject({ code: 'AllocationFailed' });
  });
});
