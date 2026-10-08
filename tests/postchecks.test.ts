import { describe, expect, it } from 'vitest';
import { getVm } from '../src/discovery/discovery.js';
import { createPostCheckHook } from '../src/postchecks/index.js';
import { FakeArm } from './helpers/fakeArm.js';
import { catalog, makeEnv, vmIdOf } from './helpers/migrationEnv.js';
import { createDemoFakeArm } from './helpers/fleet.js';

const hookFor = (arm: FakeArm) =>
  createPostCheckHook({
    arm,
    getVm: (id) => getVm(arm, catalog, id),
    sleep: async () => undefined,
    agentWaitMs: 20,
    agentPollMs: 10,
  });

async function migrate(name: string, options: Record<string, unknown> = {}) {
  const arm = createDemoFakeArm();
  const env = makeEnv({ arm, postCheck: hookFor(arm) });
  const [job] = await env.service.start([{ vmId: vmIdOf(arm, name), options }]);
  await env.service.whenIdle();
  return { arm, env, job: env.engine.get(job!.id) };
}

describe('post-check engine', () => {
  it('passes for a healthy migrated VM', async () => {
    const { job } = await migrate('lnx-dsv3-g2-data');
    expect(job.state).toBe('Done');
    expect(job.postCheck?.overall).not.toBe('FAIL');
    const ids = job.postCheck!.checks.map((c) => c.checkId);
    expect(ids).toEqual(expect.arrayContaining(['provisioning', 'power-state', 'vm-size', 'disk-controller', 'vm-agent', 'extensions', 'disks']));
    expect(job.postCheck!.checks.find((c) => c.checkId === 'vm-size')?.status).toBe('PASS');
  });

  it('FAILs and recommends rollback when the size does not match', async () => {
    const { arm, env, job } = await migrate('lnx-dsv3-g2-data');
    arm.getVm('lnx-dsv3-g2-data').properties.hardwareProfile.vmSize = 'Standard_D2s_v3';
    const res = await hookFor(arm)(job);
    expect(res.overall).toBe('FAIL');
    expect(res.checks.find((c) => c.checkId === 'vm-size')?.status).toBe('FAIL');
    expect(res.recommendation).toContain(`/api/migrations/${job.id}/rollback`);
    expect(env.engine.get(job.id).state).toBe('Done');
  });

  it('FAILs on a failed extension', async () => {
    const { arm, job } = await migrate('lnx-dsv3-g2-data');
    const vm = arm.getVm('lnx-dsv3-g2-data');
    vm.resources = [{ name: 'bad-ext', properties: { provisioningState: 'Failed' } }];
    const res = await hookFor(arm)(job);
    expect(res.checks.find((c) => c.checkId === 'extensions')?.status).toBe('FAIL');
    expect(res.overall).toBe('FAIL');
  });

  it('FAILs when the VM agent is not ready', async () => {
    const { arm, job } = await migrate('lnx-dsv3-g2-data');
    const vm = arm.getVm('lnx-dsv3-g2-data');
    vm.properties.instanceView = { ...(vm.properties.instanceView ?? {}), vmAgent: { statuses: [{ code: 'ProvisioningState/failed', displayStatus: 'Not Ready' }] } };
    const res = await hookFor(arm)(job);
    expect(res.checks.find((c) => c.checkId === 'vm-agent')?.status).toMatch(/FAIL|WARN/);
  });

  it('runs the run-command guest probe when requested', async () => {
    const { arm, job } = await migrate('lnx-dsv3-g2-data', { guestProbe: true });
    expect(job.postCheck?.checks.some((c) => c.checkId === 'guest-probe')).toBe(true);
    expect((arm.calls as { path: string }[]).some((c) => /runCommand/.test(c.path))).toBe(true);
  });
});
