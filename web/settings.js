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

const REGION_HINTS = [
  'northeurope', 'westeurope', 'francecentral', 'francesouth', 'norwayeast', 'norwaywest', 'southeastasia', 'eastasia',
  'eastus', 'eastus2', 'westus', 'westus2', 'westus3', 'centralus', 'uksouth', 'ukwest', 'germanywestcentral',
  'swedencentral', 'switzerlandnorth', 'italynorth', 'polandcentral', 'australiaeast', 'japaneast', 'canadacentral', 'brazilsouth',
];

export function initSettings(doc, client, { onSaved } = {}) {
  const $ = (id) => doc.getElementById(id);
  const dlg = $('settings');
  if (!dlg || !client.getSettings) return;
  let data = null;
  const open = (d) => { if (typeof d.showModal === 'function') d.showModal(); else d.setAttribute('open', ''); };
  const close = (d) => { if (typeof d.close === 'function') d.close(); else d.removeAttribute('open'); };
  const msg = (t, bad) => { const m = $('settings-msg'); m.textContent = t; m.className = bad ? 'err' : 'muted'; };

  function numInput(value, onchange) {
    return h(doc, 'input', { type: 'number', min: '0', max: '500', step: '0.1', value: String(value), class: 'num', onchange: (e) => onchange(Number(e.target.value)) });
  }
  function textInput(value, onchange, list, type = 'text') {
    return h(doc, 'input', { type, value, ...(list ? { list } : {}), onchange: (e) => onchange(e.target.value) });
  }

  function render() {
    $('settings-effective').value = data.settings.effectiveDate;
    const known = $('settings-series-ids');
    known.replaceChildren(...data.defaults.series.map((s) => h(doc, 'option', { value: s.id })));
    $('settings-region-names').replaceChildren(...REGION_HINTS.map((r) => h(doc, 'option', { value: r })));
    $('settings-series').replaceChildren(
      ...data.settings.series.map((s, i) => h(doc, 'tr', {},
        h(doc, 'td', {}, textInput(s.id, (v) => { s.id = v.trim(); }, 'settings-series-ids')),
        h(doc, 'td', {}, textInput(s.retirementDate, (v) => { s.retirementDate = v; }, null, 'date')),
        h(doc, 'td', {}, numInput(s.upliftPct, (v) => { s.upliftPct = v; })),
        h(doc, 'td', {}, h(doc, 'button', { type: 'button', class: 'secondary', title: 'Remove', onclick: () => { data.settings.series.splice(i, 1); render(); } }, '\u2715')))),
    );
    $('settings-regions').replaceChildren(
      ...data.settings.regions.map((r, i) => h(doc, 'tr', {},
        h(doc, 'td', {}, textInput(r.name, (v) => { r.name = v.trim(); }, 'settings-region-names')),
        h(doc, 'td', {}, numInput(r.upliftPct, (v) => { r.upliftPct = v; })),
        h(doc, 'td', {}, h(doc, 'button', { type: 'button', class: 'secondary', title: 'Remove', onclick: () => { data.settings.regions.splice(i, 1); render(); } }, '\u2715')))),
    );
  }

  async function load() {
    msg('Loading\u2026');
    try { data = await client.getSettings(); render(); msg(''); } catch (e) { msg(e.message, true); }
  }

  $('btn-settings').onclick = async () => { open(dlg); await load(); };
  $('settings-close').onclick = () => close(dlg);
  $('settings-add-series').onclick = () => { if (!data) return; data.settings.series.push({ id: '', retirementDate: data.settings.effectiveDate, upliftPct: 0 }); render(); };
  $('settings-add-region').onclick = () => { if (!data) return; data.settings.regions.push({ name: '', upliftPct: 0 }); render(); };
  $('settings-save').onclick = async () => {
    if (!data) return;
    data.settings.effectiveDate = $('settings-effective').value;
    try {
      data.settings = (await client.saveSettings(data.settings)).settings ?? data.settings;
      render(); msg('Saved. New advice and reports use these values.');
      if (onSaved) onSaved();
    } catch (e) { msg(e.message, true); }
  };
  $('settings-reset').onclick = async () => {
    try { data.settings = (await client.resetSettings()).settings; render(); msg('Defaults restored.'); if (onSaved) onSaved(); } catch (e) { msg(e.message, true); }
  };
  const info = $('pricing-info');
  $('settings-info').onclick = () => open(info);
  $('pricing-info-close').onclick = () => close(info);
}
