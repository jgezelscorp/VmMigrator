import { describe, expect, it } from 'vitest';
import { buildServer } from '../src/server.js';

describe('server', () => {
  it('responds to /api/health', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });
});
