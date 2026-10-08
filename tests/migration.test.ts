import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ArmError } from '../src/azure/arm.js';
import type { MigrationJob } from '../src/domain/types.js';
import { FileJobStore, InvalidJobStateError, MemoryJobStore, MigrationEngine, MigrationRefusedError } from '../src/migration/index.js';
import { buildRawVm } from './helpers/fleet.js';
import { createDemoFakeArm } from './helpers/fleet.js';
import { makeEnv, passingPostCheck, vmIdOf } from './helpers/migrationEnv.js';

const writes = (arm: { calls: { method: string }[] }): { method: string; path: string; body?: unknown }[] =>
  (arm.calls as { method: string; path: string; body?: unknown }[]).filter((c) => c.method !== 'GET' && !/ResourceGraph/.test(c.path));

describe('migration engine', () => {
  it('migrates end to end: snapshots, deallocate, single PATCH (size + NVMe), start', async () => {
    const env = makeEnv({ postCheck: passingPostCheck() });
    const id = vmIdOf(env.arm, 'lnx-dsv3-g2-data');
    const [job] = await env.service.start([{ vmId: id }]);
    expect(job?.state).toBe('Queued');
    await env.service.whenIdle();

    const done = env.engine.get(job!.id);
    expect(done.state).toBe('Done');
    expect(done.completedSteps).toEqual(['Validated', 'SnapshotTaken', 'Deallocated', 'Updated', 'Started', 'PostChecked', 'Done']);
    expect(done.snapshots).toHaveLength(3);

    const vm = env.arm.getVm('lnx-dsv3-g2-data');
    expect(vm.properties.hardwareProfile.vmSize).toBe(done.plan.targetSku);
    expect(vm.properties.hardwareProfile.vmSize).not.toBe('Standard_D2s_v3');
    expect(vm.properties.storageProfile.diskControllerType).toBe('NVMe');
    expect(env.arm.powerOf(vm)).toBe('running');

    const w = writes(env.arm);
    expect(w.map((c) => `${c.method} ${/(snapshots|deallocate|start)/.exec(c.path)?.[1] ?? 'vm'}`)).toEqual([
      'PUT snapshots',
      'PUT snapshots',
      'PUT snapshots',
      'POST deallocate',
      'PATCH vm',
      'POST start',
    ]);
    expect((w[4]?.body as { properties: unknown }).properties).toEqual({
      hardwareProfile: { vmSize: done.plan.targetSku },
      storageProfile: { diskControllerType: 'NVMe' },
    });
    expect(done.postCheck?.overall).toBe('PASS');
  });

  it('dry-run lists the exact ARM operations and writes nothing', async () => {
    const env = makeEnv();
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data'), dryRun: true }]);
    expect(job?.plan.dryRun).toBe(true);
    expect(job?.state).toBe('Done');
    expect(writes(env.arm)).toHaveLength(0);
    const ops = job!.plan.actions.filter((a) => a.method && a.method !== 'GET').map((a) => `${a.method} ${a.url?.split('?')[0]?.split('/').slice(-2).join('/')}`);
    expect(ops.slice(-3)).toEqual(['POST lnx-dsv3-g2-data/deallocate', 'PATCH virtualMachines/lnx-dsv3-g2-data', 'POST lnx-dsv3-g2-data/start']);
    expect(job!.plan.actions.filter((a) => a.method === 'PUT')).toHaveLength(3);
    expect(env.engine.get(job!.id).plan.dryRun).toBe(true);
    expect(env.arm.getVm('lnx-dsv3-g2-data').properties.hardwareProfile.vmSize).toBe('Standard_D2s_v3');
  });

  it('rolls back automatically to the original size and controller when start fails', async () => {
    const env = makeEnv();
    const id = vmIdOf(env.arm, 'lnx-fail-sim');
    const [job] = await env.service.start([{ vmId: id }]);
    await env.service.whenIdle();

    const res = env.engine.get(job!.id);
    expect(res.state).toBe('Restored');
    expect(res.error).toMatch(/Allocation failed/);
    expect(res.rollback).toMatchObject({ trigger: 'automatic', succeeded: true });
    const vm = env.arm.getVm('lnx-fail-sim');
    expect(vm.properties.hardwareProfile.vmSize).toBe('Standard_E2s_v3');
    expect(vm.properties.storageProfile.diskControllerType ?? 'SCSI').toBe('SCSI');
    expect(env.arm.powerOf(vm)).toBe('running');
    expect(res.snapshots?.length).toBeGreaterThan(0);
  });

  it('rolls back when the size update is rejected (unavailable target size)', async () => {
    const env = makeEnv();
    env.arm.inject({ method: 'PATCH', match: /lnx-dsv3-g2-data/, times: 1, error: new ArmError('SkuNotAvailable', 409, 'SkuNotAvailable') });
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data') }]);
    await env.service.whenIdle();
    const res = env.engine.get(job!.id);
    expect(res.state).toBe('Restored');
    const vm = env.arm.getVm('lnx-dsv3-g2-data');
    expect(vm.properties.hardwareProfile.vmSize).toBe('Standard_D2s_v3');
    expect(env.arm.powerOf(vm)).toBe('running');
  });

  it('ends Failed with snapshot guidance when rollback itself fails', async () => {
    const env = makeEnv();
    env.arm.inject({ method: 'POST', match: /lnx-fail-sim\/start/, times: 99, error: new ArmError('no capacity', 409, 'AllocationFailed') });
    env.arm.inject({ method: 'PATCH', match: /lnx-fail-sim/, when: (vm) => vm?.properties.hardwareProfile.vmSize !== 'Standard_E2s_v3', error: new ArmError('broken model', 500, 'InternalError') });
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-fail-sim') }]);
    await env.service.whenIdle();
    const res = env.engine.get(job!.id);
    expect(res.state).toBe('Failed');
    expect(res.error).toMatch(/Rollback failed/);
    expect(res.error).toMatch(/snapshots/);
  });

  it('refuses BLOCK pre-checks and creates nothing', async () => {
    const env = makeEnv();
    await expect(env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g1'), targetSku: 'Standard_D2as_v7' }])).rejects.toBeInstanceOf(MigrationRefusedError);
    expect(env.engine.list()).toHaveLength(0);
    expect(writes(env.arm)).toHaveLength(0);
  });

  it('is all-or-nothing for batches containing a blocked VM', async () => {
    const env = makeEnv();
    await expect(
      env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data') }, { vmId: vmIdOf(env.arm, 'lnx-dsv3-g1'), targetSku: 'Standard_D2as_v7' }]),
    ).rejects.toThrow(/lnx-dsv3-g1/);
    expect(env.engine.list()).toHaveLength(0);
  });

  it('refuses outside the maintenance window', async () => {
    const env = makeEnv();
    const options = { maintenanceWindow: { start: '2000-01-01T00:00:00Z', end: '2000-01-02T00:00:00Z' } };
    await expect(env.engine.create({ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data'), options })).rejects.toThrow(/maintenance window/);
  });

  it('keeps a deallocated VM deallocated and skips the deallocate call', async () => {
    const env = makeEnv();
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv2-g2-avs1') }]);
    await env.service.whenIdle();
    expect(env.engine.get(job!.id).state).toBe('Done');
    expect(env.arm.callsTo('POST', '/deallocate')).toHaveLength(0);
    expect(env.arm.callsTo('POST', '/start')).toHaveLength(0);
    expect(env.arm.powerOf(env.arm.getVm('lnx-dsv2-g2-avs1'))).toBe('deallocated');
  });

  it('manual rollback restores a migrated VM', async () => {
    const env = makeEnv();
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data') }]);
    await env.service.whenIdle();
    const rolled = await env.service.rollback(job!.id);
    expect(rolled.state).toBe('Restored');
    expect(rolled.rollback?.trigger).toBe('manual');
    const vm = env.arm.getVm('lnx-dsv3-g2-data');
    expect(vm.properties.hardwareProfile.vmSize).toBe('Standard_D2s_v3');
    expect(vm.properties.storageProfile.diskControllerType).toBe('SCSI');
    expect(env.arm.powerOf(vm)).toBe('running');
    await expect(env.engine.rollback((await env.service.start([{ vmId: vmIdOf(env.arm, 'win-dsv3-g2'), dryRun: true }]))[0]!.id)).rejects.toBeInstanceOf(InvalidJobStateError);
  });

  it('resumes idempotently after a crash and does not repeat finished steps', async () => {
    const base = new MemoryJobStore();
    let armed = true;
    let crashed = false;
    const crashing = {
      save: (j: MigrationJob): void => {
        base.save(j);
        if (armed && (crashed ||= j.state === 'Deallocated')) throw new Error('process crashed');
      },
      load: (id: string) => base.load(id),
      list: () => base.list(),
    };
    const env = makeEnv({ store: crashing });
    const job = await env.engine.create({ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data') });
    await expect(env.engine.run(job.id)).rejects.toThrow(/crashed/);
    expect(base.load(job.id)?.state).toBe('RollingBack');
    const persisted = base.load(job.id)!;
    expect(persisted.completedSteps).toContain('Deallocated');

    // Hard crash: put the record back to what was durable before the process died.
    base.save({ ...persisted, state: 'Deallocated' });
    armed = false;
    const snapshotPuts = env.arm.callsTo('PUT', '/snapshots/').length;
    const resumed = await new MigrationEngine({ ...env.deps, store: base }).run(job.id);
    expect(resumed.state).toBe('Done');
    expect(env.arm.callsTo('PUT', '/snapshots/')).toHaveLength(snapshotPuts);
    expect(env.arm.callsTo('POST', '/deallocate')).toHaveLength(1);
    expect(env.arm.getVm('lnx-dsv3-g2-data').properties.storageProfile.diskControllerType).toBe('NVMe');
  });

  it('deletes snapshots when cleanup is requested', async () => {
    const env = makeEnv({ postCheck: passingPostCheck() });
    const [job] = await env.service.start([{ vmId: vmIdOf(env.arm, 'lnx-dsv3-g2-data'), options: { cleanupSnapshots: true } }]);
    await env.service.whenIdle();
    expect(env.engine.get(job!.id).snapshotsCleaned).toBe(true);
    expect(env.arm.snapshots.size).toBe(0);
    expect(env.arm.callsTo('DELETE', '/snapshots/')).toHaveLength(3);
  });

  it('serializes VMs in the same availability set', async () => {
    const avs = '/subscriptions/00000000-0000-0000-0000-000000000001/resourceGroups/rg-demo/providers/Microsoft.Compute/availabilitySets/avs-x';
    const arm = createDemoFakeArm();
    arm.addVm(buildRawVm({ name: 'a1', size: 'Standard_D2s_v3', availabilitySetId: avs }));
    arm.addVm(buildRawVm({ name: 'a2', size: 'Standard_D2s_v3', availabilitySetId: avs }));
    const env = makeEnv({ arm, concurrency: 3 });
    await env.service.start([{ vmId: vmIdOf(arm, 'a1') }, { vmId: vmIdOf(arm, 'a2') }]);
    await env.service.whenIdle();
    const idx = (re: RegExp): number => arm.calls.findIndex((c) => re.test(c.path) && c.method === 'POST');
    expect(idx(/a1\/start/)).toBeGreaterThan(-1);
    expect(idx(/a1\/start/)).toBeLessThan(idx(/a2\/deallocate/));
  });
});

describe('FileJobStore', () => {
  it('persists jobs atomically as JSON files and rejects unsafe ids', () => {
    const dir = path.join(process.cwd(), 'data', 'jobs', `test-${process.pid}-${Date.now()}`);
    mkdirSync(dir, { recursive: true });
    try {
      const store = new FileJobStore(dir);
      const job = { id: 'abc-123', state: 'Queued', completedSteps: [], startedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', plan: {} } as unknown as MigrationJob;
      store.save(job);
      expect(existsSync(path.join(dir, 'abc-123.json'))).toBe(true);
      expect(store.load('abc-123')?.state).toBe('Queued');
      expect(store.list()).toHaveLength(1);
      expect(store.load('../evil')).toBeUndefined();
      expect(() => store.save({ ...job, id: '../evil' })).toThrow(/Invalid job id/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
