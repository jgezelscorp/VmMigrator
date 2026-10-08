import { describe, expect, it } from 'vitest';
import { ArmError } from '../src/azure/arm.js';
import { MigrationRefusedError } from '../src/migration/index.js';
import { buildRawVm, createDemoFakeArm } from './helpers/fleet.js';
import { makeEnv, passingPostCheck, vmIdOf } from './helpers/migrationEnv.js';

const WIN_TARGET = 'Standard_D2as_v7';
const writes = (arm: { calls: { method: string; path: string }[] }): string[] =>
  arm.calls
    .filter((c) => c.method !== 'GET' && !/ResourceGraph/.test(c.path))
    .map((c) => `${c.method} ${/(snapshots|disks|extensions|runCommand|deallocate|start)\//i.exec(c.path)?.[1] ?? /(snapshots|disks|extensions|runCommand|deallocate|start)\b/i.exec(c.path)?.[1] ?? 'vm'}`);

function windowsEnv(power = 'running') {
  const arm = createDemoFakeArm();
  const vm = arm.getVm('win-dsv3-g2');
  vm.tags = { owner: 'qa', purpose: 'vmmigrator-demo' };
  vm.zones = ['1'];
  vm.identity = { type: 'SystemAssigned' };
  vm.properties.storageProfile.osDisk.deleteOption = 'Delete';
  vm.properties.networkProfile.networkInterfaces[0].properties = { deleteOption: 'Delete' };
  vm.resources = [{ name: 'AzureMonitorWindowsAgent', properties: { publisher: 'Microsoft.Azure.Monitor', type: 'AzureMonitorWindowsAgent', typeHandlerVersion: '1.0', autoUpgradeMinorVersion: true } }];
  if (power !== 'running') vm.properties.instanceView.statuses = [{ code: 'ProvisioningState/succeeded' }, { code: `PowerState/${power}` }];
  return { arm, env: makeEnv({ arm, postCheck: passingPostCheck() }) };
}

describe('pre-check: rebuild strategy', () => {
  it('blocks Windows temp-disk -> diskless v7 in-place but offers rebuild as WARN-only when requested', async () => {
    const { arm, env } = windowsEnv();
    const vm = await env.deps.getVm(vmIdOf(arm, 'win-dsv3-g2'));
    const inPlace = await env.deps.preCheck(vm, WIN_TARGET);
    expect(inPlace.overall).toBe('BLOCK');
    expect(inPlace.checks.find((c) => c.checkId === 'temp-disk')?.status).toBe('BLOCK');
    expect(inPlace.rebuildAvailable).toBe(true);
    expect(inPlace.rebuildKind).toBe('recreate');

    const rebuild = await env.deps.preCheck(vm, WIN_TARGET, { strategy: 'rebuild' });
    expect(rebuild.overall).toBe('WARN');
    expect(rebuild.strategy).toBe('rebuild');
    expect(rebuild.checks.find((c) => c.checkId === 'temp-disk')?.status).toBe('WARN');
    expect(rebuild.checks.find((c) => c.checkId === 'rebuild-strategy')?.status).toBe('WARN');
  });

  it('offers the Gen1 upgrade for a Canonical Linux Gen1 VM', async () => {
    const env = makeEnv();
    const vm = await env.deps.getVm(vmIdOf(env.arm, 'lnx-dsv3-g1'));
    const pre = await env.deps.preCheck(vm, WIN_TARGET, { strategy: 'rebuild' });
    expect(pre.overall).toBe('WARN');
    expect(pre.rebuildKind).toBe('gen1-upgrade');
    expect(pre.checks.find((c) => c.checkId === 'generation')?.status).toBe('WARN');
  });

  it('keeps BLOCK when rebuild is not possible (Windows Gen1)', async () => {
    const arm = createDemoFakeArm();
    arm.addVm(buildRawVm({ name: 'win-g1', size: 'Standard_D2s_v3', os: 'Windows', gen: 'V1' }));
    const env = makeEnv({ arm });
    const vm = await env.deps.getVm(vmIdOf(arm, 'win-g1'));
    const pre = await env.deps.preCheck(vm, WIN_TARGET, { strategy: 'rebuild' });
    expect(pre.overall).toBe('BLOCK');
    expect(pre.rebuildAvailable).toBeFalsy();
  });
});

describe('rebuild migration: Windows temp disk -> diskless v7', () => {
  it('requires explicit confirmation and snapshots', async () => {
    const { arm, env } = windowsEnv();
    const vmId = vmIdOf(arm, 'win-dsv3-g2');
    await expect(env.engine.plan({ vmId, targetSku: WIN_TARGET, options: { strategy: 'rebuild' } })).rejects.toThrow(MigrationRefusedError);
    await expect(env.engine.plan({ vmId, targetSku: WIN_TARGET, options: { strategy: 'rebuild', confirmRebuild: true, skipSnapshots: true } })).rejects.toThrow(MigrationRefusedError);
    expect(arm.calls.filter((c) => c.method !== 'GET' && !/ResourceGraph/.test(c.path))).toHaveLength(0);
  });

  it('dry-run lists the rebuild operations and writes nothing', async () => {
    const { arm, env } = windowsEnv();
    const [job] = await env.service.start([{ vmId: vmIdOf(arm, 'win-dsv3-g2'), targetSku: WIN_TARGET, dryRun: true, options: { strategy: 'rebuild' } }]);
    expect(job?.plan.strategy).toBe('rebuild');
    expect(job?.plan.rebuildKind).toBe('recreate');
    expect(arm.calls.filter((c) => c.method !== 'GET' && !/ResourceGraph/.test(c.path))).toHaveLength(0);
    const ops = job!.plan.actions.filter((a) => a.method).map((a) => `${a.step}:${a.method}`);
    expect(ops).toEqual(expect.arrayContaining(['Prepared:POST', 'Rebuilt:PUT', 'Rebuilt:DELETE']));
    expect(job!.plan.actions.some((a) => a.step === 'Updated')).toBe(false);
  });

  it('recreates the VM on new disks, keeping NICs, tags, zone, identity, extensions and the original disks', async () => {
    const { arm, env } = windowsEnv();
    const before = arm.getVm('win-dsv3-g2');
    const nic = before.properties.networkProfile.networkInterfaces[0].id as string;
    const origOs = before.properties.storageProfile.osDisk.managedDisk.id as string;
    const [job] = await env.service.start([{ vmId: vmIdOf(arm, 'win-dsv3-g2'), targetSku: WIN_TARGET, options: { strategy: 'rebuild', confirmRebuild: true } }]);
    await env.service.whenIdle();

    const done = env.engine.get(job!.id);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('Done');
    expect(done.completedSteps).toEqual(['Validated', 'Prepared', 'SnapshotTaken', 'Deallocated', 'Rebuilt', 'Started', 'PostChecked', 'Done']);

    const vm = arm.getVm('win-dsv3-g2');
    expect(vm.properties.hardwareProfile.vmSize).toBe(WIN_TARGET);
    expect(vm.properties.storageProfile.diskControllerType).toBe('NVMe');
    expect(vm.properties.networkProfile.networkInterfaces[0].id).toBe(nic);
    expect(vm.tags).toEqual({ owner: 'qa', purpose: 'vmmigrator-demo' });
    expect(vm.zones).toEqual(['1']);
    expect(vm.identity.type).toBe('SystemAssigned');
    expect(vm.properties.storageProfile.osDisk.createOption).toBe('Attach');
    expect(vm.properties.storageProfile.osDisk.managedDisk.id).toMatch(/win-dsv3-g2-os-rb-/);
    expect(vm.properties.osProfile).toBeUndefined();
    expect(vm.resources.map((r: { name: string }) => r.name)).toEqual(['AzureMonitorWindowsAgent']);
    expect(arm.powerOf(vm)).toBe('running');

    // Original OS disk was kept (detached), not deleted, even though deleteOption was Delete
    expect(arm.disks.has(origOs.toLowerCase())).toBe(true);
    expect(arm.callsTo('PATCH', 'virtualMachines/win-dsv3-g2').length).toBeGreaterThan(0);
    expect(arm.callsTo('POST', 'runCommand')).toHaveLength(1);

    const w = writes(arm);
    expect(w.indexOf('PUT snapshots')).toBeLessThan(w.indexOf('POST deallocate'));
    expect(w.indexOf('POST deallocate')).toBeLessThan(w.indexOf('DELETE vm'));
    expect(w.indexOf('DELETE vm')).toBeLessThan(w.lastIndexOf('PUT vm'));
  });

  it('removes the original disks on cleanup only after a successful rebuild', async () => {
    const { arm, env } = windowsEnv();
    const origOs = (arm.getVm('win-dsv3-g2').properties.storageProfile.osDisk.managedDisk.id as string).toLowerCase();
    const [job] = await env.service.start([{ vmId: vmIdOf(arm, 'win-dsv3-g2'), targetSku: WIN_TARGET, options: { strategy: 'rebuild', confirmRebuild: true, cleanupSnapshots: true } }]);
    await env.service.whenIdle();
    expect(env.engine.get(job!.id).state).toBe('Done');
    expect(arm.disks.has(origOs)).toBe(false);
    expect(arm.snapshots.size).toBe(0);
  });

  it('leaves a VM that was deallocated deallocated and skips the pagefile script', async () => {
    const { arm, env } = windowsEnv('deallocated');
    const [job] = await env.service.start([{ vmId: vmIdOf(arm, 'win-dsv3-g2'), targetSku: WIN_TARGET, options: { strategy: 'rebuild', confirmRebuild: true } }]);
    await env.service.whenIdle();
    expect(env.engine.get(job!.id).state).toBe('Done');
    expect(arm.callsTo('POST', 'runCommand')).toHaveLength(0);
    expect(arm.powerOf(arm.getVm('win-dsv3-g2'))).toBe('deallocated');
  });

  it('recreates the original VM from the original disks when the new VM cannot be created', async () => {
    const { arm, env } = windowsEnv();
    const origOs = (arm.getVm('win-dsv3-g2').properties.storageProfile.osDisk.managedDisk.id as string).toLowerCase();
    // fail the first VM PUT (after the delete); the rollback PUT then succeeds
    arm.inject({ method: 'PUT', match: /virtualMachines\/win-dsv3-g2\?/, times: 1, when: (vm) => vm === undefined, error: new ArmError('Allocation failed (simulated)', 409, 'AllocationFailed') });
    const [job] = await env.service.start([{ vmId: vmIdOf(arm, 'win-dsv3-g2'), targetSku: WIN_TARGET, options: { strategy: 'rebuild', confirmRebuild: true } }]);
    await env.service.whenIdle();

    const res = env.engine.get(job!.id);
    expect(res.state).toBe('Restored');
    expect(res.rollback).toMatchObject({ trigger: 'automatic', succeeded: true });
    const vm = arm.getVm('win-dsv3-g2');
    expect(vm.properties.hardwareProfile.vmSize).toBe('Standard_D2s_v3');
    expect(vm.properties.storageProfile.diskControllerType ?? 'SCSI').toBe('SCSI');
    expect(vm.properties.storageProfile.osDisk.managedDisk.id.toLowerCase()).toBe(origOs);
    expect(arm.powerOf(vm)).toBe('running');
    expect(vm.zones).toEqual(['1']);
    expect([...arm.disks.keys()].filter((k) => k.includes('-rb-'))).toEqual([]);
  });
});

describe('rebuild migration: Gen1 -> Trusted launch (Gen2) upgrade', () => {
  const opts = { strategy: 'rebuild', confirmRebuild: true } as const;

  it('upgrades in place to Trusted launch, then resizes to the Gen2-only NVMe size', async () => {
    const env = makeEnv({ postCheck: passingPostCheck() });
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g1'), targetSku: WIN_TARGET, options: opts }]);
    await env.service.whenIdle();

    const done = env.engine.get(job!.id);
    expect(done.error).toBeUndefined();
    expect(done.state).toBe('Done');
    expect(done.plan.rebuildKind).toBe('gen1-upgrade');
    const vm = env.arm.getVm('lnx-dsv3-g1');
    expect(vm.properties.securityProfile.securityType).toBe('TrustedLaunch');
    expect(vm.properties.instanceView.hyperVGeneration).toBe('V2');
    expect(vm.properties.hardwareProfile.vmSize).toBe(WIN_TARGET);
    expect(vm.properties.storageProfile.diskControllerType).toBe('NVMe');
    expect(env.arm.callsTo('DELETE', 'virtualMachines/lnx-dsv3-g1')).toHaveLength(0);
    expect(env.arm.powerOf(vm)).toBe('running');
  });

  it('rollback recreates the Gen1 VM from the snapshots because the upgrade is not reversible', async () => {
    const env = makeEnv({ postCheck: passingPostCheck() });
    env.arm.inject({ method: 'POST', match: /virtualMachines\/lnx-dsv3-g1\/start/i, times: 1, error: new ArmError('Allocation failed (simulated)', 409, 'AllocationFailed') });
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g1'), targetSku: WIN_TARGET, options: opts }]);
    await env.service.whenIdle();

    const res = env.engine.get(job!.id);
    expect(res.state).toBe('Restored');
    const vm = env.arm.getVm('lnx-dsv3-g1');
    expect(vm.properties.instanceView.hyperVGeneration).toBe('V1');
    expect(vm.properties.hardwareProfile.vmSize).toBe('Standard_D2s_v3');
    expect(vm.properties.storageProfile.osDisk.managedDisk.id).toMatch(/-orig-/);
    expect(env.arm.powerOf(vm)).toBe('running');
  });

  it('refuses Gen1 VMs whose image is not on the supported publisher list', async () => {
    const arm = createDemoFakeArm();
    arm.getVm('lnx-dsv3-g1').properties.storageProfile.imageReference.publisher = 'credativ';
    const env = makeEnv({ arm });
    const vm = await env.deps.getVm(vmIdOf(arm, 'lnx-dsv3-g1'));
    const pre = await env.deps.preCheck(vm, WIN_TARGET, { strategy: 'rebuild' });
    expect(pre.overall).toBe('BLOCK');
  });
});
