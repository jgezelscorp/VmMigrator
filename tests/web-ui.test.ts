// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module without types
import { init } from '../web/app.js';
// @ts-expect-error plain JS module without types
import { createApi } from '../web/api.js';

const webDir = resolve(import.meta.dirname, '../web');

async function bootstrap() {
  const html = readFileSync(resolve(webDir, 'index.html'), 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/, '');
  const fetchImpl = async (url: string) => ({
    ok: true,
    json: async () => JSON.parse(readFileSync(resolve(webDir, url), 'utf8')),
  });
  const api = createApi({ mock: true, fetchImpl, mockTickMs: 10 });
  const ctx = await init(document, true, { pollMs: 5, api });
  return ctx;
}

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLButtonElement;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('web UI (mock mode)', () => {
  it('detects retiring VMs, prechecks, requires confirmation, and migrates', async () => {
    await bootstrap();
    $('btn-detect').click();
    await tick();
    expect(document.querySelectorAll('#vm-table tbody tr')).toHaveLength(5);

    $('filter').value = 'win-';
    $('filter').dispatchEvent(new Event('input'));
    expect(document.querySelectorAll('#vm-table tbody tr')).toHaveLength(1);

    const cb = document.querySelector('#vm-table tbody input[type=checkbox]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    expect($('btn-migrate').disabled).toBe(true);

    $('btn-precheck').click();
    await tick();
    expect(document.querySelector('#precheck .badge.PASS')).not.toBeNull();
    expect($('btn-migrate').disabled).toBe(false);

    $('btn-migrate').click();
    expect($('confirm').hasAttribute('open')).toBe(true);
    expect($('confirm-go').disabled).toBe(true);
    expect($('confirm-body').textContent).toContain('Standard_D2s_v3 → Standard_D2s_v6');
    $('confirm-ack').checked = true;
    $('confirm-ack').dispatchEvent(new Event('change'));
    $('confirm-go').click();
    await vi.waitFor(() => expect(document.querySelector('#progress .badge.Done')).not.toBeNull(), { timeout: 3000 });
    expect($('progress').textContent).toContain('Post-check');
  });

  it('blocks migration for VMs with BLOCK pre-check', async () => {
    await bootstrap();
    $('btn-detect').click();
    await tick();
    $('filter').value = 'dsv3-g1';
    $('filter').dispatchEvent(new Event('input'));
    const cb = document.querySelector('#vm-table tbody input[type=checkbox]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    $('btn-precheck').click();
    await tick();
    expect(document.querySelector('#precheck .badge.BLOCK')).not.toBeNull();
    expect($('precheck').textContent).toContain('Remediation');
    expect($('btn-migrate').disabled).toBe(true);
  });
});
