import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapLimit } from '../discovery/discovery.js';
import type { MigrationJob, MigrationJobOptions } from '../domain/types.js';
import { InvalidJobStateError, JobNotFoundError, MigrationRefusedError, isTerminal } from '../migration/index.js';
import { createContext, type AppContext, type ContextOptions } from './context.js';
import { OPENAPI } from './openapi.js';

class BadRequest extends Error {}

const ID_RE = /^\/subscriptions\/[^/]+\/resourcegroups\/[^/]+\/providers\/microsoft\.compute\/virtualmachines\/[^/]+$/i;

function findWebDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'web');
    if (existsSync(path.join(candidate, 'index.html'))) return candidate;
    dir = path.dirname(dir);
  }
  return undefined;
}

function vmIdsOf(body: unknown): string[] {
  const ids = (body as { vmIds?: unknown } | undefined)?.vmIds;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === 'string')) {
    throw new BadRequest('vmIds must be a non-empty array of VM resource ids');
  }
  const bad = (ids as string[]).find((i) => !ID_RE.test(i));
  if (bad) throw new BadRequest(`Not a virtual machine resource id: ${bad}`);
  return ids as string[];
}

function overridesOf(body: unknown): Record<string, string> {
  const o = (body as { targetOverrides?: unknown } | undefined)?.targetOverrides ?? {};
  if (typeof o !== 'object' || o === null || Array.isArray(o) || !Object.values(o).every((v) => typeof v === 'string')) {
    throw new BadRequest('targetOverrides must be an object of vmId -> target SKU');
  }
  return o as Record<string, string>;
}

function optionsOf(body: unknown): MigrationJobOptions {
  const o = (body as { options?: unknown } | undefined)?.options;
  if (o === undefined) return {};
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new BadRequest('options must be an object');
  const r = o as Record<string, unknown>;
  const out: MigrationJobOptions = {};
  for (const k of ['cleanupSnapshots', 'skipSnapshots', 'guestProbe', 'autoRollbackOnPostCheckFail', 'confirmRebuild', 'movePagefile'] as const) {
    if (r[k] !== undefined) {
      if (typeof r[k] !== 'boolean') throw new BadRequest(`options.${k} must be a boolean`);
      out[k] = r[k] as boolean;
    }
  }
  if (r['strategy'] !== undefined) {
    if (r['strategy'] !== 'inPlace' && r['strategy'] !== 'rebuild') throw new BadRequest("options.strategy must be 'inPlace' or 'rebuild'");
    out.strategy = r['strategy'];
  }
  const w = r['maintenanceWindow'] as { start?: unknown; end?: unknown } | undefined;
  if (w !== undefined) {
    if (typeof w.start !== 'string' || typeof w.end !== 'string' || Number.isNaN(Date.parse(w.start)) || Number.isNaN(Date.parse(w.end))) {
      throw new BadRequest('options.maintenanceWindow needs ISO start and end');
    }
    out.maintenanceWindow = { start: w.start, end: w.end };
  }
  return out;
}

function sendError(reply: FastifyReply, e: unknown): FastifyReply {
  const message = e instanceof Error ? e.message : String(e);
  if (e instanceof BadRequest) return reply.code(400).send({ error: 'BadRequest', message });
  if (e instanceof JobNotFoundError) return reply.code(404).send({ error: 'NotFound', message });
  if (e instanceof MigrationRefusedError) return reply.code(409).send({ error: 'MigrationBlocked', message });
  if (e instanceof InvalidJobStateError) return reply.code(409).send({ error: 'InvalidState', message });
  const fst = e as { code?: unknown; statusCode?: unknown };
  if (typeof fst.code === 'string' && fst.code.startsWith('FST_') && typeof fst.statusCode === 'number' && fst.statusCode >= 400 && fst.statusCode < 500) {
    return reply.code(fst.statusCode).send({ error: 'BadRequest', message });
  }
  const name = e instanceof Error ? e.name : '';
  if (/CredentialUnavailable|AuthenticationRequired|AzureCliCredential/i.test(name + message) || /az login|Please run 'az/i.test(message)) {
    return reply.code(401).send({
      error: 'NotLoggedIn',
      message: 'Azure credentials are not available. Run "az login" in a terminal and retry.',
    });
  }
  const status = (e as { status?: number }).status;
  if (typeof status === 'number' && status >= 400 && status < 600) {
    return reply.code(status === 401 || status === 403 ? status : 502).send({ error: 'AzureError', message });
  }
  return reply.code(500).send({ error: 'InternalError', message });
}

export interface BuildOptions extends ContextOptions {
  ctx?: AppContext;
  logger?: boolean;
}

export function buildApp(opts: BuildOptions = {}): FastifyInstance {
  const app = Fastify({ logger: opts.logger ?? false });
  const ctx = opts.ctx ?? createContext(opts);
  app.decorate('ctx', ctx);
  app.setErrorHandler((e, _req, reply) => sendError(reply, e));

  app.get('/api/health', async () => ({ status: 'ok' }));
  app.get('/api/openapi.json', async () => OPENAPI);

  app.get('/api/subscriptions', async () => {
    const subs = await ctx.arm.list<{ subscriptionId: string; displayName?: string; state?: string }>('/subscriptions?api-version=2022-12-01');
    return {
      subscriptions: subs.filter((s) => !s.state || s.state === 'Enabled').map((s) => ({ id: s.subscriptionId, name: s.displayName ?? s.subscriptionId })),
    };
  });

  app.get<{ Querystring: { subscriptionId?: string; retiring?: string } }>('/api/vms', async (req) => {
    const { subscriptionId, retiring } = req.query;
    const vms = await ctx.discover({
      ...(subscriptionId ? { subscriptionIds: subscriptionId.split(',').filter(Boolean) } : {}),
      retiringOnly: /^(1|true)$/i.test(retiring ?? ''),
    });
    return { vms };
  });

  app.post('/api/vms/precheck', async (req) => {
    const ids = vmIdsOf(req.body);
    const overrides = overridesOf(req.body);
    const strategy = optionsOf({ options: { strategy: (req.body as { strategy?: unknown }).strategy } }).strategy;
    const results = await mapLimit(ids, 3, async (id) => ctx.preCheck(await ctx.getVm(id), overrides[id], strategy ? { strategy } : undefined));
    return { results };
  });

  app.post('/api/vms/sku-advice', async (req) => {
    const ids = vmIdsOf(req.body);
    const vms = await mapLimit(ids, 3, async (id) => ctx.getVm(id));
    return { advice: await ctx.advise(vms) };
  });

  app.post('/api/migrations', async (req, reply) => {
    const ids = vmIdsOf(req.body);
    const overrides = overridesOf(req.body);
    const options = optionsOf(req.body);
    const dryRun = (req.body as { dryRun?: unknown }).dryRun === true;
    const jobs = await ctx.service.start(
      ids.map((vmId) => ({ vmId, dryRun, options, ...(overrides[vmId] ? { targetSku: overrides[vmId] } : {}) })),
    );
    return reply.code(dryRun ? 200 : 202).send({ jobs });
  });

  app.get('/api/migrations', async () => ({
    jobs: ctx.engine.list().sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? '')),
  }));

  app.get<{ Params: { id: string } }>('/api/migrations/:id', async (req) => ctx.engine.get(req.params.id));

  app.post<{ Params: { id: string } }>('/api/migrations/:id/rollback', async (req) => {
    const body = (req.body ?? {}) as { reason?: unknown };
    return ctx.service.rollback(req.params.id, typeof body.reason === 'string' ? body.reason : undefined);
  });

  app.post<{ Params: { id: string } }>('/api/migrations/:id/cleanup', async (req) => ctx.engine.cleanupSnapshots(req.params.id));

  // Server-sent events: pushes the job whenever it changes, ends when it reaches a terminal state
  app.get<{ Params: { id: string } }>('/api/migrations/:id/events', async (req, reply) => {
    ctx.engine.get(req.params.id);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    let last = '';
    let closed = false;
    req.raw.on('close', () => {
      closed = true;
    });
    const push = (job: MigrationJob): void => {
      const s = JSON.stringify(job);
      if (s !== last) {
        last = s;
        res.write(`event: job\ndata: ${s}\n\n`);
      }
    };
    while (!closed) {
      let job: MigrationJob;
      try {
        job = ctx.engine.get(req.params.id);
      } catch {
        break;
      }
      push(job);
      if (isTerminal(job.state) && !ctx.service.isBusy(job.id)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    res.end();
  });

  const web = findWebDir();
  if (web) {
    void app.register(fastifyStatic, { root: web, prefix: '/' });
  }
  app.setNotFoundHandler((req, reply) => {
    void reply.code(404).send({ error: 'NotFound', message: `Route ${req.method} ${req.url} not found` });
  });

  app.addHook('onReady', async () => {
    ctx.service.resumeIncomplete();
  });
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    ctx: AppContext;
  }
}
