/* Artemisos · optional WISE module (AllWISE Atlas).
 * Two independent views, both separate from app.js:
 *   1) "Compare with WISE": side-by-side panel (switch in the sidebar).
 *   2) "Overlay WISE": WISE drawn ON TOP of the SPHEREx image, re-sampled by
 *      the backend onto the SPHEREx pixel grid (WCS-aligned). Quick search only.
 * It sends NO request until (a) a SPHEREx search has resolved a sky position
 * and (b) one of the two views is switched on. It never blocks the viewer.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const S = {
    on: false, overlay: false, sky: null, bands: {}, band: null,
    serial: 0, ovSerial: 0, controller: null, loaded: false
  };
  const needed = () => S.on || S.overlay;
  const sky = $('skyImage');
  const frame = $('frame');

  /* ---------- Overlay layer (inside the SPHEREx frame) ---------- */
  const ov = document.createElement('img');
  ov.id = 'wiseOverlayImg'; ov.className = 'wise-overlay'; ov.alt = 'WISE overlay';
  ov.hidden = true; ov.draggable = false;
  ov.style.opacity = String(Number($('wiseOpacity').value) / 100);
  frame.insertBefore(ov, frame.querySelector('.zoom'));
  // Follow the viewer's zoom/pan without touching app.js: it writes the
  // transform on #skyImage, so mirror that style onto the overlay.
  const syncTransform = () => { ov.style.transform = sky.style.transform; };
  new MutationObserver(syncTransform).observe(sky, {attributes: true, attributeFilter: ['style']});

  const ovNote = message => { $('wiseOverlayNote').textContent = message || ''; };
  function syncOverlayUi() {
    const btn = $('wiseOverlayBtn');
    btn.disabled = !S.sky;
    btn.setAttribute('aria-pressed', S.overlay ? 'true' : 'false');
    btn.textContent = S.overlay ? 'Hide WISE overlay' : 'Overlay WISE';
    $('wiseOverlayBar').hidden = !S.overlay;
  }
  function clearOverlay() {
    ++S.ovSerial;
    ov.hidden = true;
    ov.removeAttribute('src');
  }
  // The viewer's current image URL tells us which SPHEREx exposure/mode is shown.
  function viewerSource() {
    if (sky.hidden || !sky.getAttribute('src')) return null;
    try {
      const u = new URL(sky.src, window.location.href);
      return {url: u.searchParams.get('url'), mode: u.searchParams.get('mode') || 'quick'};
    } catch (_) { return null; }
  }
  function refreshOverlay() {
    if (!S.overlay) return;
    if (!S.sky) { clearOverlay(); ovNote('Search the sky first.'); return; }
    const item = S.bands[S.band];
    if (!item) { clearOverlay(); ovNote(S.loaded ? 'No WISE image covers this position.' : 'Searching the WISE archive…'); return; }
    const src = viewerSource();
    if (!src || !src.url) { clearOverlay(); ovNote('Waiting for the SPHEREx image…'); return; }
    if (src.mode === 'advanced') {
      clearOverlay();
      ovNote('The overlay needs Quick search (cutouts). Turn off Advanced search and search again.');
      return;
    }
    const serial = ++S.ovSerial;
    ov.hidden = true; // never leave a stale layer over a different exposure
    ovNote(`Aligning WISE W${S.band} (${item.label}) to the SPHEREx pixels…`);
    ov.onload = () => {
      if (serial !== S.ovSerial) return;
      ov.hidden = false; syncTransform();
      ovNote(`WISE W${S.band} (${item.label}) aligned to the SPHEREx field. Compare structure, not brightness.`);
    };
    ov.onerror = () => {
      if (serial !== S.ovSerial) return;
      ov.hidden = true;
      ovNote(`The WISE W${S.band} overlay could not be prepared for this observation.`);
    };
    ov.src = `/api/wise/overlay?${new URLSearchParams({
      wise: item.access_url, spherex: src.url, ra: String(S.sky.ra),
      dec: String(S.sky.dec), radio: String(S.sky.radius)})}`;
  }
  // Every time the viewer shows a new epoch/band, realign the overlay.
  sky.addEventListener('load', refreshOverlay);
  document.addEventListener('spherex:imageerror', clearOverlay);

  /* ---------- Side-by-side panel ---------- */
  function previewUrl(item) {
    return `/api/wise/preview?${new URLSearchParams({
      url: item.access_url, ra: String(S.sky.ra), dec: String(S.sky.dec),
      radio: String(S.sky.radius)})}`;
  }
  function empty(message) {
    $('wiseImage').hidden = true;
    $('wiseImage').removeAttribute('src');
    $('wiseEmpty').textContent = message;
    $('wiseEmpty').hidden = false;
    $('wiseDate').textContent = '—';
    $('wiseDetails').textContent = '';
    $('wiseDownload').hidden = true;
  }
  function loading(message) {
    $('wiseLoading').hidden = !message;
    if (message) $('wiseLoadingText').textContent = message;
  }
  function paintBands() {
    document.querySelectorAll('[data-wband]').forEach(btn => {
      const n = Number(btn.dataset.wband);
      btn.disabled = !S.bands[n];
      btn.setAttribute('aria-pressed', n === S.band);
    });
  }
  function reset(message) {
    ++S.serial;
    if (S.controller) S.controller.abort();
    S.controller = null; S.bands = {}; S.band = null; S.loaded = false;
    paintBands(); loading(''); empty(message); clearOverlay();
  }

  function showPanelBand(n) {
    const item = S.bands[n];
    if (!item) return;
    const serial = ++S.serial;
    loading(`Preparing WISE W${n}…`);
    const img = $('wiseImage');
    img.onload = () => {
      if (serial !== S.serial) return;
      loading('');
      img.hidden = false; $('wiseEmpty').hidden = true;
    };
    img.onerror = () => {
      if (serial !== S.serial) return;
      loading('');
      empty(`The WISE W${n} image could not be prepared. Try another band.`);
    };
    img.alt = `WISE W${n} (${item.label}) at the searched position`;
    img.src = previewUrl(item);
    $('wiseDate').textContent = `W${n} · ${item.label}`;
    $('wiseDetails').textContent = `AllWISE Atlas · FITS cutout · ${item.obs_id}`;
    $('wiseDownload').href = item.access_url;
    $('wiseDownload').hidden = false;
  }
  function showBand(n) {
    if (!S.bands[n]) return;
    S.band = n; paintBands();
    if (S.on) showPanelBand(n);
    if (S.overlay) refreshOverlay();
  }

  async function load() {
    if (!needed() || !S.sky || S.loaded) return;
    const serial = ++S.serial;
    if (S.controller) S.controller.abort();
    S.controller = new AbortController();
    if (S.on) loading('Searching the WISE archive…');
    if (S.overlay) ovNote('Searching the WISE archive…');
    try {
      const query = new URLSearchParams({
        ra: String(S.sky.ra), dec: String(S.sky.dec), radio: String(S.sky.radius)});
      const response = await fetch(`/api/wise/buscar?${query}`, {signal: S.controller.signal});
      let data;
      try { data = await response.json(); }
      catch (_) { throw new Error('The server returned an invalid WISE response.'); }
      if (serial !== S.serial) return;
      if (!response.ok || data.status !== 'ok') throw new Error(data.mensaje || 'WISE search failed.');
      S.bands = {};
      for (const [key, item] of Object.entries(data.bands || {})) S.bands[Number(key)] = item;
      S.loaded = true;
      const first = [1, 2, 3, 4].find(n => S.bands[n]);
      if (!first) {
        loading(''); paintBands(); empty('No WISE images cover this position.');
        if (S.overlay) ovNote('No WISE images cover this position.');
        return;
      }
      paintBands();
      showBand(S.band && S.bands[S.band] ? S.band : first);
    } catch (err) {
      if (serial !== S.serial || (err && err.name === 'AbortError')) return;
      loading('');
      const message = err instanceof TypeError
        ? 'Unable to contact the local server. Check your connection and try again.'
        : (err.message || 'WISE data are unavailable right now.');
      empty(message);
      if (S.overlay) { clearOverlay(); ovNote(message); }
    }
  }
  function cancelIfIdle() {
    if (needed()) return;
    ++S.serial;
    if (S.controller) S.controller.abort();
    S.controller = null; loading('');
  }

  /* ---------- Controls ---------- */
  $('wiseSwitch').onchange = event => {
    S.on = !!event.target.checked;
    $('wisePanel').hidden = !S.on;
    document.querySelector('.viewer').classList.toggle('with-wise', S.on);
    if (!S.on) { cancelIfIdle(); return; }
    if (!S.sky) empty('Search the sky first to compare with WISE.');
    else if (S.loaded && S.band) showPanelBand(S.band);
    else load();
  };
  $('wiseOverlayBtn').onclick = () => {
    S.overlay = !S.overlay;
    syncOverlayUi();
    if (!S.overlay) { clearOverlay(); cancelIfIdle(); return; }
    if (!S.sky) { ovNote('Search the sky first.'); return; }
    if (S.loaded && S.band) refreshOverlay();
    else load();
  };
  $('wiseOpacity').oninput = event => {
    ov.style.opacity = String(Number(event.target.value) / 100);
  };
  document.querySelectorAll('[data-wband]').forEach(btn => {
    btn.onclick = () => showBand(Number(btn.dataset.wband));
  });
  // A new search clears the previous WISE view; the switch/button state is kept.
  document.addEventListener('spherex:search', () => {
    S.sky = null;
    reset('Search the sky first to compare with WISE.');
    syncOverlayUi();
    if (S.overlay) ovNote('Search the sky first.');
  });
  document.addEventListener('spherex:skyresolved', event => {
    S.sky = {ra: event.detail.ra, dec: event.detail.dec, radius: event.detail.radius};
    reset('Waiting for WISE…');
    syncOverlayUi();
    if (needed()) load();
    if (!S.on) empty('Switch on “Compare with WISE” to see this position in WISE.');
  });
  window.ArtemisosWise = {reset};
  reset('Search the sky first to compare with WISE.');
  syncOverlayUi();
})();