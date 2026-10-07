import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/index.js';
import { DEMO_SUBSCRIPTION } from '../src/mock/fleet.js';

const mk = () => buildApp({ mock: true, fast: true });
async function waitTerminal(app: ReturnType<typeof mk>, id: string) {
  for (let i = 0; i < 100; i++) {
    const j = (await app.inject({ method: 'GET', url: `/api/migrations/${id}` })).json();
    if (['Done', 'Failed', 'Restored'].includes(j.state)) return j;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timeout');
}

describe('REST API (mock mode)', () => {
  it('serves health, the web UI and openapi', async () => {
    const app = mk();
    expect((await app.inject({ url: '/api/health' })).json()).toEqual({ status: 'ok', mock: true });
    const index = await app.inject({ url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.headers['content-type']).toMatch(/html/);
    expect((await app.inject({ url: '/api/openapi.json' })).json().openapi).toBe('3.0.3');
    expect((await app.inject({ url: '/api/nope' })).statusCode).toBe(404);
    await app.close();
  });

  it('lists subscriptions and VMs', async () => {
    const app = mk();
    const subs = (await app.inject({ url: '/api/subscriptions' })).json().subscriptions;
    expect(subs[0]).toMatchObject({ id: DEMO_SUBSCRIPTION });
    const vms = (await app.inject({ url: `/api/vms?subscriptionId=${DEMO_SUBSCRIPTION}&retiring=true` })).json().vms;
    expect(vms.length).toBeGreaterThan(0);
    expect(vms.every((v: { retiringSeries?: string }) => v.retiringSeries)).toBe(true);
    await app.close();
  });

  it('validates input', async () => {
    const app = mk();
    const r = await app.inject({ method: 'POST', url: '/api/vms/precheck', payload: { vmIds: ['nope'] } });
    expect(r.statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/migrations', payload: {} })).statusCode).toBe(400);
    const bad = await app.inject({ method: 'POST', url: '/api/migrations', payload: '{bad', headers: { 'content-type': 'application/json' } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('BadRequest');
    expect((await app.inject({ url: '/api/migrations/does-not-exist' })).statusCode).toBe(404);
    await app.close();
  });

  it('prechecks, dry-runs and migrates end to end', async () => {
    const app = mk();
    const vms = (await app.inject({ url: '/api/vms?retiring=true' })).json().vms as { id: string; name: string }[];
    const target = vms.find((v) => v.name === 'lnx-dsv3-g2-data')!;
    const pre = (await app.inject({ method: 'POST', url: '/api/vms/precheck', payload: { vmIds: [target.id] } })).json().results;
    expect(pre[0].overall).not.toBe('BLOCK');

    const dry = await app.inject({ method: 'POST', url: '/api/migrations', payload: { vmIds: [target.id], dryRun: true } });
    expect(dry.statusCode).toBe(200);
    expect(dry.json().jobs[0].plan.actions.length).toBeGreaterThan(3);

    const res = await app.inject({ method: 'POST', url: '/api/migrations', payload: { vmIds: [target.id] } });
    expect(res.statusCode).toBe(202);
    const job = await waitTerminal(app, res.json().jobs[0].id);
    expect(job.state).toBe('Done');
    expect(job.postCheck.overall).not.toBe('FAIL');
    expect((await app.inject({ url: '/api/migrations' })).json().jobs.length).toBe(2);
    await app.close();
  });

  it('rolls back automatically on failure and manually on request', async () => {
    const app = mk();
    const vms = (await app.inject({ url: '/api/vms?retiring=true' })).json().vms as { id: string; name: string }[];
    const bad = vms.find((v) => v.name === 'lnx-fail-sim')!;
    const res = await app.inject({ method: 'POST', url: '/api/migrations', payload: { vmIds: [bad.id] } });
    const failed = await waitTerminal(app, res.json().jobs[0].id);
    expect(failed.state).toBe('Restored');

    const good = vms.find((v) => v.name === 'lnx-dsv3-g2-data')!;
    const ok = await app.inject({ method: 'POST', url: '/api/migrations', payload: { vmIds: [good.id] } });
    const id = ok.json().jobs[0].id;
    await waitTerminal(app, id);
    const rb = await app.inject({ method: 'POST', url: `/api/migrations/${id}/rollback`, payload: { reason: 'test' } });
    expect(rb.statusCode).toBe(200);
    expect(rb.json().state).toBe('Restored');
    await app.close();
  });

  it('reports a clear 401 when az is not logged in', async () => {
    const app = buildApp({
      mock: false,
      arm: {
        list: async () => {
          throw Object.assign(new Error('Please run az login'), { name: 'CredentialUnavailableError' });
        },
        get: async () => undefined as never,
        send: async () => undefined as never,
      } as never,
      jobsDir: 'data/jobs/test-api-auth',
    });
    const r = await app.inject({ url: '/api/subscriptions' });
    expect(r.statusCode).toBe(401);
    expect(r.json().error).toBe('NotLoggedIn');
    await app.close();
  });
});
