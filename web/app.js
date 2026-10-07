import { createApi } from './api.js';

const SKU_CHOICES = [
  'Standard_D2s_v6', 'Standard_D4s_v6', 'Standard_D2s_v5', 'Standard_D4s_v5', 'Standard_D2s_v7', 'Standard_D4s_v7',
  'Standard_E2s_v6', 'Standard_E4s_v6', 'Standard_E2s_v5', 'Standard_E4s_v5', 'Standard_F2s_v2', 'Standard_F4s_v2',
];
const POLL_MS = 1500;

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) el.append(kid instanceof Node ? kid : String(kid ?? ''));
  return el;
}
const badge = (s, label = s) => h('span', { class: `badge ${s}` }, label);

export function suggestTarget(vm) {
  const fam = /_(D|E|F)/.exec(vm.vmSize)?.[1] ?? 'D';
  return fam === 'F' ? 'Standard_F2s_v2' : `Standard_${fam}2s_v6`;
}

export function init(doc, mock, { pollMs = POLL_MS, api } = {}) {
  const $ = (id) => doc.getElementById(id);
  const client = api ?? createApi({ mock });
  const state = { vms: [], selected: new Set(), targets: {}, prechecks: {}, polling: new Map(), jobs: new Map() };
  if (mock) $('mock-badge').hidden = false;

  const showError = (e) => { $('error').hidden = !e; $('error').textContent = e ? (e.message ?? String(e)) : ''; };
  const subId = () => $('sub-text').value.trim() || $('sub').value;

  async function load(retiringOnly) {
    showError(null);
    try {
      state.vms = await client.listVms({ subscriptionId: subId(), retiringOnly });
      state.selected.clear();
      state.prechecks = {};
      $('precheck').replaceChildren();
      renderTable();
    } catch (e) { showError(e); }
  }

  function filtered() {
    const q = $('filter').value.trim().toLowerCase();
    if (!q) return state.vms;
    return state.vms.filter((v) => [v.name, v.vmSize, v.location, v.retiringSeries, v.resourceGroup, v.powerState]
      .some((x) => (x ?? '').toLowerCase().includes(q)));
  }

  function skuSelect(vm) {
    const current = state.targets[vm.id] ?? state.prechecks[vm.id]?.targetSku ?? suggestTarget(vm);
    const opts = [...new Set([current, ...SKU_CHOICES])];
    return h('select', {
      'aria-label': `Target SKU for ${vm.name}`,
      onchange: (e) => { state.targets[vm.id] = e.target.value; delete state.prechecks[vm.id]; updateButtons(); },
    }, opts.map((s) => h('option', { value: s, selected: s === current }, s)));
  }

  function renderTable() {
    const rows = filtered();
    $('count').textContent = `${rows.length} of ${state.vms.length} VMs, ${state.selected.size} selected`;
    $('vm-table').querySelector('tbody').replaceChildren(...rows.map((vm) => h('tr', {},
      h('td', {}, h('input', {
        type: 'checkbox', 'aria-label': `Select ${vm.name}`, checked: state.selected.has(vm.id),
        onchange: (e) => { e.target.checked ? state.selected.add(vm.id) : state.selected.delete(vm.id); renderTable(); },
      })),
      h('td', {}, vm.name),
      h('td', {}, vm.retiringSeries ?? '—'),
      h('td', {}, vm.vmSize),
      h('td', {}, vm.location),
      h('td', {}, vm.retirementDate ?? '—'),
      h('td', {}, badge(vm.powerState), ' ', vm.retiringSeries ? badge('warn', 'retiring') : ''),
      h('td', {}, skuSelect(vm)),
    )));
    updateButtons();
  }

  const targetFor = (id) => state.targets[id] ?? state.prechecks[id]?.targetSku ?? suggestTarget(state.vms.find((v) => v.id === id));
  const overrides = () => Object.fromEntries([...state.selected].map((id) => [id, targetFor(id)]));
  const blocked = () => [...state.selected].some((id) => state.prechecks[id]?.overall === 'BLOCK');
  const prechecked = () => [...state.selected].every((id) => state.prechecks[id]);

  function updateButtons() {
    const any = state.selected.size > 0;
    $('btn-precheck').disabled = !any;
    $('btn-dry').disabled = !any;
    $('btn-migrate').disabled = !any || !prechecked() || blocked();
    $('btn-migrate').title = !any ? 'Select VMs first' : !prechecked() ? 'Run pre-check first' : blocked() ? 'Blocked VMs selected' : '';
  }

  function renderPrecheck() {
    $('precheck').replaceChildren(...[...state.selected].map((id) => {
      const r = state.prechecks[id];
      const vm = state.vms.find((v) => v.id === id);
      if (!r) return '';
      return h('div', { class: 'card' },
        h('h3', {}, vm?.name ?? id, ' → ', r.targetSku, ' ', badge(r.overall)),
        h('ul', {}, r.checks.map((c) => h('li', {}, badge(c.status), ` ${c.checkId}: ${c.message}`,
          c.remediation ? h('div', { class: 'remed' }, `Remediation: ${c.remediation}`) : ''))));
    }));
  }

  async function runPrecheck() {
    showError(null);
    try {
      const results = await client.precheck([...state.selected], overrides());
      for (const r of results) { state.prechecks[r.vmId] = r; state.targets[r.vmId] = r.targetSku; }
      renderPrecheck(); renderTable();
    } catch (e) { showError(e); }
  }

  function confirmMigration() {
    const dlg = $('confirm');
    const ack = $('confirm-ack');
    const go = $('confirm-go');
    ack.checked = false; go.disabled = true;
    $('confirm-body').replaceChildren(h('ul', {}, [...state.selected].map((id) => {
      const vm = state.vms.find((v) => v.id === id);
      const r = state.prechecks[id];
      return h('li', {}, `${vm.name}: ${vm.vmSize} → ${targetFor(id)}`, r?.overall === 'WARN' ? ' (has warnings)' : '');
    })));
    return new Promise((resolve) => {
      const done = (ok) => { dlg.removeAttribute('open'); ack.onchange = null; go.onclick = null; $('confirm').querySelector('button[value=cancel]').onclick = null; resolve(ok); };
      ack.onchange = () => { go.disabled = !ack.checked; };
      go.onclick = (e) => { e.preventDefault(); if (ack.checked) done(true); };
      dlg.querySelector('button[value=cancel]').onclick = (e) => { e.preventDefault(); done(false); };
      if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    });
  }

  async function startMigration(dryRun) {
    if (!dryRun && !(await confirmMigration())) return;
    showError(null);
    try {
      const jobs = await client.startMigration({ vmIds: [...state.selected], dryRun, targetOverrides: overrides() });
      for (const j of jobs) { state.jobs.set(j.id, j); poll(j.id); }
      renderProgress();
    } catch (e) { showError(e); }
  }

  const TERMINAL = new Set(['Done', 'Failed', 'Restored']);
  function poll(id) {
    const tick = async () => {
      try {
        const j = await client.getMigration(id);
        state.jobs.set(id, j);
        renderProgress();
        if (TERMINAL.has(j.state)) { state.polling.delete(id); return; }
      } catch (e) { showError(e); state.polling.delete(id); return; }
      state.polling.set(id, setTimeout(tick, pollMs));
    };
    state.polling.set(id, setTimeout(tick, 0));
  }

  async function rollback(id) {
    try {
      state.jobs.set(id, await client.rollback(id));
      renderProgress();
    } catch (e) { showError(e); }
  }

  const STEPS = ['Validated', 'SnapshotTaken', 'Deallocated', 'Updated', 'Started', 'PostChecked', 'Done'];
  function renderProgress() {
    $('progress').replaceChildren(...[...state.jobs.values()].map((j) => {
      const vm = state.vms.find((v) => v.id === j.plan.vmId);
      const kids = [
        h('h3', {}, vm?.name ?? j.plan.vmId, ' ', j.plan.sourceSku, ' → ', j.plan.targetSku, ' ', badge(j.state),
          j.plan.dryRun ? ' (dry run)' : ''),
        h('ol', { class: 'steps', 'aria-label': 'Migration steps' }, STEPS.map((s) =>
          h('li', { class: j.completedSteps.includes(s) ? 'done' : '' }, (j.completedSteps.includes(s) ? '✓ ' : '') + s))),
      ];
      if (j.error) kids.push(h('p', { class: 'error', role: 'alert' }, j.error));
      if (j.state === 'Failed' || j.state === 'Restored' || j.state === 'RollingBack') {
        kids.push(h('p', {}, j.state === 'Restored' ? 'Rollback result: VM restored to original size.' : j.state === 'RollingBack' ? 'Rolling back…' : 'Migration failed.'));
      }
      if (j.state === 'Failed') kids.push(h('button', { type: 'button', class: 'danger', onclick: () => rollback(j.id) }, 'Rollback'));
    else if (j.state === 'Done' && j.postCheck?.overall === 'FAIL') kids.push(h('button', { type: 'button', class: 'danger', onclick: () => rollback(j.id) }, 'Rollback (post-check failed)'));
      if (j.postCheck) {
        kids.push(h('h4', {}, 'Post-check ', badge(j.postCheck.overall)),
          h('ul', {}, j.postCheck.checks.map((c) => h('li', {}, badge(c.status), ` ${c.checkId}: ${c.message}`))));
      }
      kids.push(h('pre', { class: 'log', 'aria-label': 'Step log' },
        j.plan.actions.filter((a) => j.plan.dryRun || j.completedSteps.includes(a.step))
          .map((a) => `${j.plan.dryRun ? 'PLAN' : 'DONE'} ${a.step}: ${a.description}${a.method ? ` [${a.method} ${a.url ?? ''}]` : ''}`).join('\n') || 'Waiting…'));
      return h('div', { class: 'card' }, kids);
    }));
  }

  $('btn-detect').onclick = () => load(true);
  $('btn-all').onclick = () => load(false);
  $('filter').oninput = renderTable;
  $('check-all').onchange = (e) => {
    for (const v of filtered()) e.target.checked ? state.selected.add(v.id) : state.selected.delete(v.id);
    renderTable();
  };
  $('btn-precheck').onclick = runPrecheck;
  $('btn-dry').onclick = () => startMigration(true);
  $('btn-migrate').onclick = () => startMigration(false);

  return client.listSubscriptions().then((subs) => {
    $('sub').replaceChildren(...subs.map((s) => h('option', { value: s.id ?? s.subscriptionId }, s.name ?? s.displayName ?? s.id)));
    renderTable();
    return { state, load, runPrecheck, startMigration };
  });
}
