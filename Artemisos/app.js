/* =========================================================================
   SPHEREx Sky Viewer · UI shell
   -------------------------------------------------------------------------
   This file combines the original UI shell with the IRSA/SPHEREx controller.
   The UI emits CustomEvents and SphereXController connects them to api.py.

   Backend integration works in two directions:

   1) UI -> backend: the UI dispatches CustomEvents on `document`.
        spherex:search          { queryType:'quick'|'advanced', mode:'coordinates', ra, dec } | { mode:'name', name }
        spherex:bandchange      { band }                 (1–6)
        spherex:timelineselect  { id }                   (slider or tick clicked)
        spherex:playtoggle      { playing }
        spherex:settingschange  { intervalSeconds, periodDays }
        spherex:capture         { captured }
        spherex:comparetoggle   { active }
        spherex:compareadd      { id }
        spherex:compareremove   { id }
        spherex:compareselect   { id }                   (chip clicked)
        spherex:comparenav      { direction }            (-1 previous, 1 next)
        spherex:zoom            { zoom }
        spherex:imageerror      {}
        spherex:imageload       {}

   2) Backend -> UI: call the functions on `window.SphereXUI` (see bottom).

   Example:
        document.addEventListener('spherex:search', e => { ... });
        SphereXUI.setImage('https://.../image.png');
   ========================================================================= */
(() => {
  const $ = id => document.getElementById(id);
  const emit = (name, detail = {}) => document.dispatchEvent(new CustomEvent('spherex:' + name, { detail }));

  const U = { zoom: 1, x: 0, y: 0, items: [], currentId: null, savedIds: new Set(), playing: true };

  /* ---------- Search ---------- */
  function showError(msg = '') { $('err').textContent = msg; }

  $('modeSwitch').onchange = e => {
    const byName = e.target.checked;
    $('nameFields').hidden = !byName;
    $('coordFields').hidden = byName;
    // Keep the label fixed: an enabled switch means search by object name.
    showError();
  };
   // Two independent toggles: target (coordinates/name) and image source
   // (cutout/full FITS). Changing either never triggers a search by itself.
   $('querySwitch').onchange = e => {
     const advanced = !!e.target.checked;
     // La etiqueta queda fija: el interruptor encendido indica FITS completos.
     $('queryCurrent').textContent = advanced ? 'Advanced search:' : 'Quick search:';
     $('queryDescription').textContent = advanced
       ? 'Entire FITS files; large downloads and a wider field of view.'
       : 'FITS cutouts centered on your coordinates.';
     showError();
   };
   $('searchForm').onsubmit = e => {
    e.preventDefault();
    if ($('modeSwitch').checked) {
      const name = $('objName').value.trim();
      if (!name) return showError('Enter an object name.');
      showError(); emit('search', { mode: 'name', name,
        queryType: $('querySwitch').checked ? 'advanced' : 'quick' });
    } else {
      const ra = parseFloat($('ra').value), dec = parseFloat($('dec').value);
      if (!(ra >= 0 && ra <= 360) || !(dec >= -90 && dec <= 90))
        return showError('Enter RA between 0 and 360 and DEC between −90 and 90.');
      showError(); emit('search', { mode: 'coordinates', ra, dec,
        queryType: $('querySwitch').checked ? 'advanced' : 'quick' });
    }
  };

  /* ---------- Playback settings and button ---------- */
  const ICON_PLAY = '<path d="M8 5v14l11-7z"/>', ICON_PAUSE = '<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>';
  function setPlaying(on) {
    U.playing = !!on;
    $('playIcon').innerHTML = U.playing ? ICON_PAUSE : ICON_PLAY;
    $('play').setAttribute('aria-label', U.playing ? 'Pause' : 'Play');
  }
  $('play').onclick = () => { setPlaying(!U.playing); emit('playtoggle', { playing: U.playing }); };
  function getSettings() {
    return {
      intervalSeconds: Math.max(1, +$('intervalSeconds').value || 3),
      periodDays: Math.max(1, Math.round(+$('periodDays').value || 1))
    };
  }
  const settingsChanged = () => {
    const s = getSettings(); $('intervalSeconds').value = s.intervalSeconds; $('periodDays').value = s.periodDays;
    emit('settingschange', s);
  };
  $('intervalSeconds').onchange = $('periodDays').onchange = settingsChanged;

  /* ---------- IR bands ---------- */
  function setBand(n) {
    document.querySelectorAll('.band').forEach(b => b.setAttribute('aria-pressed', +b.dataset.band === n));
  }
  /** availability: array of 6 booleans, e.g. [true,true,true,true,true,false] */
  function setBandAvailability(av) {
    document.querySelectorAll('.band').forEach((b, k) => { b.disabled = !av[k]; });
  }
  document.querySelectorAll('.band').forEach(b => b.onclick = () => { setBand(+b.dataset.band); emit('bandchange', { band: +b.dataset.band }); });

  /* ---------- Image, date and details ---------- */
  function setImage(url, alt = 'Sky image', id = '') {
    const img = $('skyImage');
    showTargetMarker(null);
    img.alt = alt; img.dataset.exposureId = id; img.src = url; img.hidden = false; $('emptyMsg').hidden = true;
  }
  function clearImage(message = 'No image loaded') {
    $('skyImage').hidden = true; $('skyImage').removeAttribute('src');showTargetMarker(null);
    $('emptyMsg').textContent = message; $('emptyMsg').hidden = false;
  }
  $('skyImage').onerror = () => emit('imageerror', { id: $('skyImage').dataset.exposureId });
  $('skyImage').onload = () => emit('imageload', { id: $('skyImage').dataset.exposureId });
  function setInfo({ date = '—', details = '' } = {}) { $('date').textContent = date; $('details').textContent = details; }

  /* ---------- Zoom and pan ---------- */
  function applyTransform() {
    const r = $('frame').getBoundingClientRect(), mx = (U.zoom - 1) * r.width / 2, my = (U.zoom - 1) * r.height / 2;
    U.x = Math.max(-mx, Math.min(mx, U.x)); U.y = Math.max(-my, Math.min(my, U.y));
    $('skyImage').style.transform = `translate(${U.x}px,${U.y}px) scale(${U.zoom})`;
    markerPosition();
    $('frame').style.cursor = U.zoom > 1 ? '' : 'default';
  }
  function imageGeometry() {
    const im=$('skyImage'), r=$('frame').getBoundingClientRect();
    const nw=im.naturalWidth || 1, nh=im.naturalHeight || 1;
    const scale=Math.min(r.width/nw,r.height/nh);
    return {r,w:nw*scale,h:nh*scale};
  }
  function imageClickPosition(event) {
    const {r,w,h}=imageGeometry();
    if(!$('skyImage').naturalWidth) return null;
    const ix=((event.clientX-r.left-r.width/2-U.x)/U.zoom+r.width/2-(r.width-w)/2)/w;
    const iy=((event.clientY-r.top-r.height/2-U.y)/U.zoom+r.height/2-(r.height-h)/2)/h;
    if(ix<0||ix>1||iy<0||iy>1) return null;
    return {u:ix,v:iy};
  }
  function markerPosition() {
    if(!U.marker) return;
    const {r,w,h}=imageGeometry();
    const origX=(r.width-w)/2+U.marker.u*w;
    const origY=(r.height-h)/2+U.marker.v*h;
    $('targetMarker').style.left=(r.width/2+U.x+(origX-r.width/2)*U.zoom)+'px';
    $('targetMarker').style.top=(r.height/2+U.y+(origY-r.height/2)*U.zoom)+'px';
  }
  function showTargetMarker(point) {
    U.marker=point;
    $('targetMarker').hidden=!point;
    if(point) markerPosition();
  }
  let markerStart=null;
  $('frame').addEventListener('click', e => {
    if(!$('pickTarget').checked || !$('loadingOverlay').hidden || e.target.closest('.zoom')) return;
    if(markerStart && Math.hypot(e.clientX-markerStart.x,e.clientY-markerStart.y)>5) return;
    const pos=imageClickPosition(e);
    if(pos) emit('targetclick',{...pos,id:$('skyImage').dataset.exposureId});
  });
  function zoomBy(d) {
    U.zoom = Math.max(1, Math.min(5, U.zoom + d));
    if (U.zoom === 1) U.x = U.y = 0;
    applyTransform(); emit('zoom', { zoom: U.zoom });
  }
  function resetZoom() { U.zoom = 1; U.x = U.y = 0; applyTransform(); }
  $('zin').onclick = () => zoomBy(.5);
  $('zout').onclick = () => zoomBy(-.5);
  $('frame').addEventListener('wheel', e => { e.preventDefault(); zoomBy(e.deltaY < 0 ? .25 : -.25); }, { passive: false });
  let drag = null;
  $('frame').addEventListener('pointerdown', e => {
    if (e.target.closest('.zoom') || U.zoom === 1) return;
    drag = { x: e.clientX - U.x, y: e.clientY - U.y };
    $('frame').setPointerCapture(e.pointerId); $('frame').classList.add('drag');
  });
  $('frame').addEventListener('pointermove', e => { if (!drag) return; U.x = e.clientX - drag.x; U.y = e.clientY - drag.y; applyTransform(); });
  ['pointerup', 'pointercancel'].forEach(t => $('frame').addEventListener(t, () => { drag = null; $('frame').classList.remove('drag'); }));
  $('frame').addEventListener('pointerdown', e => {markerStart={x:e.clientX,y:e.clientY};});
  window.addEventListener('resize', applyTransform);

  /* ---------- Timeline ---------- */
  /** items: [{ id, label }]  — one entry per available image/date, in order */
  function setTimeline(items) {
    U.items = items;
    const n = Math.max(1, Math.ceil(items.length / 8));
    $('ticks').innerHTML = '';
    items.forEach((it, k) => {
      const t = document.createElement('button');
      t.className = 'tick'; t.title = it.label; t.setAttribute('aria-label', it.label);
      if (k % n === 0) { const s = document.createElement('span'); s.textContent = it.label; t.append(s); }
      t.onclick = () => selectTimeline(it.id);
      $('ticks').append(t);
    });
    $('slider').max = Math.max(0, items.length - 1);
    $('slider').disabled = items.length === 0;
    paintTimeline();
  }
  function paintTimeline() {
    const p = U.items.findIndex(i => i.id === U.currentId);
    $('slider').value = Math.max(0, p);
    document.querySelectorAll('.tick').forEach((t, k) => {
      t.classList.toggle('cur', k === p);
      t.classList.toggle('saved', U.savedIds.has(U.items[k].id));
    });
  }
  function setTimelineCurrent(id) { U.currentId = id; paintTimeline(); }
  /** ids of dates saved in the comparison (shown as gold dots) */
  function setTimelineSaved(ids) { U.savedIds = new Set(ids); paintTimeline(); }
  function selectTimeline(id) { setTimelineCurrent(id); emit('timelineselect', { id }); }
  $('slider').oninput = e => { const it = U.items[+e.target.value]; if (it) selectTimeline(it.id); };

  /* ---------- Capture ---------- */
  function setCaptured(on) {
    $('capture').setAttribute('aria-pressed', !!on);
    $('capture').title = on ? 'Remove captured point' : 'Capture point';
  }
  $('capture').onclick = () => {
    const on = $('capture').getAttribute('aria-pressed') !== 'true';
    setCaptured(on); emit('capture', { captured: on });
  };

  /* ---------- Comparison ---------- */
  $('compareBtn').onclick = () => {
    const active = $('compareBtn').getAttribute('aria-pressed') !== 'true';
    $('compareBtn').setAttribute('aria-pressed', active);
    $('cmpPanel').hidden = !active; $('prev').hidden = $('next').hidden = !active;
    emit('comparetoggle', { active });
  };
  $('prev').onclick = () => emit('comparenav', { direction: -1 });
  $('next').onclick = () => emit('comparenav', { direction: 1 });
  $('addBtn').onclick = () => { if ($('addSel').value !== '') emit('compareadd', { id: $('addSel').value }); };
  /** items: [{ id, label, title? }]  — dates saved for comparison; currentId highlights one */
  function setCompareList(items, currentId = null) {
    const box = $('chips'); box.innerHTML = '';
    if (!items.length) { const p = document.createElement('p'); p.textContent = 'No dates yet. Add one above or use Capture point.'; box.append(p); return; }
    items.forEach(it => {
      const c = document.createElement('button');
      c.className = 'chip' + (it.id === currentId ? ' cur' : ''); c.title = it.title || it.label;
      const s = document.createElement('span'); s.textContent = it.label;
      const x = document.createElement('b'); x.setAttribute('role', 'button'); x.setAttribute('aria-label', 'Remove ' + it.label); x.textContent = '×';
      c.append(s, x);
      c.onclick = e => emit(e.target === x ? 'compareremove' : 'compareselect', { id: it.id });
      box.append(c);
    });
  }
  /** items: [{ id, label }]  — dates that can still be added */
  function setCompareOptions(items) {
    $('addSel').innerHTML = ''; items.forEach(it => $('addSel').add(new Option(it.label, it.id)));
    $('addSel').disabled = $('addBtn').disabled = items.length === 0;
  }

  /* ---------- Misc ---------- */
  function setCoordinates(ra, dec) { $('ra').value = ra; $('dec').value = dec; }
  function setNameSuggestions(names) { $('nameSuggestions').innerHTML = ''; names.forEach(n => $('nameSuggestions').append(new Option(n))); }

  /* ---------- Public API ---------- */
  window.SphereXUI = {
    setImage, clearImage, setInfo, setCoordinates, setNameSuggestions, showError,
    setTimeline, setTimelineCurrent, setTimelineSaved,
    setBand, setBandAvailability,
    setCaptured, setPlaying, getSettings, resetZoom,
    setCompareList, setCompareOptions, showTargetMarker
  };
})();

/* =========================================================================
   SPHEREx controller: search, complete first-band loading, cache-aware
   previews and automatic playback. The overlay stays until all selected-band
   frames have finished loading (or have reported an error).
   ========================================================================= */
(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const ui = window.SphereXUI;
  const state = {
    bands: new Map(), saved: new Map(), currentByBand: new Map(),
    ready: new Map(), failed: new Map(),
    band: null, visible: [], comparing: false, timer: null,
    playingWanted: true, searchSerial: 0, bandSerial: 0,
    job: null, sky: null, waitingForImage: null, total: 0,
    // View requested by a shared link; apply only after the user presses Search.
    pendingView: null
  };

  const status = text => { $('status').textContent = text; };
  // A recovered catalog issue must not be treated as a fatal search error.
  const catalogNotice = message => {
    $('archiveNotice').textContent = message || '';
    $('archiveNotice').hidden = !message;
  };
  const errorText = err => err instanceof Error ? err.message : String(err);
  const labelFor = item => item.fecha && item.fecha !== 'Unknown date'
    ? item.fecha.replace(' UTC', '').slice(0, 16) : 'Unknown date';
  const asTimeline = item => ({ id: item.id, label: labelFor(item) });
  const sleepError = 'Could not prepare any images for this band. Try another band or position.';

  // Shareable links encode the region, view mode and active observation.
  // replaceState avoids adding history entries on every playback frame.
  // The internal search radius (0.02 degrees) is intentionally not exposed.
  function writeUrl(item = null) {
    if (!state.sky) return;
    const link = new URL(window.location.href);
    link.searchParams.set('ra', String(state.sky.ra));
    link.searchParams.set('dec', String(state.sky.dec));
    link.searchParams.set('view', state.sky.queryType);
    link.searchParams.delete('radio'); // Old links may contain this obsolete parameter.
    if (state.band != null && item) {
      link.searchParams.set('band', String(state.band));
      if (item.obs_id != null && String(item.obs_id).trim())
        link.searchParams.set('obs', String(item.obs_id));
      else
        link.searchParams.delete('obs');
    } else {
      link.searchParams.delete('band');
      link.searchParams.delete('obs');
    }
    window.history.replaceState(null, '', link.toString());
  }

  function overlay(message, show = true) {
    $('loadingOverlay').hidden = !show;
    $('loadingMessage').textContent = message;
    $('loadingOverlay').setAttribute('aria-busy', show ? 'true' : 'false');
  }
  // IRSA cutouts still use the fixed 0.02-degree radius, hidden from the UI.
  const DEFAULT_RADIUS_DEG = 0.02;
  function getRadius() { return DEFAULT_RADIUS_DEG; }
  function timerOff() {
    if (state.timer !== null) clearTimeout(state.timer);
    state.timer = null;
  }
  function savedSet() {
    if (!state.saved.has(state.band)) state.saved.set(state.band, new Set());
    return state.saved.get(state.band);
  }
  function readySet(band = state.band) {
    if (!state.ready.has(band)) state.ready.set(band, new Set());
    return state.ready.get(band);
  }
  function failedSet(band = state.band) {
    if (!state.failed.has(band)) state.failed.set(band, new Set());
    return state.failed.get(band);
  }
  function selectedItem() {
    return (state.bands.get(state.band) || []).find(it => it.id === state.currentByBand.get(state.band)) || null;
  }
  function availableItems() {
    // Period (days) sets the ANIMATION STEP, not an observation date filter.
    // Every date returned by IRSA remains accessible in the timeline.
    return state.bands.get(state.band) || [];
  }
  function previewUrl(item) {
    const q = new URLSearchParams({
      url: item.access_url, ra: String(state.sky.ra),
      dec: String(state.sky.dec), radio: String(state.sky.radius),
      mode: state.sky.queryType
    });
    return `/api/preview?${q}`;
  }
  function refreshComparison() {
    const saved = savedSet();
    const captured = state.visible.filter(it => saved.has(it.id));
    ui.setTimelineSaved(captured.map(it => it.id));
    ui.setCompareList(captured.map(it => ({
      ...asTimeline(it), title: `${it.fecha} | OBS ID: ${it.obs_id}`
    })), selectedItem()?.id);
    ui.setCompareOptions(state.visible.filter(it => !saved.has(it.id)).map(asTimeline));
    ui.setCaptured(!!selectedItem() && saved.has(selectedItem().id));
    window.ArtemisosSpectrum?.setSaved([...state.saved.values()].flatMap(set => [...set]));
  }
  function display(item) {
    timerOff();
    if (!item) {
      ui.clearImage('No image available for this date.');
      ui.setInfo();
      $('fitsDownload').hidden = true;
      return;
    }
    state.currentByBand.set(state.band, item.id);
    ui.setTimelineCurrent(item.id);
    const ra = Number(item.s_ra), dec = Number(item.s_dec);
    const position = Number.isFinite(ra) && Number.isFinite(dec)
      ? `Center: ${ra.toFixed(4)}°, ${dec.toFixed(4)}°` : 'Center unknown';
    const source = state.sky.queryType === 'advanced' ? 'Full FITS' : 'FITS cutout';
    ui.setInfo({ date: item.fecha || 'Unknown date',
      details: `${source} · Band ${state.band} · OBS ID: ${item.obs_id} · ${position}` });
    // Keep the viewer's zoom and pan across epochs and band changes.
    // Only a NEW sky search should restore the full-field view.
    ui.setImage(previewUrl(item), `SPHEREx Band ${state.band}, ${item.fecha}`, item.id);
    $('fitsDownload').href = item.access_url;
    $('fitsDownload').hidden = false;
    writeUrl(item);
    // Add-on observes the active epoch; it does not change image rendering.
    window.ArtemisosSpectrum?.setCurrent(item.id);
    refreshComparison();
    status(`Band ${state.band}: image ${state.visible.findIndex(ex => ex.id === item.id) + 1} of ${state.visible.length} · ${item.fecha}.`);
  }
  function showCurrentBand(preferredId = null) {
    state.visible = availableItems();
    ui.setBand(state.band || 1);
    ui.setTimeline(state.visible.map(asTimeline));
    if (!state.visible.length) {
      ui.clearImage('No observations for this band.');
      ui.setInfo();
      $('fitsDownload').hidden = true;
      refreshComparison();
      status('No observations in the selected band.');
      overlay('', false);
      return;
    }
    const good = readySet();
    const item = state.visible.find(it => it.id === (preferredId || state.currentByBand.get(state.band)) && good.has(it.id))
      || state.visible.find(it => it.mjd > 0 && good.has(it.id))
      || state.visible.find(it => good.has(it.id));
    if (!item) {
      ui.clearImage('No image could be prepared for this band.');
      ui.setInfo();
      $('fitsDownload').hidden = true;
      status(sleepError);
      overlay('', false);
      return;
    }
    state.waitingForImage = item.id;
    display(item); // img.onload will release the full-page viewer overlay
  }
  function clearData(message = 'Loading observations…', resetCube = true) {
    timerOff();
    catalogNotice('');
    state.bands.clear(); state.saved.clear(); state.currentByBand.clear();
    state.ready.clear(); state.failed.clear();
    state.band = null; state.visible = []; state.waitingForImage = null;
    // A different sky region must start with a fresh full-field view.
    ui.resetZoom();
    ui.setBandAvailability([false, false, false, false, false, false]);
    ui.setBand(0); ui.setTimeline([]); ui.setTimelineSaved([]);
    ui.setCompareList([]); ui.setCompareOptions([]); ui.setCaptured(false);
    ui.clearImage(message); ui.setInfo();
    $('fitsDownload').hidden = true;
    window.ArtemisosSpectrum?.reset();
    if (resetCube) window.ArtemisosCubeSpectrum?.reset();
    state.sampleTarget=null;state.coaddSerial++;
    $('targetReset').disabled=true;
    $('targetStatus').textContent='Spectrum target: search coordinates.';
    ui.showTargetMarker(null);
    $('coaddStart').disabled=true;$('coaddStatus').textContent='Search and choose a band to create a WCS-aligned stack.';
    $('coaddImage').hidden=true;$('coaddCount').hidden=true;
  }
  function checkResponse(response, data) {
    if (!response.ok || data.status !== 'ok')
      throw new Error(data.mensaje || `Request failed (HTTP ${response.status}).`);
    return data;
  }
  async function getJson(url, signal) {
    const response = await fetch(url, { signal });
    let payload;
    try { payload = await response.json(); }
    catch (_) {
      throw new Error('The server returned an invalid response. Please try again in a few minutes.');
    }
    return checkResponse(response, payload);
  }

  // Browser cache + disk cache on Flask: every preview is fully decoded before
  // releasing the overlay. Maximum 6 concurrent requests to avoid flooding IRSA.
  function preloadFrame(item, signal) {
    return new Promise(resolve => {
      if (signal.aborted) { resolve(false); return; }
      const img = new Image();
      let finished = false;
      // Full FITS can take much longer than a cutout; do not mark those
      // requests as failed after the quick-mode 45-second timeout.
      const timeout = setTimeout(() => finish(false),
        state.sky.queryType === 'advanced' ? 12 * 60 * 1000 : 45000);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        img.onload = img.onerror = null;
        signal.removeEventListener('abort', abort);
        if (!ok) img.src = '';
        resolve(ok);
      }
      const abort = () => finish(false);
      img.onload = () => finish(true);
      img.onerror = () => finish(false);
      signal.addEventListener('abort', abort, { once: true });
      img.src = previewUrl(item);
    });
  }

  async function warmBand(items, band, signal) {
    const ready = readySet(band), failed = failedSet(band);
    const missing = items.filter(it => !ready.has(it.id) && !failed.has(it.id));
    let done = items.length - missing.length;
    const total = items.length;
    const kind = state.sky.queryType === 'advanced' ? 'full FITS' : 'cutouts';
    overlay(`Preparing Band ${band} ${kind}: ${done} / ${total}`);
    if (!missing.length) return;
    let cursor = 0;
    let giveUp = false;
    const concurrency = state.sky.queryType === 'advanced' ? 2 : 6;
    const workers = Array.from({ length: Math.min(concurrency, missing.length) }, async () => {
      while (!signal.aborted && !giveUp && cursor < missing.length) {
        const item = missing[cursor++];
        const ok = await preloadFrame(item, signal);
        if (signal.aborted) return;
        if (ok) ready.add(item.id);
        else failed.add(item.id);
        done++;
        if (ready.size === 0 && failed.size >= 8) giveUp = true;
        overlay(`Preparing Band ${band} ${kind}: ${done} / ${total}`);
        status(`Loading ${kind} for Band ${band}: ${done} / ${total} (${failed.size} unavailable).`);
      }
    });
    await Promise.all(workers);
    if (giveUp) throw new Error('IRSA could not prepare the first images. Try reducing the search radius.');
  }

  async function prepareBand(band, preferredId = null) {
    const serial = ++state.bandSerial;
    if (state.job) state.job.abort();
    state.job = new AbortController();
    const signal = state.job.signal;
    state.band = band;
    state.coaddSerial++;
    $('coaddImage').hidden=true;$('coaddCount').hidden=true;
    $('coaddStatus').textContent=`Band ${band} selected. Stack is optional.`;
    window.ArtemisosSpectrum?.setBand(band);
    $('coaddStart').disabled=false;
    $('coaddStart').textContent=`Stack Band ${band}`;
    timerOff();
    state.visible = availableItems();
    ui.setBand(band);
    ui.clearImage('Preparing selected band…');
    if (!state.visible.length) {
      showCurrentBand(preferredId);
      return;
    }
    try {
      await warmBand(state.visible, band, signal);
      if (signal.aborted || serial !== state.bandSerial) return;
      showCurrentBand(preferredId);
    } catch (err) {
      if (signal.aborted || serial !== state.bandSerial) return;
      overlay('', false);
      status('Could not prepare the selected band.');
      ui.showError(errorText(err));
    }
  }

  async function search(detail) {
    const serial = ++state.searchSerial;
    ++state.bandSerial;
    if (state.job) state.job.abort();
    state.job = new AbortController();
    const signal = state.job.signal;
    ui.showError('');
    clearData('Searching SPHEREx…');
    overlay('Searching the SPHEREx archive…');
    try {
      const radius = getRadius();
      let ra = detail.ra, dec = detail.dec;
      if (detail.mode === 'name') {
        overlay(`Resolving the coordinates of “${detail.name}”…`);
        status('Resolving object name using SIMBAD/NED…');
        const named = await getJson(`/api/resolver?nombre=${encodeURIComponent(detail.name)}`, signal);
        if (serial !== state.searchSerial) return;
        ra = Number(named.ra); dec = Number(named.dec);
        ui.setCoordinates(ra, dec);
      }
      if (!Number.isFinite(ra) || ra < 0 || ra > 360 ||
          !Number.isFinite(dec) || dec < -90 || dec > 90)
        throw new Error('Invalid RA/DEC coordinates.');
      state.sky = { ra, dec, radius,
        queryType: detail.queryType === 'advanced' ? 'advanced' : 'quick' };
      // Optional WISE panel/overlay receives the resolved coordinates.
      // It only queries IRSA when the visitor enables a WISE view.
      document.dispatchEvent(new CustomEvent('spherex:skyresolved', {
        detail: {ra, dec, radius}
      }));
      // Start DR1 mosaic extraction independently of SIA catalog availability.
      // It never delays the image viewer and remains usable if SIA returns 502.
      window.ArtemisosCubeSpectrum?.setPosition(ra, dec);
      status('Searching the SPHEREx archive (DR1 + QR3)…');
      overlay('Retrieving available SPHEREx observations…');
      const q = new URLSearchParams({ ra: String(ra), dec: String(dec), radio: String(radius) });
      const data = await getJson(`/api/buscar?${q}`, signal);
      if (serial !== state.searchSerial) return;
      catalogNotice(data.aviso || '');
      state.total = data.total_encontrados;
      for (const [key, entries] of Object.entries(data.bandas_carrusel || {})) {
        const match = /^Band\s*([1-6])\b/i.exec(key);
        if (!match || !Array.isArray(entries)) continue;
        const band = Number(match[1]);
        const normalized = entries.filter(it => /^https:\/\//i.test(it.access_url || '')).map((it, ix) => ({
          ...it, id: `${band}:${ix}`, mjd: Number(it.mjd) || 0
        }));
        normalized.sort((a, b) => a.mjd - b.mjd);
        state.bands.set(band, normalized);
      }
      // The spectrum receives exactly the same observations/catalog as the
      // established viewer. No extra downloads until Generate spectrum.
      window.ArtemisosSpectrum?.setCatalog([...state.bands.values()].flat(), state.sky);
      const available = Array.from({ length: 6 }, (_, ix) => !!state.bands.get(ix + 1)?.length);
      ui.setBandAvailability(available);
      const first = available.findIndex(Boolean);
      if (first < 0) {
        clearData('No images available for this region.', false);
        catalogNotice(data.aviso || '');
        overlay('', false);
        status(data.partial
          ? 'No images were found in the available collection. IRSA did not return all observations.'
          : 'No SPHEREx observations found. Try another position.');
        return;
      }
      // A new search replaces the URL query and discards the previous view.
      writeUrl();
      status(`Found ${state.total} exposures. Preparing ${state.sky.queryType === 'advanced' ? 'full FITS' : 'cutouts'} in the first band…`);
      // Restore a shared-link band/observation ONLY after the user presses Search.
      let startBand = first + 1;
      let startId = null;
      const wanted = state.pendingView;
      state.pendingView = null;
      if (wanted && Math.abs(wanted.ra - ra) < 1e-4 && Math.abs(wanted.dec - dec) < 1e-4) {
        const inBand = state.bands.get(wanted.band) || [];
        if (inBand.length) {
          startBand = wanted.band;
          const match = inBand.find(it => String(it.obs_id) === wanted.obs);
          startId = match?.id || null; // Fall back to the first image if the observation is gone.
        }
      }
      // prepareBand takes ownership of its own AbortController.
      await prepareBand(startBand, startId);
    } catch (err) {
      if (signal.aborted || serial !== state.searchSerial) return;
      clearData('Could not load sky images.', false);
      overlay('', false);
      const message = err instanceof TypeError
        ? 'Unable to contact IRSA or the local server. Check your connection and try again.'
        : errorText(err);
      ui.showError(message);
      status('The search could not be completed. Please try again shortly.');
    }
  }

  function playbackPool() {
    const saved = savedSet();
    const good = readySet();
    const all = state.visible.filter(it => good.has(it.id));
    const compared = all.filter(it => saved.has(it.id));
    return state.comparing && compared.length > 1 ? compared : all;
  }
  // MJD is already measured in days (including fractional UTC days).
  // A period of N days means N * 24 hours after the currently shown exposure.
  // All actual exposures remain on the timeline, even when playback skips them.
  function nextPeriodFrame(pool) {
    if (pool.length < 2) return pool[0] || null;
    const id = selectedItem()?.id;
    const index = pool.findIndex(it => it.id === id);
    if (index < 0 || !(pool[index].mjd > 0)) return pool[0];
    if (index === pool.length - 1) return pool[0]; // loop from last to first
    const targetMjd = pool[index].mjd + ui.getSettings().periodDays;
    // Select the first REAL observation on/after the requested day jump.
    // If the archive ends earlier, show the last available frame once,
    // then loop to the beginning. Never fabricate an observation for 2014.
    return pool.slice(index + 1).find(it => it.mjd >= targetMjd - 1e-5)
      || pool[pool.length - 1];
  }

  function advance(direction = 1, comparisonOnly = false, byPeriod = false) {
    const pool = comparisonOnly
      ? state.visible.filter(it => savedSet().has(it.id) && readySet().has(it.id))
      : playbackPool();
    const available = pool.length ? pool : state.visible.filter(it => readySet().has(it.id));
    if (!available.length) return;
    if (byPeriod && direction > 0) {
      display(nextPeriodFrame(available));
      return;
    }
    const index = available.findIndex(it => it.id === selectedItem()?.id);
    const next = index < 0 ? (direction > 0 ? 0 : available.length - 1)
      : (index + direction + available.length) % available.length;
    display(available[next]);
  }
  function schedulePlayback() {
    timerOff();
    if (!state.playingWanted || playbackPool().length <= 1) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      if (!state.playingWanted || !$('loadingOverlay').hidden) return;
      advance(1, false, true);
      // Next timer starts only AFTER the next image is actually loaded.
    }, ui.getSettings().intervalSeconds * 1000);
  }
  function updateSaved(id, add) {
    if (!state.visible.some(it => it.id === id)) return;
    if (add) savedSet().add(id);
    else savedSet().delete(id);
    refreshComparison();
    schedulePlayback();
  }

  // WCS-aligned image stack is optional. It never holds the main viewer open.
  async function startStack() {
    if (!state.sky || !state.band || !state.visible.length) return;
    const serial=++state.coaddSerial, band=state.band;
    $('coaddStart').disabled=true;$('coaddImage').hidden=true;$('coaddCount').hidden=true;
    $('coaddStatus').textContent=`Submitting ${state.visible.length} Band ${band} exposures for WCS stacking…`;
    try {
      const response=await fetch('/api/stack/start',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ra:state.sky.ra,dec:state.sky.dec,band,
          access_urls:state.visible.map(it=>it.access_url)})});
      const d=await response.json();
      if(!response.ok || d.status!=='ok') throw new Error(d.mensaje || 'Stack could not start.');
      while(serial===state.coaddSerial) {
        const resp=await fetch(`/api/stack/status/${encodeURIComponent(d.job_id)}`);
        const info=await resp.json();
        if(!resp.ok) throw new Error(info.mensaje || 'Stack status unavailable.');
        if(serial!==state.coaddSerial) return;
        if(info.status==='ready') {
          $('coaddImage').src=`/api/stack/image/${encodeURIComponent(d.job_id)}`;
          $('coaddImage').hidden=false;
          $('coaddStatus').textContent=`Band ${band} WCS-aligned stack ready.`;
          $('coaddCount').textContent=`${info.included ?? 'Cached'} contributing exposures · `+
            `${info.failed ?? 0} unavailable · center-pixel coverage: ${info.center_pixel_contributors ?? '—'}.`;
          $('coaddCount').hidden=false;break;
        }
        if(info.status==='failed') throw new Error(info.message || 'Stack failed.');
        $('coaddStatus').textContent=`Band ${band}: ${info.done || 0} / ${info.total || state.visible.length} FITS processed…`;
        await new Promise(resolve=>setTimeout(resolve,1500));
      }
    } catch(err) {
      if(serial===state.coaddSerial) $('coaddStatus').textContent=err.message || 'Stack unavailable.';
    } finally {
      if(serial===state.coaddSerial) $('coaddStart').disabled=false;
    }
  }
  $('coaddStart').onclick=startStack;
  $('targetReset').onclick=()=>{
    if(!state.sky)return;
    state.sampleTarget=null;
    ui.showTargetMarker(null);
    $('targetReset').disabled=true;
    $('targetStatus').textContent='Spectrum target: search coordinates.';
    window.ArtemisosCubeSpectrum?.setPosition(state.sky.ra,state.sky.dec);
    window.ArtemisosSpectrum?.setTarget(state.sky.ra,state.sky.dec);
  };
  document.addEventListener('spherex:targetclick',async event=>{
    const item=selectedItem();
    if(!item || item.id!==event.detail.id || !state.sky)return;
    const q=new URLSearchParams({url:item.access_url,ra:String(state.sky.ra),dec:String(state.sky.dec),
      radio:String(state.sky.radius),mode:state.sky.queryType,
      u:String(event.detail.u),v:String(event.detail.v)});
    const current=item.id;
    $('targetStatus').textContent='Locating selected pixel with FITS WCS…';
    try {
      const response=await fetch(`/api/sky-at-pixel?${q}`), d=await response.json();
      if(!response.ok||d.status!=='ok') throw new Error(d.mensaje||'WCS conversion failed');
      if(selectedItem()?.id!==current) {
        $('targetStatus').textContent='Image changed before target selection; try again.';return;
      }
      state.sampleTarget={ra:d.ra,dec:d.dec};
      ui.showTargetMarker({u:event.detail.u,v:event.detail.v});
      $('targetReset').disabled=false;
      $('targetStatus').textContent=`Spectrum target: RA ${d.ra.toFixed(6)}°, DEC ${d.dec.toFixed(6)}°`;
      window.ArtemisosCubeSpectrum?.setPosition(d.ra,d.dec);
      window.ArtemisosSpectrum?.setTarget(d.ra,d.dec);
    } catch(err){$('targetStatus').textContent=err.message||'Unable to convert clicked pixel.';}
  });
  document.addEventListener('spherex:search', event => search(event.detail));
  document.addEventListener('spherex:bandchange', event => {
    if (!state.bands.get(event.detail.band)?.length) return;
    prepareBand(event.detail.band);
  });
  document.addEventListener('spherex:spectrumselect', event => {
    // A clicked spectrum dot opens its corresponding epoch and detector.
    const target = [...state.bands.entries()].find(([, items]) =>
      items.some(it => it.id === event.detail.id));
    if (!target) return;
    const [band, items] = target;
    const item = items.find(it => it.id === event.detail.id);
    if (band !== state.band || !readySet(band).has(item.id)) prepareBand(band, item.id);
    else display(item);
  });
  document.addEventListener('spherex:timelineselect', event => {
    const item = state.visible.find(it => it.id === event.detail.id);
    if (item) display(item); // selecting a date is NOT a manual Pause
  });
  document.addEventListener('spherex:playtoggle', event => {
    state.playingWanted = !!event.detail.playing;
    if (!state.playingWanted) timerOff();
    else if ($('loadingOverlay').hidden && state.visible.length) schedulePlayback();
  });
  document.addEventListener('spherex:settingschange', () => {
    // Changes affect only the NEXT playback step / interval. Do not requery
    // IRSA, prefetch again, reset the displayed date or reset the zoom.
    if (state.playingWanted && $('loadingOverlay').hidden) schedulePlayback();
  });
  document.addEventListener('spherex:capture', event => {
    const item = selectedItem();
    if (!item) { ui.setCaptured(false); return; }
    updateSaved(item.id, event.detail.captured);
  });
  document.addEventListener('spherex:comparetoggle', event => {
    state.comparing = event.detail.active;
    refreshComparison();
    schedulePlayback();
  });
  document.addEventListener('spherex:compareadd', event => updateSaved(event.detail.id, true));
  document.addEventListener('spherex:compareremove', event => updateSaved(event.detail.id, false));
  document.addEventListener('spherex:compareselect', event => {
    const item = state.visible.find(it => it.id === event.detail.id);
    if (item) display(item);
  });
  document.addEventListener('spherex:comparenav', event => advance(event.detail.direction, true));
  document.addEventListener('spherex:imageload', event => {
    const current = selectedItem();
    if (!current || current.id !== event.detail.id) return;
    readySet().add(current.id);
    failedSet().delete(current.id);
    if (state.waitingForImage === current.id) {
      state.waitingForImage = null;
      overlay('', false);
      status(`Ready: ${state.total} observations found; Band ${state.band} ${state.sky.queryType === 'advanced' ? 'full FITS' : 'cutouts'} prepared (${readySet().size} images).`);
    }
    schedulePlayback();
  });
  document.addEventListener('spherex:imageerror', event => {
    const current = selectedItem();
    if (!current || current.id !== event.detail.id) return;
    failedSet().add(current.id); readySet().delete(current.id);
    if (state.waitingForImage) {
      state.waitingForImage = null;
      showCurrentBand();
    } else {
      status(`Image unavailable (OBS ID ${current.obs_id}). Choose another date.`);
      schedulePlayback();
    }
  });

  ui.setPlaying(true); // Armed for autoplay AFTER the user searches.
  clearData('Enter coordinates or an object name, then press Search.');
  overlay('', false);
  status('Enter coordinates or an object name, then press Search.');

  // Shareable links can prefill the form, but must NEVER start a search
  // automatically: the user explicitly presses Search even for URL parameters.
  const params = new URLSearchParams(window.location.search);
  if (params.get('view') === 'advanced') {
    $('querySwitch').checked = true;
    $('querySwitch').onchange({target: $('querySwitch')});
  }
  if (params.has('ra') || params.has('dec')) {
    const rawRa = params.get('ra'), rawDec = params.get('dec');
    const ra = Number(rawRa), dec = Number(rawDec);
    // Ignore the obsolete radius on old links; always use DEFAULT_RADIUS_DEG.
    if (rawRa?.trim() && rawDec?.trim() &&
        Number.isFinite(ra) && ra >= 0 && ra <= 360 &&
        Number.isFinite(dec) && dec >= -90 && dec <= 90) {
      ui.setCoordinates(ra, dec);
      // Band/observation URL parameters never trigger loading or playback on their own.
      const band = Number(params.get('band'));
      if (Number.isInteger(band) && band >= 1 && band <= 6) {
        state.pendingView = {
          ra, dec, band, obs: (params.get('obs') || '').slice(0, 200)
        };
      }
      status('Coordinates loaded from the link. Press Search to view the sky.');
    } else {
      ui.showError('Invalid URL coordinates. Enter valid coordinates to search.');
    }
  }
})();
