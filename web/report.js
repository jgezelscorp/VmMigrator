// Builds a standalone HTML report (no external assets) of the discovered estate.
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pill = (s) => `<span class="pill ${esc(String(s).toLowerCase())}">${esc(s)}</span>`;
const dash = (v) => (v === undefined || v === null || v === '' ? '—' : esc(v));
const count = (arr, fn) => arr.filter(fn).length;

export function buildReport({ vms = [], prechecks = {}, jobs = [], targets = {}, subscription = '', advice = {}, generatedAt = new Date() } = {}) {
  const retiring = vms.filter((v) => v.retiringSeries);
  const bySeries = new Map();
  for (const v of retiring) bySeries.set(v.retiringSeries, (bySeries.get(v.retiringSeries) ?? 0) + 1);
  const checked = vms.filter((v) => prechecks[v.id]);
  const jobList = [...jobs];

  const kpi = (n, label) => `<div class="kpi"><b>${n}</b><span>${esc(label)}</span></div>`;
  const disks = (v) => [v.osDisk, ...(v.dataDisks ?? [])].filter(Boolean).length;

  const vmRows = vms.map((v) => {
    const r = prechecks[v.id];
    const job = jobList.filter((j) => j.plan?.vmId === v.id).at(-1);
    return `<tr>
<td><b>${esc(v.name)}</b><br><small>${esc(v.resourceGroup)}</small></td>
<td>${esc(v.osType)}</td><td>${dash(v.vmSize)}</td><td>${v.retiringSeries ? pill('retiring') + ' ' + esc(v.retiringSeries) : pill('ok') + ' current'}</td>
<td>${dash(v.retirementDate)}</td><td>${esc(v.location)}</td><td>${dash(v.hyperVGeneration)}</td><td>${dash(v.securityType)}</td>
<td>${dash(v.diskControllerType)}</td><td>${disks(v)}</td><td>${pill(v.powerState ?? 'unknown')}</td>
<td>${r ? esc(r.targetSku) : dash(targets[v.id] ?? v.candidateTargets?.[0]?.sku)}</td>
<td>${r ? pill(r.overall) : 'not run'}</td><td>${job ? pill(job.state) : '—'}</td></tr>`;
  }).join('\n');

  const checkSections = checked.map((v) => {
    const r = prechecks[v.id];
    return `<h3>${esc(v.name)} → ${esc(r.targetSku)} ${pill(r.overall)}${r.strategy === 'rebuild' ? ' <small>(rebuild strategy)</small>' : ''}</h3>
<table><thead><tr><th>Check</th><th>Status</th><th>Detail</th><th>Remediation</th></tr></thead><tbody>
${r.checks.map((c) => `<tr><td>${esc(c.checkId)}</td><td>${pill(c.status)}</td><td>${esc(c.message)}</td><td>${dash(c.remediation)}</td></tr>`).join('\n')}
</tbody></table>`;
  }).join('\n');

  const jobRows = jobList.map((j) => {
    const vm = vms.find((v) => v.id === j.plan?.vmId);
    return `<tr><td>${esc(vm?.name ?? j.plan?.vmId)}</td><td>${esc(j.plan?.sourceSku)} → ${esc(j.plan?.targetSku)}</td>
<td>${esc(j.plan?.strategy ?? 'inPlace')}${j.plan?.dryRun ? ' (dry run)' : ''}</td><td>${pill(j.state)}</td>
<td>${esc((j.completedSteps ?? []).join(' → '))}</td><td>${j.postCheck ? pill(j.postCheck.overall) : '—'}</td><td>${dash(j.error)}</td></tr>`;
  }).join('\n');

  const usd = (n) => (n == null ? 'n/a' : `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`);
  const finItems = vms.map((v) => {
    const a = advice[v.id];
    const target = prechecks[v.id]?.targetSku ?? targets[v.id];
    if (!a?.proposed?.name || a.cost?.status !== 'ok' || target !== a.proposed.name) return null;
    return { v, a, c: a.cost };
  }).filter(Boolean);
  const delta = (n, base) => (n == null || base == null ? '<td>n/a</td><td>n/a</td><td>n/a</td>'
    : `<td>${usd(n)}</td><td class="${n - base <= 0 ? 'gain' : 'loss'}">${n - base <= 0 ? '' : '+'}${usd(n - base)} (${base ? (((n - base) / base) * 100).toFixed(1) : '0.0'}%)</td><td class="${n - base <= 0 ? 'gain' : 'loss'}">${n - base <= 0 ? '' : '+'}${usd((n - base) * 12)}</td>`);
  const totals = { base: 0, paygo: 0, ri1: 0, ri3: 0, ok1: true, ok3: true };
  const finRows = finItems.map(({ v, a, c }) => {
    const covered = (a.reservation?.matches ?? []).length > 0;
    const curRi = c.currentOneYearMonthly ?? c.currentThreeYearMonthly;
    const base = covered && curRi != null ? curRi : c.currentMonthlyWithUplift;
    const basis = covered && curRi != null ? 'Reservation' : 'PAYGO' + (c.currentUpliftKind && c.currentUpliftKind !== 'none' ? ` +${c.currentUpliftPct}% ${c.currentUpliftKind}` : '');
    totals.base += base ?? 0; totals.paygo += c.proposedMonthlyWithUplift ?? 0;
    if (c.proposedOneYearMonthly == null) totals.ok1 = false; else totals.ri1 += c.proposedOneYearMonthly;
    if (c.proposedThreeYearMonthly == null) totals.ok3 = false; else totals.ri3 += c.proposedThreeYearMonthly;
    const head = `<td rowspan="3"><b>${esc(v.name)}</b></td><td rowspan="3">${esc(a.current?.name ?? v.vmSize)}<br><small>${esc(basis)}</small></td><td rowspan="3">${usd(base)}</td><td rowspan="3">${esc(a.proposed.name)}</td>`;
    const pgBasis = `PAYGO${c.proposedUpliftKind && c.proposedUpliftKind !== 'none' ? ` +${c.proposedUpliftPct}% ${c.proposedUpliftKind}` : ''}`;
    return `<tr>${head}<td>${esc(pgBasis)}</td>${delta(c.proposedMonthlyWithUplift, base)}</tr>
<tr><td>1-year reservation</td>${delta(c.proposedOneYearMonthly, base)}</tr>
<tr><td>3-year reservation</td>${delta(c.proposedThreeYearMonthly, base)}</tr>`;
  });
  const totRow = (label, n, ok) => `<tr><td colspan="4"><b>Total (${finItems.length} VMs)</b></td><td>${label}</td>${ok ? delta(n, totals.base) : '<td>n/a</td><td>n/a</td><td>n/a</td>'}</tr>`;
  const finSection = finItems.length ? `<h2>Financial impact (Auto-SKU)</h2>
<p><small>Baseline = current VM at its reservation rate if covered, otherwise PAYGO including the regional/lifecycle uplift. Reservation prices are retail monthly rates (Windows adds the PAYGO license) and are not affected by uplift; existing RIs keep their price until term end, then PAYGO applies. Uplifts do not apply to Sovereign/Government clouds. Green = saving, red = increase. Monthly figures; annual = ×12.</small></p>
<table><thead><tr><th>VM</th><th>Current SKU</th><th>Current /month</th><th>New SKU</th><th>New pricing option</th><th>New /month</th><th>Gain / loss per month</th><th>Per year</th></tr></thead><tbody>
${finRows.join('\n')}
${totRow('PAYGO', totals.paygo, true)}${totRow('1-year reservation', totals.ri1, totals.ok1)}${totRow('3-year reservation', totals.ri3, totals.ok3)}
</tbody></table>` : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>VM-Migrator estate report</title>
<style>
body{font:14px/1.45 Segoe UI,system-ui,sans-serif;margin:2rem;color:#1b1f2a;background:#f6f8fc}
h1{margin:0 0 .2rem}h2{margin-top:2rem;border-bottom:2px solid #d5dcf0;padding-bottom:.2rem}
.meta{color:#566}.kpis{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0}
.kpi{background:#fff;border-radius:10px;padding:.8rem 1.2rem;box-shadow:0 1px 4px #0002;min-width:120px}
.kpi b{display:block;font-size:1.8rem;color:#3b4cca}.kpi span{color:#566}
table{border-collapse:collapse;width:100%;background:#fff;margin:.5rem 0}
th,td{border:1px solid #e0e5f2;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#eef1fb}
.pill{display:inline-block;padding:0 .5rem;border-radius:999px;font-size:.8rem;background:#e5e8f2}
.pill.pass,.pill.ok,.pill.done,.pill.running{background:#d4f4dd;color:#146c2e}
.pill.warn,.pill.retiring,.pill.restored{background:#fff1c9;color:#8a5a00}
.pill.block,.pill.fail,.pill.failed{background:#fdd9d9;color:#a11}
td.gain{color:#1e8e3e;font-weight:700}td.loss{color:#c0392b;font-weight:700}
@media print{body{margin:.5rem;background:#fff}}
</style></head><body>
<h1>VM-Migrator estate report</h1>
<p class="meta">Generated ${esc(new Date(generatedAt).toISOString())} · ${subscription ? `Subscription${subscription.includes(',') ? 's' : ''} ${esc(subscription.split(',').join(', '))}` : 'All subscriptions'}</p>
<div class="kpis">
${kpi(vms.length, 'VMs discovered')}${kpi(retiring.length, 'On retiring series')}${kpi(count(vms, (v) => v.osType === 'Windows'), 'Windows')}${kpi(count(vms, (v) => v.osType === 'Linux'), 'Linux')}
${kpi(count(checked, (v) => prechecks[v.id].overall === 'PASS'), 'Pre-check PASS')}${kpi(count(checked, (v) => prechecks[v.id].overall === 'WARN'), 'Pre-check WARN')}${kpi(count(checked, (v) => prechecks[v.id].overall === 'BLOCK'), 'Pre-check BLOCK')}${kpi(count(jobList, (j) => j.state === 'Done' && !j.plan?.dryRun), 'Migrated')}
</div>
<p>Retiring by series: ${[...bySeries].map(([s, n]) => `${esc(s)}: ${n}`).join(', ') || 'none'}</p>
<h2>Estate</h2>
<table><thead><tr><th>VM</th><th>OS</th><th>Size</th><th>Series</th><th>Retires</th><th>Region</th><th>Gen</th><th>Security</th><th>Disk ctrl</th><th>Disks</th><th>Power</th><th>Target</th><th>Pre-check</th><th>Migration</th></tr></thead><tbody>
${vmRows || '<tr><td colspan="14">No VMs loaded.</td></tr>'}
</tbody></table>
${finSection}
<h2>Pre-check details</h2>
${checkSections || '<p>No pre-checks have been run yet.</p>'}
<h2>Migration jobs</h2>
${jobRows ? `<table><thead><tr><th>VM</th><th>Size change</th><th>Strategy</th><th>State</th><th>Completed steps</th><th>Post-check</th><th>Error</th></tr></thead><tbody>${jobRows}</tbody></table>` : '<p>No migrations started in this session.</p>'}
</body></html>
`;
}
