// Experimental: directional lifecycle / regional price-exposure analysis (not a quote).
function h(doc, tag, attrs = {}, ...kids) {
  const el = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v !== false && v != null) el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) el.append(kid && kid.nodeType ? kid : String(kid ?? ''));
  return el;
}

// Share of a list-price increase that actually reaches the invoice: a customer paying (1-d) of list
// absorbs increases up to d/(1-d); the undiscounted case is fully shielded (low end), the high end assumes none.
export function protectedPassThrough(upliftPct, discountPct) {
  const p = upliftPct / 100;
  const d = Math.min(Math.max(discountPct / 100, 0), 0.99);
  return Math.min(p, d / (1 - d));
}

function bucket(map, key) {
  if (!map.has(key)) map.set(key, { key, base: 0, low: 0, high: 0, payg: 0, reserved: 0, count: 0 });
  return map.get(key);
}

export function computeExposure(rows, discounts = {}) {
  const disc = Number(discounts.paygoDiscountPct ?? 0);
  const total = { vms: rows.length, base: 0, low: 0, high: 0, payg: 0, reserved: 0, unpriced: 0, sovereign: 0, excluded: 0 };
  const bySku = new Map(); const byRegion = new Map(); const bySub = new Map(); const byGroup = new Map();
  const reservedRows = [];
  const unpriced = [];
  for (const r of rows) {
    if (!r.priced) { total.unpriced++; unpriced.push(r); continue; }
    const isReserved = r.purchase === 'reserved';
    const base = isReserved ? (r.reservedMonthly ?? r.paygoMonthly) : r.paygoMonthly;
    const high = isReserved ? 0 : base * (r.upliftPct / 100);
    const low = isReserved ? 0 : base * protectedPassThrough(r.upliftPct, disc);
    total.base += base; total.low += low; total.high += high;
    if (isReserved) { total.reserved += base; reservedRows.push(r); } else total.payg += base;
    if (r.sovereign) total.sovereign++;
    if (r.rule === 'excluded') total.excluded++;
    const groupKey = `${r.location}|${r.rule}`;
    for (const [m, k] of [[bySku, r.size], [byRegion, r.location], [bySub, r.subscriptionId], [byGroup, groupKey]]) {
      const b = bucket(m, k);
      b.base += base; b.low += low; b.high += high; b.count++;
      if (isReserved) b.reserved += base; else b.payg += base;
    }
  }
  const sorted = (m) => [...m.values()].sort((a, b) => b.high - a.high || b.base - a.base);
  return { total, bySku: sorted(bySku), byRegion: sorted(byRegion), bySub: sorted(bySub), byGroup: sorted(byGroup), reservedRows, unpriced };
}

const money = (n) => `$${Math.round(n).toLocaleString('en-US')}`;
const pct = (n, d) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '0%');

function bars(doc, title, items) {
  const max = Math.max(1, ...items.map((i) => i.base));
  return h(doc, 'section', { class: 'exp-chart' }, h(doc, 'h4', {}, title),
    items.length === 0 ? h(doc, 'p', { class: 'muted' }, 'No priced VMs.') : items.slice(0, 12).map((i) => h(doc, 'div', { class: 'exp-bar-row' },
      h(doc, 'span', { class: 'exp-label', title: i.key }, i.key),
      h(doc, 'span', { class: 'exp-bar' },
        h(doc, 'i', { class: 'payg', style: `width:${(i.payg / max) * 100}%`, title: `PAYG ${money(i.payg)}` }),
        h(doc, 'i', { class: 'ri', style: `width:${(i.reserved / max) * 100}%`, title: `Reserved ${money(i.reserved)}` })),
      h(doc, 'span', { class: 'num' }, `+${money(i.low)}–${money(i.high)}`))));
}

export function renderExposure(doc, root, data) {
  const { rows, discounts, effectiveDate } = data;
  const x = computeExposure(rows, discounts);
  const t = x.total;
  const kpi = (label, value, sub) => h(doc, 'div', { class: 'exp-kpi' }, h(doc, 'div', { class: 'muted' }, label), h(doc, 'div', { class: 'exp-kpi-v' }, value), sub ? h(doc, 'div', { class: 'muted' }, sub) : '');
  const rule = (title, body) => h(doc, 'div', { class: 'exp-rule' }, h(doc, 'strong', {}, title), h(doc, 'p', { class: 'muted' }, body));
  root.replaceChildren(
    h(doc, 'p', { class: 'exp-banner' }, `EXPERIMENTAL – directional monthly forecast for ${t.vms} VM(s), effective ${effectiveDate}. Not a quote or confirmed pricing.`),
    h(doc, 'div', { class: 'exp-kpis' },
      kpi('Monthly baseline (priced VMs)', money(t.base), `${money(t.payg)} PAYG · ${money(t.reserved)} reserved`),
      kpi('Total monthly increase', `${money(t.low)} – ${money(t.high)}`, `${pct(t.low, t.base)} – ${pct(t.high, t.base)} of baseline`),
      kpi('Forecast monthly after change', `${money(t.base + t.low)} – ${money(t.base + t.high)}`, `Customer PAYG discount modeled: ${discounts?.paygoDiscountPct ?? 0}%`)),
    h(doc, 'h4', {}, 'Grouped impact (region × rule)'),
    h(doc, 'table', { class: 'exp-table' },
      h(doc, 'thead', {}, h(doc, 'tr', {}, ['Region', 'Rule', 'VMs', 'Matched monthly', 'Monthly increase'].map((c) => h(doc, 'th', {}, c)))),
      h(doc, 'tbody', {}, x.byGroup.map((g) => { const [loc, rl] = g.key.split('|'); return h(doc, 'tr', {}, h(doc, 'td', {}, loc), h(doc, 'td', {}, rl), h(doc, 'td', { class: 'num' }, g.count), h(doc, 'td', { class: 'num' }, money(g.base)), h(doc, 'td', { class: 'num' }, `${money(g.low)} – ${money(g.high)}`)); }))),
    h(doc, 'div', { class: 'exp-legend muted' }, h(doc, 'i', { class: 'payg' }), ' Pay-as-you-go (exposed) ', h(doc, 'i', { class: 'ri' }), ' Reserved (protected until expiry)'),
    bars(doc, 'Older-generation repricing by SKU', x.bySku), bars(doc, 'Regional pricing by region', x.byRegion), bars(doc, 'Combined exposure by subscription', x.bySub),
    h(doc, 'h4', {}, 'Rules applied'),
    h(doc, 'div', { class: 'exp-rules' },
      rule('v1–v3 VM repricing (~25%)', `All public regions, effective ${effectiveDate}. Lifecycle wins over regional – no stacking.`),
      rule('Regional VM pricing (8–17%)', 'Applies in the configured regions (Settings). Exempt v7 Intel families (Dsv7, Ddsv7, Dlsv7, Dldsv7, Esv7, Edsv7) are excluded.'),
      rule('Price protection', 'Protection is bounded by the discount: a customer paying (1-d) of list absorbs increases up to d/(1-d). Low = that bounded pass-through; high = full list increase. Interpretive model.')),
    h(doc, 'h4', {}, 'Not unaffected'),
    h(doc, 'p', {}, `${t.unpriced} VM(s) could not be priced and are not counted – unpriced is not unaffected.${t.sovereign ? ` ${t.sovereign} VM(s) in Government/sovereign/21Vianet regions are exempt.` : ''}`),
    x.unpriced.length ? h(doc, 'ul', {}, x.unpriced.map((r) => h(doc, 'li', {}, `${r.name} (${r.size}, ${r.location})`))) : '',
    h(doc, 'h4', {}, 'Reserved instances'),
    x.reservedRows.length ? h(doc, 'ul', {}, x.reservedRows.map((r) => h(doc, 'li', {}, `${r.name}: protected${r.reservationExpiry ? ` until ${String(r.reservationExpiry).slice(0, 10)}` : ''}, then follows the new PAYG price.`))) : h(doc, 'p', { class: 'muted' }, 'None detected.'),
    h(doc, 'p', { class: 'muted' }, 'Caveats: Savings Plans follow the new PAYG price. Since 1 Jul 2026 1-year RIs cannot be bought/renewed for many v1–v3 families and no RIs for Dv3/Dsv3/Ev3/Esv3. No growth, FX or storage/ANF effects are modeled. Public cloud only.'));
}

export function initExposure(doc, client, getVms) {
  const $ = (id) => doc.getElementById(id);
  const dlg = $('exposure');
  if (!dlg || !client.exposure) return;
  const open = (d) => { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); };
  const close = (d) => { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  $('exposure-close').onclick = () => close(dlg);
  $('btn-exposure').onclick = async () => {
    const vms = getVms();
    open(dlg);
    const body = $('exposure-body');
    if (!vms.length) { body.textContent = 'Detect or load VMs first.'; return; }
    body.textContent = 'Analyzing exposure…';
    try {
      renderExposure(doc, body, await client.exposure(vms.map((v) => v.id)));
    } catch (e) {
      body.textContent = `Failed: ${e.message ?? e}`;
    }
  };
}
