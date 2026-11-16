/* Artemisos · DR1 spectral HiPS cube (102 channels).
 * This chart never modifies the sky viewer or the existing epoch spectrum.
 * It starts a non-blocking request after a successful catalog search, with
 * abort protection for a new search and retry on transient IRSA failures.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const C = { points: [], ra: null, dec: null, controller: null, token: 0, busy: false, failed: false, goodOnly: false, scale: 'robust' };
  const bandRanges = [[.75, 1.09], [1.10, 1.62], [1.63, 2.41], [2.42, 3.82], [3.83, 4.41], [4.42, 5.0]];
  const num = x => Number.isFinite(Number(x)) ? String(Number(Number(x).toPrecision(4))) : '—';
  const node = (tag, props = {}, text = null) => {
    const n = document.createElementNS(NS, tag);
    for (const [key, value] of Object.entries(props)) n.setAttribute(key, value);
    if (text !== null) n.textContent = text;
    return n;
  };
  function status(value) { $('cubeStatus').textContent = value; }
  function updateButtons() {
    $('cubeCsv').disabled = !C.points.length || !C.points.some(p => Number.isFinite(p.brightness));
    $('cubeRetry').hidden = !C.failed || C.busy || !Number.isFinite(C.ra) || !Number.isFinite(C.dec);
  }
  function empty(message = 'Search the sky to load the DR1 cube spectrum.') {
    const chart = $('cubeSpectrum'); chart.textContent = '';
    chart.append(node('text', {class:'empty-txt', x: 200, y: 115, 'text-anchor': 'middle'}, message));
  }
  function showTip(point, cx, cy) {
    const tip = $('cubeSpecTip'); const outer = $('cubeSpecBox').getBoundingClientRect();
    const inner = $('cubeSpectrum').getBoundingClientRect();
    const x = inner.left - outer.left + cx * inner.width / 400;
    const y = inner.top - outer.top + cy * inner.height / 230;
    tip.textContent = `Channel ${point.channel} · Band ${point.band} · ${num(point.wavelength_um)} µm · ` +
      `${num(point.brightness)} MJy/sr · Hits: ${point.nhits ?? 'unknown'} · Flags: ${point.flags ?? 'unknown'}` +
      (point.flags ? ' · CHECK QUALITY' : '');
    tip.style.left = `${Math.max(65, Math.min(outer.width - 65, x))}px`;
    tip.style.top = `${y - 12}px`;
    tip.hidden = false;
  }
  function draw() {
    const chart = $('cubeSpectrum'); chart.textContent = ''; $('cubeSpecTip').hidden = true;
    const W=400,H=230,L=48,R=12,T=23,B=36,X0=.7,X1=5.05;
    const points = C.points;
    if (!points.length) { empty(C.busy ? 'Loading 102 channels…' : 'No DR1 cube spectrum loaded.'); return; }
    const valid = points.filter(p => Number.isFinite(p.wavelength_um) && Number.isFinite(p.brightness) &&
      (!C.goodOnly || (!p.flags && (p.nhits === null || p.nhits > 0))));
    const values = valid.map(p => p.brightness).sort((a,b)=>a-b);
    if (!values.length) { empty('No channels match the quality filter.'); return; }
    const quantile = q => { const k=(values.length-1)*q, i=Math.floor(k); return values[i]+(values[Math.min(i+1,values.length-1)]-values[i])*(k-i); };
    let lo = C.scale==='robust' && values.length >= 8 ? quantile(.05) : values[0];
    let hi = C.scale==='robust' && values.length >= 8 ? quantile(.95) : values[values.length-1];
    if (hi<=lo) { lo=values[0]; hi=values[values.length-1]; }
    const pad=(hi-lo)*.12 || Math.abs(hi)*.1 || 1; lo-=pad; hi+=pad;
    const x = w => L+(w-X0)/(X1-X0)*(W-L-R);
    const y = v => T+(hi-v)/(hi-lo)*(H-T-B);
    bandRanges.forEach(([first,last], i) => {
      chart.append(node('rect', {class:'wash' + (i%2===0?' alt':''),
        x:x(first), y:T, width:x(last)-x(first), height:H-T-B}));
      chart.append(node('text', {class:'bandlbl',x:(x(first)+x(last))/2,y:T-8,'text-anchor':'middle'},`B${i+1}`));
    });
    for(let j=0;j<=4;j++) {
      const v=lo+(hi-lo)*j/4;
      chart.append(node('line',{class:'grid',x1:L,x2:W-R,y1:y(v),y2:y(v)}));
      chart.append(node('text',{x:L-5,y:y(v)+4,'text-anchor':'end'},num(v)));
    }
    chart.append(node('line',{class:'axis',x1:L,x2:W-R,y1:H-B,y2:H-B}));
    for (let w=1;w<=5;w++) {
      chart.append(node('text',{x:x(w),y:H-B+16,'text-anchor':'middle'},String(w)));
    }
    chart.append(node('text',{x:(L+W-R)/2,y:H-4,'text-anchor':'middle'},'Wavelength (µm)'));
    const mid = (T+H-B)/2;
    chart.append(node('text',{x:12,y:mid,'text-anchor':'middle',transform:`rotate(-90 12 ${mid})`},'Brightness (MJy/sr)'));
    // Do not interpolate across invalid layers (including official blank channels 51/52).
    let segment = [];
    function flush() {
      if (segment.length > 1) chart.append(node('polyline', {class:'segment', points:segment.join(' ')}));
      segment = [];
    }
    for(const p of points) {
      if (!valid.includes(p) || p.brightness < lo || p.brightness > hi) { flush(); continue; }
      segment.push(`${x(p.wavelength_um)},${y(p.brightness)}`);
    }
    flush();
    for(const p of valid) {
      const cx=x(p.wavelength_um), cy=y(p.brightness);
      if (p.brightness < lo || p.brightness > hi) continue;
      chart.append(node('circle',{class:'cube-point' + (p.flags ? ' bad-quality' : ''),cx,cy,r:2.5}));
      const target=node('circle',{class:'cube-hit',cx,cy,r:8,role:'button',tabindex:0,
        'aria-label':`Channel ${p.channel}, ${num(p.wavelength_um)} microns, ${num(p.brightness)} megajanskys per steradian`});
      target.addEventListener('pointerenter',()=>showTip(p,cx,cy));
      target.addEventListener('pointerleave',()=>{$('cubeSpecTip').hidden=true;});
      target.addEventListener('focus',()=>showTip(p,cx,cy));
      target.addEventListener('blur',()=>{$('cubeSpecTip').hidden=true;});
      chart.append(target);
    }
  }
  function reset() {
    ++C.token;
    if(C.controller) C.controller.abort();
    C.controller=null; C.points=[]; C.ra=C.dec=null; C.busy=false; C.failed=false;
    $('cubeRetry').hidden=true; $('cubeCsv').disabled=true;
    status('Run a search to extract a 102-channel quick-look spectrum.');
    empty('Search the sky to load the DR1 cube spectrum.');
  }
  async function query() {
    if(!Number.isFinite(C.ra)||!Number.isFinite(C.dec)) return;
    if(C.controller) C.controller.abort();
    const token=++C.token;
    const controller=new AbortController(); C.controller=controller; C.busy=true;
    let timedOut=false;
    const deadline=setTimeout(()=>{timedOut=true;controller.abort();},180000);
    C.points=[]; C.failed=false; status('Reading SPHEREx DR1 cube (102 channels)…');
    $('cubeRetry').hidden=true; updateButtons(); draw();
    try {
      const params=new URLSearchParams({ra:String(C.ra),dec:String(C.dec)});
      const response=await fetch(`/api/spectrum/cube?${params}`,{signal:controller.signal});
      const data=await response.json().catch(()=>({
        status:'error',message:`The cube server returned HTTP ${response.status} without valid JSON.`
      }));
      if(!response.ok || data.status!=='ok' || !Array.isArray(data.points) || data.points.length!==102)
        throw new Error(data.message||'The DR1 cube is temporarily unavailable.');
      if(token!==C.token) return;
      C.failed=false; C.busy=false; C.points=data.points.map(p=>({
        channel:Number(p.channel),band:Number(p.band),
        wavelength_um:p.wavelength_um===null?null:Number(p.wavelength_um),
        brightness:p.brightness===null?null:Number(p.brightness),
        nhits:p.nhits,flags:p.flags
      }));
      const suspect=C.points.filter(p=>Number.isFinite(p.brightness) && p.flags).length;
      $('cubeQuality').textContent = `${suspect} channels have non-zero FLAGS. NHITS and bitmask values are in each point tooltip and CSV.`;
      status(`${data.valid_channels} / 102 channels available${data.cached?' · cached':''}. `+
        'DR1 mosaic combines observing epochs; this is not a time-resolved spectrum.');
      $('cubeRetry').hidden=true;
      draw();
    } catch(err) {
      if(token!==C.token || (controller.signal.aborted && !timedOut)) return;
      C.points=[]; C.failed=true; C.busy=false;
      empty('Cube spectrum unavailable — use Retry.');
      // The backend returns a short, actionable message, not a raw Python traceback.
      status(`The DR1 cube is temporarily unavailable. ${timedOut ? 'The request timed out after 3 minutes.' : (err.message || 'See the Python console and try Retry.')} Sky images and epoch measurements are unaffected.`);
      $('cubeRetry').hidden=false;
    } finally {
      clearTimeout(deadline);
      if(token===C.token) {
        C.busy=false; C.controller=null;
        updateButtons();
        if(C.points.length) $('cubeRetry').hidden=true;
      }
    }
  }
  function setPosition(ra,dec) {
    reset(); C.ra=Number(ra); C.dec=Number(dec);
    if(Number.isFinite(C.ra)&&Number.isFinite(C.dec)) query();
  }
  function exportCSV() {
    if(!C.points.length) return;
    const csv=['channel,band,wavelength_um,brightness_MJy_sr,nhits,flags',
      ...C.points.map(p=>[p.channel,p.band,p.wavelength_um??'',p.brightness??'',p.nhits??'',p.flags??''].join(','))].join('\r\n');
    const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));
    const a=document.createElement('a'); a.href=url;a.download='artemisos_dr1_cube_102.csv';a.click();
    setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  $('cubeGoodOnly').onchange=()=>{C.goodOnly=$('cubeGoodOnly').checked;draw();};
  $('cubeScale').onchange=()=>{C.scale=$('cubeScale').value;draw();};
  $('cubeRetry').onclick=query;
  $('cubeCsv').onclick=exportCSV;
  window.ArtemisosCubeSpectrum={reset,setPosition};
  reset();
})();
