/* Artemisos · optional spectrum module.
 * Adapted from the existing interactive SVG plot, photometry + CSV workflow.
 * Deliberately separate from app.js: it NEVER starts network activity until
 * the user explicitly clicks Generate spectrum, and never blocks the viewer.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const bandsUm = [[.75, 1.09], [1.10, 1.62], [1.63, 2.41], [2.42, 3.82], [3.83, 4.41], [4.42, 5.00]];
  const S = {
    items: [], sky: null, points: new Map(), failedIds: new Set(), currentId: null,
    saved: new Set(), band: null, total: 0, done: 0, running: false,
    controller: null, token: 0, tried: false
  };
  const svg = (name, attrs = {}, label) => {
    const element = document.createElementNS(NS, name);
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    if (label != null) element.textContent = label;
    return element;
  };
  const fmt = value => Number.isFinite(Number(value)) ? String(Number(Number(value).toPrecision(3))) : '—';
  function ticks(low, high, count = 4) {
    const raw = ((high - low) || 1) / count;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map(m => m * magnitude).find(n => n >= raw) || magnitude * 10;
    const values = [];
    for (let v = Math.ceil(low / step) * step; v <= high + step * 1e-9; v += step)
      values.push(Number(v.toPrecision(12)));
    return values;
  }
  function hideTooltip() { $('specTip').hidden = true; }
  function showTooltip(point, x, y, width, height) {
    const tip = $('specTip');
    const rect = $('spectrum').getBoundingClientRect();
    const parent = $('specBox').getBoundingClientRect();
    const px = rect.left - parent.left + x * rect.width / width;
    const py = rect.top - parent.top + y * rect.height / height;
    tip.textContent = '';
    const name = document.createElement('b'); name.textContent = point.date;
    tip.append(name, document.createElement('br'),
      `Band ${point.band} · ${fmt(point.lam)} µm`, document.createElement('br'),
      `${fmt(point.flux)}${point.err != null ? ' ± ' + fmt(point.err) : ''} MJy/sr`);
    tip.hidden = false;
    tip.classList.toggle('below', py < 70);
    tip.style.left = `${Math.max(65, Math.min(parent.width - 65, px))}px`;
    tip.style.top = `${py + (py < 70 ? 0 : -12)}px`;
  }
  function draw() {
    const chart = $('spectrum'); chart.textContent = ''; hideTooltip();
    const W = 400, H = 230, L = 49, R = 12, T = 24, B = 38, xmin = .7, xmax = 5.05;
    const pts = [...S.points.values()].filter(p => Number.isFinite(p.lam) && Number.isFinite(p.flux));
    const x = v => L + (v - xmin) / (xmax - xmin) * (W - L - R);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      const e = Number.isFinite(p.err) && p.err > 0 ? p.err : 0;
      lo = Math.min(lo, p.flux - e); hi = Math.max(hi, p.flux + e);
    }
    if (!pts.length) { lo = 0; hi = 1; }
    const margin = (hi - lo) * .12 || Math.abs(hi) * .1 || 1;
    lo -= margin; hi += margin;
    const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
    bandsUm.forEach(([a, b], i) => {
      const selected = S.band === i + 1;
      chart.append(svg('rect', {
        class: 'wash' + (i % 2 === 0 ? ' alt' : '') + (selected ? ' on' : ''),
        x: x(a), y: T, width: x(b) - x(a), height: H - T - B
      }));
      chart.append(svg('text', {class: 'bandlbl' + (selected ? ' on' : ''),
        x: (x(a) + x(b)) / 2, y: T - 8, 'text-anchor': 'middle'}, `B${i + 1}`));
    });
    if (pts.length) {
      for (const value of ticks(lo, hi)) {
        chart.append(svg('line', {class: 'grid', x1: L, x2: W - R, y1: y(value), y2: y(value)}));
        chart.append(svg('text', {x: L - 6, y: y(value) + 4, 'text-anchor': 'end'}, fmt(value)));
      }
      const center = (T + H - B) / 2;
      chart.append(svg('text', {x: 12, y: center, 'text-anchor': 'middle',
        transform: `rotate(-90 12 ${center})`}, 'Brightness (MJy/sr)'));
    }
    chart.append(svg('line', {class: 'axis', x1: L, x2: W - R, y1: H - B, y2: H - B}));
    for (let v = 1; v <= 5; v++) {
      chart.append(svg('line', {class: 'axis', x1: x(v), x2: x(v), y1: H - B, y2: H - B + 4}));
      chart.append(svg('text', {x: x(v), y: H - B + 17, 'text-anchor': 'middle'}, String(v)));
    }
    chart.append(svg('text', {x: (L + W - R) / 2, y: H - 5, 'text-anchor': 'middle'}, 'Wavelength (µm)'));
    if (!pts.length) {
      chart.append(svg('text', {class: 'empty-txt', x: (L + W - R) / 2,
        y: (T + H - B) / 2, 'text-anchor': 'middle'},
      S.running ? `Measuring spectra… ${S.done}/${S.total}` : 'Search first, then generate spectrum'));
      return;
    }
    const sorted = [...pts].sort((a, b) => Number(S.saved.has(a.id)) - Number(S.saved.has(b.id)));
    for (const p of sorted) {
      if (Number.isFinite(p.err) && p.err > 0)
        chart.append(svg('line', {class: 'errbar', x1: x(p.lam), x2: x(p.lam),
          y1: y(p.flux - p.err), y2: y(p.flux + p.err)}));
    }
    for (const p of sorted) {
      const cx = x(p.lam), cy = y(p.flux), saved = S.saved.has(p.id);
      chart.append(svg('circle', {class: 'pt' + (saved ? ' saved' : ''), cx, cy, r: saved ? 5 : 4}));
      const hit = svg('circle', {class: 'hit', cx, cy, r: 11, tabindex: 0, role: 'button',
        'aria-label': `Open observation ${p.date}, band ${p.band}`});
      hit.addEventListener('pointerenter', () => showTooltip(p, cx, cy, W, H));
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('spherex:spectrumselect', {detail: {id: p.id, band: p.band}})));
      hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit.dispatchEvent(new Event('click')); } });
      chart.append(hit);
    }
    const current = S.points.get(S.currentId);
    if (current) chart.append(svg('circle', {class: 'halo', cx: x(current.lam), cy: y(current.flux), r: 9}));
  }
  function note(message) { $('specNote').textContent = message; }
  function updateControls() {
    $('specCsv').disabled = S.points.size === 0;
    $('specGenerate').disabled = !S.items.length || (!S.running && S.tried && !S.failedIds.size && S.points.size === S.items.length);
    $('specGenerate').textContent = S.running ? 'Cancel spectrum' : S.tried ?
      (S.failedIds.size ? 'Retry missing points' : S.points.size === S.items.length ? 'Spectrum ready' : 'Resume spectrum') : 'Generate spectrum';
  }
  function cancel() {
    ++S.token;
    if (S.controller) S.controller.abort();
    S.controller = null; S.running = false;
    updateControls(); draw();
  }
  function reset() {
    cancel();
    S.items = []; S.sky = null; S.points.clear(); S.failedIds.clear();
    S.currentId = null; S.saved = new Set(); S.band = null;
    S.done = 0; S.total = 0; S.tried = false;
    updateControls(); draw();
    note('Optional analysis. Generate a spectrum after searching; the sky viewer remains usable.');
  }
  function setCatalog(items, sky) {
    reset();
    S.items = items.filter(it => it.access_url && it.id).sort((a, b) => a.mjd - b.mjd);
    S.sky = {ra: sky.ra, dec: sky.dec, radius: sky.radius};
    S.total = S.items.length;
    note(`${S.total} observations available. Click Generate spectrum to measure brightness without delaying the viewer.`);
    updateControls();
  }
  function setCurrent(id) { S.currentId = id; draw(); }
  function setBand(n) { S.band = n || null; draw(); }
  function setSaved(ids) { S.saved = new Set(ids); draw(); }
  async function run() {
    if (!S.items.length || !S.sky) return;
    if (S.running) { cancel(); note(`Paused: ${S.points.size} measured / ${S.total} observations. Resume when ready.`); return; }
    S.running = true; S.tried = true;
    const token = ++S.token;
    S.controller = new AbortController();
    const signal = S.controller.signal;
    S.done = S.points.size; S.failedIds.clear();
    updateControls(); draw();
    for (const item of S.items) {
      if (signal.aborted || token !== S.token) return;
      if (S.points.has(item.id)) continue;
      // The viewer's Quick/Advanced images ALWAYS take priority. Do not start
      // another FITS download while its blocking overlay is on screen.
      while (!$('loadingOverlay').hidden) {
        // Remove the abort listener after each pause; the viewer can spend
        // minutes preparing Advanced FITS without leaking listeners.
        await new Promise(resolve => {
          let timer;
          const onAbort = () => { clearTimeout(timer); resolve(); };
          timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
          }, 300);
          signal.addEventListener('abort', onAbort, {once: true});
          if (signal.aborted) onAbort();
        });
        if (signal.aborted || token !== S.token) return;
      }
      note(`Measuring spectrum: ${S.done} / ${S.total} observations (viewer remains interactive).`);
      try {
        const response = await fetch('/api/spectrum/point', {
          method: 'POST', signal, headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({access_url: item.access_url, ...S.sky})
        });
        const data = await response.json();
        if (!response.ok || data.status !== 'ok') throw new Error(data.message || 'Spectrum point unavailable');
        if (Number.isFinite(data.lam) && Number.isFinite(data.flux) && data.lam >= .7 && data.lam <= 5.05) {
          S.points.set(item.id, {id: item.id, band: item.band, date: item.date,
            lam: data.lam, width: data.width, flux: data.flux,
            err: Number.isFinite(data.err) ? data.err : null});
        } else S.failedIds.add(item.id);
      } catch (err) {
        if (signal.aborted || token !== S.token) return;
        S.failedIds.add(item.id);
      }
      S.done++;
      updateControls(); draw();
    }
    if (signal.aborted || token !== S.token) return;
    S.running = false; S.controller = null;
    updateControls(); draw();
    note(`${S.points.size} spectral points from ${S.total} observations${S.failedIds.size ? ` · ${S.failedIds.size} without a valid measurement` : ''}. Click a point to open its image.`);
  }
  function exportCSV() {
    if (!S.points.size) return;
    const sorted = [...S.points.values()].sort((a, b) => a.date.localeCompare(b.date));
    const csv = ['date,band,wavelength_um,width_um,brightness_MJy_sr,error_MJy_sr',
      ...sorted.map(p => [p.date, p.band, p.lam, p.width ?? '', p.flux, p.err ?? ''].join(','))].join('\r\n');
    const blobUrl = URL.createObjectURL(new Blob(['\ufeff' + csv], {type: 'text/csv;charset=utf-8'}));
    const anchor = document.createElement('a');
    anchor.href = blobUrl; anchor.download = 'artemisos_spectrum.csv'; anchor.click();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
  }
  $('specGenerate').onclick = run;
  $('specCsv').onclick = exportCSV;
  window.ArtemisosSpectrum = {reset, setCatalog, setCurrent, setBand, setSaved};
  reset();
})();
