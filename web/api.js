// Thin client for the VmMigrator REST API (live Azure only).
export function createApi({ baseUrl = '', fetchImpl = (...a) => fetch(...a) } = {}) {
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

  const list = (data, key) => (Array.isArray(data) ? data : data?.[key] ?? []);

  return {
    async listSubscriptions() {
      return list(await http('GET', '/api/subscriptions'), 'subscriptions');
    },
    async listVms({ subscriptionId, retiringOnly } = {}) {
      const q = new URLSearchParams();
      if (subscriptionId) q.set('subscriptionId', subscriptionId);
      if (retiringOnly) q.set('retiring', 'true');
      return list(await http('GET', `/api/vms?${q}`), 'vms');
    },
    async precheck(vmIds, targetOverrides = {}, strategy) {
      return list(await http('POST', '/api/vms/precheck', { vmIds, targetOverrides, ...(strategy ? { strategy } : {}) }), 'results');
    },
    async startMigration({ vmIds, dryRun, targetOverrides = {}, options }) {
      const res = await http('POST', '/api/migrations', { vmIds, dryRun, targetOverrides, ...(options ? { options } : {}) });
      return Array.isArray(res) ? res : res.jobs ?? [res];
    },
    async getMigration(id) {
      return http('GET', `/api/migrations/${encodeURIComponent(id)}`);
    },
    async rollback(id) {
      return http('POST', `/api/migrations/${encodeURIComponent(id)}/rollback`);
    },
  };
}
