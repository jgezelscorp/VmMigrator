import type { FastifyInstance } from 'fastify';
import { fileURLToPath } from 'node:url';
import { buildApp, type BuildOptions } from './api/index.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 3000;

export function buildServer(opts: BuildOptions = {}): FastifyInstance {
  return buildApp(opts);
}

export async function start(port = Number(process.env['PORT'] ?? DEFAULT_PORT)): Promise<FastifyInstance> {
  const app = buildServer();
  await app.listen({ host: HOST, port });
  console.log(`VmMigrator listening on http://${HOST}:${port}${app.ctx.mock ? ' (VMM_MOCK=1: demo data, no Azure calls)' : ''}`);
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
