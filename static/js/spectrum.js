/* Artemisos · optional spectrum module.
 * Adapted from the teammates' interactive SVG plots and photometry workflow.
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
    controller: null, token: 0, tried: false, year: 'all', scale: 'robust', cleanOnly: false, view: 'spectrum', timeBand: 1
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
      `${fmt(point.flux)}${point.err != null ? ' ± ' + fmt(point.err) : ''} MJy/sr`,
      document.createElement('br'), `Quality: ${point.flags == null ? 'Unknown' : point.flags ? 'Flagged ('+point.flags+')' : 'No flags'}`);
    tip.hidden = false;
    tip.classList.toggle('below', py < 70);
    tip.style.left = `${Math.max(65, Math.min(parent.width - 65, px))}px`;
    tip.style.top = `${py + (py < 70 ? 0 : -12)}px`;
  }
  function drawTime() {
    const chart=$('spectrum');chart.textContent='';hideTooltip();
    const W=400,H=230,L=49,R=12,T=24,B=42;
    const band=Number(S.timeBand || S.band || 1);
    const pts=[...S.points.values()].filter(p=>p.band===band && Number.isFinite(p.mjd) && p.mjd > 40000 &&
      Number.isFinite(p.flux) && (S.year==='all'||String(p.date).startsWith(S.year)) &&
      (!S.cleanOnly||p.flags===0)).sort((a,b)=>a.mjd-b.mjd);
    if(!pts.length){chart.append(svg('text',{class:'empty-txt',x:200,y:115,'text-anchor':'middle'},
      'No temporal samples for this detector/year.'));return;}
    const first=pts[0].mjd,last=pts[pts.length-1].mjd;
    const dx=Math.max(1,last-first),x=p=>L+((p.mjd-first)/dx)*(W-L-R);
    const values=pts.flatMap(p=>[p.flux-(Number.isFinite(p.err)?p.err:0),p.flux+(Number.isFinite(p.err)?p.err:0)])
      .sort((a,b)=>a-b);
    const q=f=>{const pos=(values.length-1)*f,i=Math.floor(pos);return values[i]+(values[Math.min(values.length-1,i+1)]-values[i])*(pos-i);};
    let lo=S.scale==='robust' && values.length>10?q(.05):values[0];
    let hi=S.scale==='robust' && values.length>10?q(.95):values[values.length-1];
    if(hi<=lo){lo=values[0];hi=values[values.length-1];}
    const pad=(hi-lo)*.12 || Math.abs(hi)*.1 || 1;lo-=pad;hi+=pad;
    const y=v=>T+(hi-v)/(hi-lo)*(H-T-B);
    for(const tick of ticks(lo,hi)){
      chart.append(svg('line',{class:'grid',x1:L,x2:W-R,y1:y(tick),y2:y(tick)}));
      chart.append(svg('text',{x:L-6,y:y(tick)+3,'text-anchor':'end'},fmt(tick)));
    }
    chart.append(svg('line',{class:'axis',x1:L,x2:W-R,y1:H-B,y2:H-B}));
    const fmtDate=mjd=>new Date((mjd-40587)*86400000).toISOString().slice(0,7);
    for(let i=0;i<=3;i++){
      const t=first+dx*i/3;
      chart.append(svg('text',{x:L+(W-L-R)*i/3,y:H-B+17,'text-anchor':'middle'},fmtDate(t)));
    }
    chart.append(svg('text',{x:(L+W-R)/2,y:H-4,'text-anchor':'middle'},'Observation date (UTC)'));
    const cy=(T+H-B)/2;
    chart.append(svg('text',{x:12,y:cy,'text-anchor':'middle',transform:`rotate(-90 12 ${cy})`},'Brightness (MJy/sr)'));
    for(const p of pts){
      if(p.flux<lo || p.flux>hi)continue;
      const cx=x(p),cy=y(p.flux),saved=S.saved.has(p.id);
      if(Number.isFinite(p.err)&&p.err>0){chart.append(svg('line',{class:'errbar',x1:cx,x2:cx,
        y1:y(Math.max(lo,p.flux-p.err)),y2:y(Math.min(hi,p.flux+p.err))}));}
      chart.append(svg('circle',{class:'pt'+(saved?' saved':'')+(p.flags?' quality-warning':''),
        cx,cy,r:saved?5:4}));
      const hit=svg('circle',{class:'hit',cx,cy,r:10,tabindex:0,role:'button',
        'aria-label':`Open observation ${p.date} in band ${p.band}`});
      hit.addEventListener('pointerenter',()=>showTooltip(p,cx,cy,W,H));
      hit.addEventListener('pointerleave',hideTooltip);
      const open=()=>document.dispatchEvent(new CustomEvent('spherex:spectrumselect',
        {detail:{id:p.id,band:p.band}}));
      hit.addEventListener('click',open);
      hit.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();open();}});
      chart.append(hit);
    }
    const current=pts.find(p=>p.id===S.currentId);
    if(current&&current.flux>=lo&&current.flux<=hi)
      chart.append(svg('circle',{class:'halo',cx:x(current),cy:y(current.flux),r:9}));
  }
  function draw() {
    if(S.view==='time') return drawTime();
    const chart = $('spectrum'); chart.textContent = ''; hideTooltip();
    const W = 400, H = 230, L = 49, R = 12, T = 24, B = 38, xmin = .7, xmax = 5.05;
    const pts = [...S.points.values()].filter(p => Number.isFinite(p.lam) && Number.isFinite(p.flux) &&
      (S.year === 'all' || String(p.date).startsWith(S.year)) &&
      (!S.cleanOnly || p.flags === 0));
    const x = v => L + (v - xmin) / (xmax - xmin) * (W - L - R);
    const extrema = pts.flatMap(p => {
      const e = Number.isFinite(p.err) && p.err > 0 ? p.err : 0;
      return [p.flux - e, p.flux + e];
    }).sort((a,b)=>a-b);
    function quantile(fraction) { const v=(extrema.length-1)*fraction, i=Math.floor(v);
      return extrema[i] + (extrema[Math.min(i+1,extrema.length-1)] - extrema[i])*(v-i); }
    let lo=0,hi=1;
    if (extrema.length) {
      lo = S.scale === 'robust' && extrema.length > 10 ? quantile(.05) : extrema[0];
      hi = S.scale === 'robust' && extrema.length > 10 ? quantile(.95) : extrema[extrema.length-1];
      if(hi<=lo) {lo=extrema[0];hi=extrema[extrema.length-1];}
    }
    const margin=(hi-lo)*.12 || Math.abs(hi)*.1 || 1; lo-=margin;hi+=margin;
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
      if (p.flux < lo || p.flux > hi) continue;
      if (Number.isFinite(p.err) && p.err > 0)
        chart.append(svg('line', {class: 'errbar', x1: x(p.lam), x2: x(p.lam),
          y1: y(Math.max(lo,p.flux - p.err)), y2: y(Math.min(hi,p.flux + p.err))}));
    }
    for (const p of sorted) {
      if (p.flux < lo || p.flux > hi) continue;
      const cx = x(p.lam), cy = y(p.flux), saved = S.saved.has(p.id);
      const year = String(p.date).slice(0,4);
      const palette = ['#5598e7','#78c4dd','#b2a1ed','#f1b46b','#7bc99d','#c17dcc'];
      const years = [...new Set([...S.points.values()].map(q=>String(q.date).slice(0,4)))].sort();
      const fill = saved ? 'var(--gold)' : palette[Math.max(0,years.indexOf(year)) % palette.length];
      chart.append(svg('circle', {class: 'pt' + (saved ? ' saved' : '') + (p.flags ? ' quality-warning' : ''),
        cx, cy, r: saved ? 5 : 4, style: `fill:${fill}`}));
      const hit = svg('circle', {class: 'hit', cx, cy, r: 11, tabindex: 0, role: 'button',
        'aria-label': `Open observation ${p.date}, band ${p.band}`});
      hit.addEventListener('pointerenter', () => showTooltip(p, cx, cy, W, H));
      hit.addEventListener('pointerleave', hideTooltip);
      hit.addEventListener('click', () => document.dispatchEvent(new CustomEvent('spherex:spectrumselect', {detail: {id: p.id, band: p.band}})));
      hit.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hit.dispatchEvent(new Event('click')); } });
      chart.append(hit);
    }
    const current = pts.find(p=>p.id===S.currentId);
    if (current && current.flux >= lo && current.flux <= hi)
      chart.append(svg('circle', {class:'halo',cx:x(current.lam),cy:y(current.flux),r:9}));
  }
  function note(message) { $('specNote').textContent = message; }
  function updateControls() {
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
    S.done = 0; S.total = 0; S.tried = false; S.year='all';
    $('specYear').innerHTML = '<option value="all">All years</option>';
    updateControls(); draw();
    note('Optional analysis. Generate a spectrum after searching; the sky viewer remains usable.');
  }
  function setCatalog(items, sky) {
    reset();
    S.items = items.filter(it => it.access_url && it.id).sort((a, b) => a.mjd - b.mjd);
    S.sky = {ra: sky.ra, dec: sky.dec, radius: sky.radius};
    S.total = S.items.length;
    const years = [...new Set(S.items.map(it=>String(it.date).slice(0,4)).filter(y=>/^\d{4}$/.test(y)))].sort();
    years.forEach(y=>{const o=document.createElement('option');o.value=y;o.textContent=y;$('specYear').append(o);});
    $('specLegend').textContent = years.length ? `Color indicates observation year: ${years.join(', ')}.` : 'Point colors distinguish observation years.';
    note(`${S.total} observations available. Click Generate spectrum to measure brightness without delaying the viewer.`);
    updateControls();
  }
  function setCurrent(id) { S.currentId = id; draw(); }
  function setBand(n) { S.band = n || null; if(S.band) {S.timeBand=S.band;$('specTimeBand').value=String(S.band);} draw(); }
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
            err: Number.isFinite(data.err) ? data.err : null, mjd:Number(item.mjd),
            flags: data.flags == null ? null : Number(data.flags),
            flagged_pixels: data.flagged_pixels ?? null});
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
  $('specView').onchange=()=>{
    S.view=$('specView').value;
    $('specCaution').textContent=S.view==='time'
      ? 'Temporal view uses one detector, but its pixel wavelengths can differ between visits. Not calibrated photometry.'
      : 'Exploratory pixel brightness, not a calibrated source spectrum. Different dates may overlap.';
    draw();
  };
  $('specTimeBand').onchange=()=>{S.timeBand=Number($('specTimeBand').value);draw();};
  $('specYear').onchange=()=>{S.year=$('specYear').value;draw();};
  $('specScale').onchange=()=>{S.scale=$('specScale').value;draw();};
  $('specCleanOnly').onchange=()=>{S.cleanOnly=$('specCleanOnly').checked;draw();};
  function setTarget(ra,dec) {
    if(!S.sky) return;
    cancel(); S.points.clear(); S.failedIds.clear(); S.tried=false;
    S.sky={...S.sky,ra,dec}; S.done=0;
    updateControls();draw();note('New target selected. Click Generate spectrum to remeasure all epochs at this sky position.');
  }
  $('specGenerate').onclick = run;
  window.ArtemisosSpectrum = {reset, setCatalog, setCurrent, setBand, setSaved, setTarget};
  reset();
})();
