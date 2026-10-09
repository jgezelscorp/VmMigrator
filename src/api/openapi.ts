export const OPENAPI = {
  openapi: '3.0.3',
  info: { title: 'VmMigrator API', version: '0.1.0', description: 'Discover, pre-check, migrate and verify Azure VMs on retiring series. Binds to 127.0.0.1 only.' },
  paths: {
    '/api/health': { get: { summary: 'Liveness' } },
    '/api/subscriptions': { get: { summary: 'Subscriptions visible to the az login: { subscriptions: [{id,name}] }' } },
    '/api/vms': {
      get: {
        summary: 'Discover VMs: { vms: VmInfo[] }',
        parameters: [
          { name: 'subscriptionId', in: 'query', schema: { type: 'string' }, description: 'Comma separated; default all' },
          { name: 'retiring', in: 'query', schema: { type: 'boolean' } },
        ],
      },
    },
    '/api/vms/precheck': { post: { summary: 'Body { vmIds[], targetOverrides?, strategy?: inPlace or rebuild } -> { results: PreCheckResult[] }' } },
    '/api/settings': { get: { summary: '{ settings, defaults } editable pricing model: series lifecycle dates + uplift %, region uplift %' }, put: { summary: 'Body PricingSettings -> { settings } validate, persist and apply' } },
    '/api/settings/reset': { post: { summary: 'Restore default settings -> { settings }' } },
    '/api/vms/sku-advice': { post: { summary: 'Body { vmIds[] } -> { advice: SkuAdvice[] } best target SKU per VM with quota, zone, cost (incl. 1 Feb 2027 lifecycle/regional price changes) , 1/3-year reservation monthly prices (current/proposed) and reservation analysis' } },
    '/api/migrations': {
      get: { summary: 'List jobs: { jobs }' },
      post: { summary: 'Body { vmIds[], dryRun?, targetOverrides?, options? { cleanupSnapshots, skipSnapshots, guestProbe, autoRollbackOnPostCheckFail, strategy: inPlace or rebuild, confirmRebuild (required for a real rebuild), movePagefile } } -> 202 { jobs } (200 for dryRun); 409 when a pre-check BLOCKs' },
    },
    '/api/migrations/{id}': { get: { summary: 'Job incl. plan, state, completedSteps, snapshots, events, postCheck, rollback' } },
    '/api/migrations/{id}/rollback': { post: { summary: 'Restore original size/controller; 409 while running or when nothing to roll back' } },
    '/api/migrations/{id}/cleanup': { post: { summary: 'Delete snapshots created by the job' } },
    '/api/migrations/{id}/events': { get: { summary: 'Server-sent events (event: job) until a terminal state' } },
  },
} as const;
