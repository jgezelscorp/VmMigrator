// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
// @ts-expect-error plain JS module without types
import { init } from '../web/app.js';
// @ts-expect-error plain JS module without types
import { createFakeApi } from './helpers/webFakeApi.js';

const webDir = resolve(import.meta.dirname, '../web');

async function bootstrap() {
  const html = readFileSync(resolve(webDir, 'index.html'), 'utf8');
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/, '');
  const api = createFakeApi({ tickMs: 10 });
  const ctx = await init(document, { pollMs: 5, api });
  return ctx;
}

const $ = (id: string) => document.getElementById(id) as HTMLInputElement & HTMLButtonElement;
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('web UI', () => {
  it('shows busy indicators while an action runs and a progress bar per migration job', async () => {
    await bootstrap();
    $('btn-detect').click();
    expect($('btn-detect').getAttribute('aria-busy')).toBe('true');
    expect($('global-bar').hidden).toBe(false);
    expect($('load-bar').hidden).toBe(false);
    await tick();
    expect($('btn-detect').hasAttribute('aria-busy')).toBe(false);
    expect($('global-bar').hidden).toBe(true);
    expect($('btn-detect').disabled).toBe(false);

    const cb = document.querySelector('#vm-table tbody input[type=checkbox]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    $('btn-dry').click();
    await vi.waitFor(() => expect(document.querySelector('#progress [role=progressbar]')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('#progress [role=progressbar]')!.getAttribute('aria-valuenow')).toMatch(/^\d+$/);
    await vi.waitFor(() => expect(document.querySelector('#progress .badge.Done')).not.toBeNull(), { timeout: 3000 });
    expect(document.querySelector('#progress [role=progressbar]')!.getAttribute('aria-valuenow')).toBe('100');
  });

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

describe('web UI rebuild opt-in', () => {
  it('offers the rebuild checkbox, re-runs the pre-check with the strategy and sends the confirmation', async () => {
    const html = readFileSync(resolve(webDir, 'index.html'), 'utf8');
    document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/, '');
    const vm = { id: '/subscriptions/s/resourceGroups/r/providers/Microsoft.Compute/virtualMachines/win1', name: 'win1', vmSize: 'Standard_D2s_v3', location: 'westeurope', powerState: 'running', retiringSeries: 'Dsv3' };
    const check = (status: string) => ({ checkId: 'temp-disk', status, message: 'temp disk' });
    const prechecks: (string | undefined)[] = [];
    const started: unknown[] = [];
    const api = {
      listSubscriptions: async () => [{ id: 's', name: 's' }],
      listVms: async () => [vm],
      precheck: async (ids: string[], _o: unknown, strategy?: string) => {
        prechecks.push(strategy);
        return ids.map((vmId) => ({ vmId, targetSku: 'Standard_D2as_v7', overall: strategy ? 'WARN' : 'BLOCK', rebuildAvailable: true, ...(strategy ? { strategy } : {}), checks: [check(strategy ? 'WARN' : 'BLOCK')] }));
      },
      startMigration: async (req: unknown) => { started.push(req); return []; },
      getMigration: async () => { throw new Error('unused'); },
      rollback: async () => { throw new Error('unused'); },
    };
    await init(document, { pollMs: 5, api });
    $('btn-all').click();
    await tick();
    const cb = document.querySelector('#vm-table tbody input[type=checkbox]') as HTMLInputElement;
    cb.checked = true;
    cb.dispatchEvent(new Event('change'));
    $('btn-precheck').click();
    await tick();
    expect($('btn-migrate').disabled).toBe(true);

    const opt = document.querySelector('#precheck input[type=checkbox]') as HTMLInputElement;
    opt.checked = true;
    opt.dispatchEvent(new Event('change'));
    await tick();
    expect(prechecks).toEqual([undefined, 'rebuild']);
    expect($('btn-migrate').disabled).toBe(false);

    $('btn-migrate').click();
    expect($('confirm-body').textContent).toContain('REBUILD');
    $('confirm-ack').checked = true;
    $('confirm-ack').dispatchEvent(new Event('change'));
    $('confirm-go').click();
    await tick();
    expect(started).toHaveLength(1);
    expect((started[0] as { options: unknown }).options).toEqual({ strategy: 'rebuild', confirmRebuild: true });
  });

  it('auto-selects SKUs first in the dropdown and shows a comparison popup', async () => {
    await bootstrap();
    expect($('btn-auto-sku').disabled).toBe(true);
    $('btn-all').click();
    await tick(60);
    expect($('btn-auto-sku').disabled).toBe(false);
    $('btn-auto-sku').click();
    await tick(60);
    const sel = document.querySelector('#vm-table tbody select') as HTMLSelectElement;
    expect(sel.options[0]!.value).toBe('Standard_D2as_v7');
    const info = document.querySelector('#vm-table tbody .info-btn') as HTMLButtonElement;
    expect(info.disabled).toBe(false);
    info.click();
    expect($('sku-info').hasAttribute('open')).toBe(true);
    const text = $('sku-info-body').textContent!;
    expect(text).toContain('Quota');
    expect(text).toContain('Zones');
    expect(text).toContain('+17% regional');
    expect(text).toContain('No reservations found.');
  });

  it('downloads a standalone HTML report of the estate', async () => {
    const ctx = await bootstrap();
    $('btn-all').click();
    await tick(60);
    expect($('btn-report').disabled).toBe(false);
    let blob: Blob | undefined;
    (URL as unknown as { createObjectURL: (b: Blob) => string }).createObjectURL = (b) => { blob = b; return 'blob:x'; };
    (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    $('btn-report').click();
    expect(click).toHaveBeenCalled();
    const text = await new Promise<string>((res) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.readAsText(blob!); });
    expect(text).toContain('VM-Migrator estate report');
    expect(text).toContain(ctx.state.vms[0].name);
    click.mockRestore();
  });
});