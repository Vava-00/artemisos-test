/* =========================================================================
   SPHEREx Sky Viewer · UI shell
   -------------------------------------------------------------------------
   This file contains ONLY interface behavior (toggles, zoom/pan, button
   states). It has no data, no timers and no network calls.

   Backend integration works in two directions:

   1) UI -> backend: the UI dispatches CustomEvents on `document`.
        spherex:search          { mode:'coordinates', ra, dec } | { mode:'name', name }
        spherex:bandchange      { band }                 (1–6)
        spherex:timelineselect  { id }                   (slider or tick clicked)
        spherex:playtoggle      { playing }
        spherex:settingschange  { intervalSeconds, periodYears }
        spherex:capture         { captured }
        spherex:comparetoggle   { active }
        spherex:compareadd      { id }
        spherex:compareremove   { id }
        spherex:compareselect   { id }                   (chip clicked)
        spherex:comparenav      { direction }            (-1 previous, 1 next)
        spherex:zoom            { zoom }
        spherex:imageerror      {}

   2) Backend -> UI: call the functions on `window.SphereXUI` (see bottom).

   Example:
        document.addEventListener('spherex:search', e => { ... });
        SphereXUI.setImage('https://.../image.png');
   ========================================================================= */
(() => {
  const $ = id => document.getElementById(id);
  const emit = (name, detail = {}) => document.dispatchEvent(new CustomEvent('spherex:' + name, { detail }));

  const U = { zoom: 1, x: 0, y: 0, items: [], currentId: null, savedIds: new Set(), playing: false };

  /* ---------- Search ---------- */
  function showError(msg = '') { $('err').textContent = msg; }

  $('modeSwitch').onchange = e => {
    const byName = e.target.checked;
    $('nameFields').hidden = !byName;
    $('coordFields').hidden = byName;
    $('modeText').textContent = byName ? 'Search by coordinates' : 'Search by name';
    showError();
  };
  $('searchForm').onsubmit = e => {
    e.preventDefault();
    if ($('modeSwitch').checked) {
      const name = $('objName').value.trim();
      if (!name) return showError('Enter an object name.');
      showError(); emit('search', { mode: 'name', name });
    } else {
      const ra = parseFloat($('ra').value), dec = parseFloat($('dec').value);
      if (!(ra >= 0 && ra <= 360) || !(dec >= -90 && dec <= 90))
        return showError('Enter RA between 0 and 360 and DEC between −90 and 90.');
      showError(); emit('search', { mode: 'coordinates', ra, dec });
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
    return { intervalSeconds: Math.max(1, +$('intervalSeconds').value || 3), periodYears: Math.max(0.5, +$('periodYears').value || 1) };
  }
  const settingsChanged = () => {
    const s = getSettings(); $('intervalSeconds').value = s.intervalSeconds; $('periodYears').value = s.periodYears;
    emit('settingschange', s);
  };
  $('intervalSeconds').onchange = $('periodYears').onchange = settingsChanged;

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
  function setImage(url, alt = 'Sky image') {
    const img = $('skyImage');
    img.alt = alt; img.src = url; img.hidden = false; $('emptyMsg').hidden = true;
  }
  function clearImage(message = 'No image loaded') {
    $('skyImage').hidden = true; $('skyImage').removeAttribute('src');
    $('emptyMsg').textContent = message; $('emptyMsg').hidden = false;
  }
  $('skyImage').onerror = () => { clearImage('Could not load image'); emit('imageerror'); };
  function setInfo({ date = '—', details = '' } = {}) { $('date').textContent = date; $('details').textContent = details; }

  /* ---------- Zoom and pan ---------- */
  function applyTransform() {
    const r = $('frame').getBoundingClientRect(), mx = (U.zoom - 1) * r.width / 2, my = (U.zoom - 1) * r.height / 2;
    U.x = Math.max(-mx, Math.min(mx, U.x)); U.y = Math.max(-my, Math.min(my, U.y));
    $('skyImage').style.transform = `translate(${U.x}px,${U.y}px) scale(${U.zoom})`;
    $('frame').style.cursor = U.zoom > 1 ? '' : 'default';
  }
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
    setCompareList, setCompareOptions
  };
})();
