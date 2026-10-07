// API client with mock mode (?mock=1) backed by fixtures in web/mock/.
const MOCK_STEPS = ['Validated', 'SnapshotTaken', 'Deallocated', 'Updated', 'Started', 'PostChecked', 'Done'];

export function createApi({ mock = false, baseUrl = '', fetchImpl = (...a) => fetch(...a), mockBase = 'mock/', mockTickMs = 700 } = {}) {
  const jobs = new Map();
  let seq = 0;

  async function http(method, path, body) {
    const res = await fetchImpl(baseUrl + path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message ?? ''; } catch { /* ignore */ }
      throw new Error(`${method} ${path} failed (${res.status}) ${detail}`.trim());
    }
    return res.json();
  }

  async function fixture(name) {
    const res = await fetchImpl(mockBase + name);
    if (!res.ok) throw new Error(`Missing mock fixture ${name}`);
    return res.json();
  }

  const list = (data, key) => (Array.isArray(data) ? data : data?.[key] ?? []);

  async function mockPrecheck(vmIds, targetOverrides = {}) {
    const [vms, canned] = await Promise.all([fixture('vms.json'), fixture('precheck.json')]);
    return vmIds.map((vmId) => {
      const vm = vms.vms.find((v) => v.id === vmId);
      const c = canned[vm?.name] ?? { checks: [{ checkId: 'sku-availability', status: 'PASS', message: 'Target SKU available in region.' }] };
      const rank = { PASS: 0, WARN: 1, BLOCK: 2 };
      const overall = c.checks.reduce((w, k) => (rank[k.status] > rank[w] ? k.status : w), 'PASS');
      return { vmId, targetSku: targetOverrides[vmId] ?? c.targetSku ?? suggest(vm), overall, checks: c.checks, ranAt: new Date().toISOString() };
    });
  }

  function suggest(vm) {
    return vm ? (vm.vmSize.includes('_E') ? 'Standard_E2s_v6' : 'Standard_D2s_v6') : '';
  }

  function mockJob(job) {
    const elapsed = Math.floor((Date.now() - job.t0) / job.tick);
    const done = Math.min(elapsed, MOCK_STEPS.length);
    const completedSteps = MOCK_STEPS.slice(0, done);
    const finished = done >= MOCK_STEPS.length;
    const state = job.fail && done >= 4 ? (job.rolledBack ? 'Restored' : 'Failed') : finished ? 'Done' : completedSteps.at(-1) ?? 'Validated';
    return {
      ...job.base,
      state,
      completedSteps: job.fail && done >= 4 ? completedSteps.slice(0, 3) : completedSteps,
      error: job.fail && done >= 4 ? 'Mock failure: VM failed to start on target SKU.' : undefined,
      updatedAt: new Date().toISOString(),
      postCheck: state === 'Done' && !job.base.plan.dryRun
        ? { vmId: job.base.plan.vmId, overall: 'PASS', ranAt: new Date().toISOString(), checks: [
          { checkId: 'vm-running', status: 'PASS', message: 'VM is running.' },
          { checkId: 'size-applied', status: 'PASS', message: `Size is ${job.base.plan.targetSku}.` },
        ] }
        : undefined,
    };
  }

  return {
    mock,
    async listSubscriptions() {
      if (mock) return list(await fixture('subscriptions.json'), 'subscriptions');
      try { return list(await http('GET', '/api/subscriptions'), 'subscriptions'); } catch { return []; }
    },
    async listVms({ subscriptionId, retiringOnly } = {}) {
      if (mock) {
        const vms = list(await fixture('vms.json'), 'vms');
        return retiringOnly ? vms.filter((v) => v.retiringSeries) : vms;
      }
      const q = new URLSearchParams();
      if (subscriptionId) q.set('subscriptionId', subscriptionId);
      if (retiringOnly) q.set('retiring', 'true');
      return list(await http('GET', `/api/vms?${q}`), 'vms');
    },
    async precheck(vmIds, targetOverrides = {}, strategy) {
      if (mock) return mockPrecheck(vmIds, targetOverrides);
      return list(await http('POST', '/api/vms/precheck', { vmIds, targetOverrides, ...(strategy ? { strategy } : {}) }), 'results');
    },
    async startMigration({ vmIds, dryRun, targetOverrides = {}, options }) {
      if (mock) {
        const vms = list(await fixture('vms.json'), 'vms');
        const created = vmIds.map((vmId) => {
          const vm = vms.find((v) => v.id === vmId);
          const id = `mock-job-${++seq}`;
          const targetSku = targetOverrides[vmId] ?? suggest(vm);
          const base = {
            id, startedAt: new Date().toISOString(), error: undefined,
            plan: { vmId, sourceSku: vm?.vmSize, targetSku, dryRun: !!dryRun, actions: MOCK_STEPS.map((step) => ({ step, description: `${step} ${vm?.name ?? ''}`, method: 'POST', url: `https://management.azure.com${vmId}` })) },
          };
          jobs.set(id, { base, t0: Date.now(), tick: mockTickMs, fail: /fail/i.test(vm?.name ?? ''), rolledBack: false });
          return { ...base, state: 'Validated', completedSteps: [] };
        });
        return created;
      }
      const res = await http('POST', '/api/migrations', { vmIds, dryRun, targetOverrides, ...(options ? { options } : {}) });
      return Array.isArray(res) ? res : res.jobs ?? [res];
    },
    async getMigration(id) {
      if (mock) {
        const j = jobs.get(id);
        if (!j) throw new Error(`Unknown job ${id}`);
        return mockJob(j);
      }
      return http('GET', `/api/migrations/${encodeURIComponent(id)}`);
    },
    async rollback(id) {
      if (mock) {
        const j = jobs.get(id);
        if (j) j.rolledBack = true;
        return mockJob(j);
      }
      return http('POST', `/api/migrations/${encodeURIComponent(id)}/rollback`);
    },
  };
}
