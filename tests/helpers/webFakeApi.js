// In-memory fake of the web API client (web/api.js) for UI tests.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const STEPS = ['Validated', 'SnapshotTaken', 'Deallocated', 'Updated', 'Started', 'PostChecked', 'Done'];
const fixture = (name) => JSON.parse(readFileSync(resolve(import.meta.dirname, '../fixtures/web', name), 'utf8'));
const list = (data, key) => (Array.isArray(data) ? data : data?.[key] ?? []);
const suggest = (vm) => (vm ? (vm.vmSize.includes('_E') ? 'Standard_E2s_v6' : 'Standard_D2s_v6') : '');

export function createFakeApi({ tickMs = 10 } = {}) {
  const jobs = new Map();
  let seq = 0;

  function jobView(job) {
    const done = Math.min(Math.floor((Date.now() - job.t0) / tickMs), STEPS.length);
    const completedSteps = STEPS.slice(0, done);
    const failed = job.fail && done >= 4;
    const state = failed ? (job.rolledBack ? 'Restored' : 'Failed') : done >= STEPS.length ? 'Done' : completedSteps.at(-1) ?? 'Validated';
    return {
      ...job.base,
      state,
      completedSteps: failed ? completedSteps.slice(0, 3) : completedSteps,
      error: failed ? 'Simulated failure: VM failed to start on target SKU.' : undefined,
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
    async listSubscriptions() { return list(fixture('subscriptions.json'), 'subscriptions'); },
    async listVms({ retiringOnly } = {}) {
      const vms = list(fixture('vms.json'), 'vms');
      return retiringOnly ? vms.filter((v) => v.retiringSeries) : vms;
    },
    async precheck(vmIds, targetOverrides = {}) {
      const vms = fixture('vms.json').vms;
      const canned = fixture('precheck.json');
      const rank = { PASS: 0, WARN: 1, BLOCK: 2 };
      return vmIds.map((vmId) => {
        const vm = vms.find((v) => v.id === vmId);
        const c = canned[vm?.name] ?? { checks: [{ checkId: 'sku-availability', status: 'PASS', message: 'Target SKU available in region.' }] };
        const overall = c.checks.reduce((w, k) => (rank[k.status] > rank[w] ? k.status : w), 'PASS');
        return { vmId, targetSku: targetOverrides[vmId] ?? c.targetSku ?? suggest(vm), overall, checks: c.checks, ranAt: new Date().toISOString() };
      });
    },
    async startMigration({ vmIds, dryRun, targetOverrides = {} }) {
      const vms = list(fixture('vms.json'), 'vms');
      return vmIds.map((vmId) => {
        const vm = vms.find((v) => v.id === vmId);
        const id = `fake-job-${++seq}`;
        const base = {
          id, startedAt: new Date().toISOString(), error: undefined,
          plan: { vmId, sourceSku: vm?.vmSize, targetSku: targetOverrides[vmId] ?? suggest(vm), dryRun: !!dryRun,
            actions: STEPS.map((step) => ({ step, description: `${step} ${vm?.name ?? ''}`, method: 'POST', url: `https://management.azure.com${vmId}` })) },
        };
        jobs.set(id, { base, t0: Date.now(), fail: /fail/i.test(vm?.name ?? ''), rolledBack: false });
        return { ...base, state: 'Validated', completedSteps: [] };
      });
    },
    async getMigration(id) {
      const j = jobs.get(id);
      if (!j) throw new Error(`Unknown job ${id}`);
      return jobView(j);
    },
    async rollback(id) {
      const j = jobs.get(id);
      if (j) j.rolledBack = true;
      return jobView(j);
    },
  };
}
