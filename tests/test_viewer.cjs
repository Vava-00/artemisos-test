// Zero-dependency integration checks for SPHEREx browser controller.
// Run: node tests/test_viewer.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/index.html'), 'utf8');
const script = fs.readFileSync(path.join(root, 'static/js/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'static/css/styles.css'), 'utf8');
const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map(match => match[1]);

class FakeEl {
  constructor(id = '') {
    this.id = id;
    this.style = {};
    this.dataset = {};
    this.children = [];
    this.attributes = {};
    this.listeners = {};
    this.value = '';
    this.checked = false;
    this.hidden = false;
    this.disabled = false;
    this.textContent = '';
    this.className = '';
    this.classList = { add(){}, remove(){}, toggle(){} };
  }
  get src() { return this._src; }
  set src(url) { this._src = url; if (url) queueMicrotask(() => this.onload?.()); }
  get innerHTML() { return this._html; }
  set innerHTML(value) { this._html = value; this.children = []; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  removeEventListener(k, fn) { this.listeners[k] = (this.listeners[k] ?? []).filter(x => x !== fn); }
  addEventListener(k, fn) { (this.listeners[k] ??= []).push(fn); }
  append(...items) { this.children.push(...items); }
  add(item) { this.children.push(item); this.value ||= item.value; }
  setPointerCapture() {}
  getBoundingClientRect() { return {width: 600, height: 600}; }
}
const el = Object.fromEntries(ids.map(id => [id, new FakeEl(id)]));
const bands = Array.from({ length: 6 }, (_, ix) => Object.assign(new FakeEl(), {dataset: {band: String(ix + 1)}}));
el.intervalSeconds.value = '3'; el.periodDays.value = '2';
const listeners = {};
const document = {
  getElementById(id) { if (!el[id]) throw new Error('HTML ID missing: ' + id); return el[id]; },
  querySelectorAll(selector) {
    if (selector === '.band') return bands;
    if (selector === '.tick') return el.ticks.children;
    throw new Error('Unexpected CSS selector: ' + selector);
  },
  createElement: tag => new FakeEl(tag),
  addEventListener(type, listener) { (listeners[type] ??= []).push(listener); },
  dispatchEvent(event) { for (const listener of listeners[event.type] ?? []) listener(event); },
};
const julianEpoch = Date.UTC(1858, 10, 17);
const mjd = isoDate => (Date.parse(`${isoDate}T00:00:00Z`) - julianEpoch) / 86400000;
function exposure(isoDate, band, ix = 0) {
  return {obs_id: `${band}-${isoDate}-${ix}`, date: `${isoDate} 00:00:00 UTC`, mjd: mjd(isoDate) + ix / 1440,
    access_url: `https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/e${band}_${isoDate}_${ix}.fits`,
    s_ra: 12.4, s_dec: -2.5};
}
// Deliberately FAKE observations: all dates must stay available even when Play skips some.
const records = {
  'Band 1': ['2025-05-01','2025-05-02','2025-05-03','2025-05-04','2025-05-05','2025-05-08'].map(date => exposure(date, 1)),
  'Band 3': ['2025-05-30','2025-06-01'].map(date => exposure(date, 3)),
};
let response = {status: 'ok', total_found: 8, bands: records};
let calls = [];
async function fetch(url) {
  const parsed = new URL(url, 'http://localhost:5000');
  calls.push(parsed.toString());
  if (parsed.pathname === '/api/search') return {ok: true, status: 200, json: async () => response};
  if (parsed.pathname === '/api/resolve') return {ok: true, status: 200,
    json: async () => ({status: 'ok', ra: 42, dec: -17})};
  throw new Error('Unexpected request: ' + url);
}
let timerIndex = 0;
const timers = new Map();
const window = {location: new URL('http://localhost:5000/'), history: {
  replaceState(_state, _title, url) { window.location = new URL(url); }
}, addEventListener(){}};
const context = {document, window, fetch, URL, URLSearchParams, AbortController,
  Image: FakeEl, CustomEvent: class {constructor(type, input) {this.type = type; this.detail = input.detail;}},
  Option: class {constructor(text, value) {this.text = text; this.value = value;}},
  setTimeout(fn, ms) {const id = ++timerIndex; timers.set(id, {fn, ms}); return id;},
  clearTimeout(id) {timers.delete(id);}, console, queueMicrotask};
vm.createContext(context);
vm.runInContext(script, context);
const flush = async () => { for (let i = 0; i < 90; i++) await Promise.resolve(); };
async function jumpTimer() {
  assert.equal(timers.size, 1, 'Exactly one playback timer is scheduled');
  const [key, val] = timers.entries().next().value;
  timers.delete(key); val.fn(); await flush();
}
async function run() {
  // The add-on may be absent while app.js loads; when present it must receive
  // catalog, current image, band, and comparison captures without extra fetches.
  const spectrumEvents = [];
  window.ArtemisosSpectrum = {
    reset: () => spectrumEvents.push(['reset']),
    setCatalog: (items, sky) => spectrumEvents.push(['catalog', items.length, sky.ra, items.every(it => Number.isInteger(it.band) && it.band >= 1 && it.band <= 6)]),
    setCurrent: id => spectrumEvents.push(['current', id]),
    setBand: band => spectrumEvents.push(['band', band]),
    setSaved: ids => spectrumEvents.push(['saved', ids.length])
  };
  assert.equal(calls.length, 0, 'Opening page must NOT query network');
  assert.equal(el.ra.value, '', 'RA must start empty');
  assert.equal(el.dec.value, '', 'Dec must start empty');
  assert.equal(el.loadingOverlay.hidden, true, 'Loading spinner must be hidden until Search');
  assert.equal(el.skyImage.hidden, true, 'No sky image loaded on startup');
  assert.equal(el.slider.disabled, true, 'Empty timeline disabled');
  assert.equal(el.play.getAttribute('aria-label'), 'Pause', 'Autoplay armed as requested');

  el.ra.value = '12.4'; el.dec.value = '-2.5';
  el.searchForm.onsubmit({preventDefault(){}});
  assert.equal(el.loadingOverlay.hidden, false, 'Searching activates spinner');
  assert.match(el.loadingMessage.textContent, /retrieving|searching/i);
  assert.doesNotMatch(el.loadingMessage.textContent, /retr(y|ies|ying)|fail|error|fallback|reintenta/i, 'Initial loading text must not imply a failure');
  assert.doesNotMatch(el.status.textContent, /retr(y|ies|ying)|fail|error|fallback|reintenta/i, 'Initial status must be neutral');
  await flush();
  assert.equal(calls.length, 1, 'Manual search must call backend once');
  assert.equal(new URL(calls[0]).searchParams.get('radius'), '0.02', 'Backend must use the fixed internal radius');
  assert(!html.includes('id="radius"'), 'The visible Radius field must be removed');
  assert.equal(window.location.searchParams.has('radius'), false, 'The shareable URL must not expose the internal radius');
  assert.equal(el.loadingOverlay.hidden, true, 'Spinner removed after complete preview warmup');
  assert.equal(el.slider.max, 5, 'Timeline contains ALL 6 epochs despite 2-day step');
  assert.equal(el.date.textContent.slice(0, 10), '2025-05-01', 'Starts from the oldest observation');
  assert.equal(el.slider.disabled, false);
  assert(spectrumEvents.some(e => e[0] === 'catalog' && e[1] === 8 && e[3]), 'Spectrum receives all observations and valid detector numbers');
  assert(spectrumEvents.some(e => e[0] === 'current' && e[1] === '1:0'), 'Spectrum follows active observation');

  // Play jumps by DAYS, not by how many records happen to be present.
  await jumpTimer(); assert.equal(el.date.textContent.slice(0, 10), '2025-05-03', 'May 1 -> May 3');
  await jumpTimer(); assert.equal(el.date.textContent.slice(0, 10), '2025-05-05', 'May 3 -> May 5');
  await jumpTimer(); assert.equal(el.date.textContent.slice(0, 10), '2025-05-08', 'May 5 -> May 8 (next available)');
  await jumpTimer(); assert.equal(el.date.textContent.slice(0, 10), '2025-05-01', 'Wrap to beginning');

  const previewsBefore = calls.length;
  el.periodDays.value = '1'; el.periodDays.onchange(); await flush();
  assert.equal(calls.length, previewsBefore, 'Changing period must not re-query IRSA');
  assert.equal(el.slider.max, 5, 'All dates still in timeline after period change');
  await jumpTimer(); assert.equal(el.date.textContent.slice(0, 10), '2025-05-02', 'One-day step after setting 1');

  // Invalid fractional or zero periods normalize to positive integer days.
  el.periodDays.value = '2.4'; el.periodDays.onchange();
  assert.equal(el.periodDays.value, 2);
  el.periodDays.value = '0'; el.periodDays.onchange();
  assert.equal(el.periodDays.value, 1);

  // Pan / zoom are stored on the image and must survive changes of frame/band.
  el.zin.onclick();
  el.frame.listeners.pointerdown[0]({target:{closest:()=>false},clientX:300,clientY:300,pointerId:1});
  el.frame.listeners.pointermove[0]({clientX:350,clientY:340});
  el.frame.listeners.pointerup[0]({});
  const transform = el.skyImage.style.transform;
  assert(transform.includes('scale(1.5)'));
  assert(transform.includes('translate(50px,40px)'));
  await jumpTimer();
  assert.equal(el.skyImage.style.transform, transform, 'Date change retains zoom AND pan');
  bands[2].onclick(); await flush();
  assert.equal(el.skyImage.style.transform, transform, 'Band change retains zoom AND pan');
  assert.equal(el.slider.max, 1, 'New band has full timeline');
  assert.equal(el.play.getAttribute('aria-label'), 'Pause', 'Band switch keeps autoplay');

  // A manual pause remains paused even when changing band and playback period.
  el.play.onclick(); assert.equal(timers.size, 0);
  bands[0].onclick(); await flush();
  el.periodDays.value = '2'; el.periodDays.onchange(); await flush();
  assert.equal(el.play.getAttribute('aria-label'), 'Play');
  assert.equal(timers.size, 0);
  assert.equal(el.skyImage.style.transform, transform, 'Paused band switch also preserves zoom');

  // New sky search intentionally resets zoom/pan.
  el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert.equal(el.skyImage.style.transform, 'translate(0px,0px) scale(1)', 'New sky search resets viewport');
  assert.equal(el.play.getAttribute('aria-label'), 'Play', 'Manual pause survives new search');

  // Search by NAME still resolves coordinates only after pressing Search.
  el.modeSwitch.checked = true;
  el.modeSwitch.onchange({target: el.modeSwitch});
  el.objName.value = 'Barnard Star';
  const beforeName = calls.length;
  el.searchForm.onsubmit({preventDefault(){}});
  await flush();
  assert.equal(calls.length, beforeName + 2, 'Name search: resolver + metadata fetch');
  assert.equal(el.ra.value, 42);
  assert.equal(el.dec.value, -17);
  assert.equal(el.play.getAttribute('aria-label'), 'Play', 'Pause persists after name search');

  // Both search switches are independent and do not trigger a request.
  const beforeSwitches = calls.length;
  el.querySwitch.checked = true;
  el.querySwitch.onchange({target: el.querySwitch});
  assert.equal(el.modeText.textContent, '', 'Fake DOM does not overwrite fixed label via JS');
  assert.equal(el.queryText.textContent, '', 'Fake DOM does not overwrite fixed label via JS');
  assert(html.includes('id="modeText">Search by name</b>'));
  assert(html.includes('id="queryText">Advanced search (full FITS)</b>'));
  assert(!script.includes("$('modeText').textContent ="));
  assert(!script.includes("$('queryText').textContent ="));
  assert(/#queryHint\s*\{[^}]*margin:\s*20px\s+0\s+34px/.test(css), 'Text to form spacing');
  assert.equal(calls.length, beforeSwitches, 'Changing search type alone must not start a request');
  assert.equal(el.queryCurrent.textContent, 'Advanced search:');
  // Existing images continue to use the mode of their original Search.
  assert(new URL(el.skyImage.src, 'http://localhost').searchParams.get('mode') === 'quick');
  el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert.equal(el.skyImage.hidden, false);
  const advancedUrl = new URL(el.skyImage.src, 'http://localhost');
  assert.equal(advancedUrl.searchParams.get('mode'), 'advanced', 'Advanced must request full FITS preview');
  assert.equal(el.details.textContent.includes('Full FITS'), true, 'Advanced mode is labeled in metadata');
  assert.equal(el.loadingOverlay.hidden, true, 'Advanced loading overlay clears only after prep');
  bands[2].onclick(); await flush();
  assert.equal(new URL(el.skyImage.src, 'http://localhost').searchParams.get('mode'), 'advanced',
    'Advanced mode must persist across band changes');
  el.querySwitch.checked = false;
  el.querySwitch.onchange({target: el.querySwitch});
  el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert.equal(new URL(el.skyImage.src, 'http://localhost').searchParams.get('mode'), 'quick',
    'Quick returns to cutout mode');
  assert.equal(calls.length, beforeSwitches + 4, 'Name searches resolve the object and then retrieve shared metadata');

  // Selecting a point in the add-on navigates using the ORIGINAL band loader.
  const fetchesBeforeSpectrumClick = calls.length;
  document.dispatchEvent({type: 'spherex:spectrumselect', detail: {id: '3:0', band: 3}});
  await flush();
  assert(el.details.textContent.includes('Band 3'), 'Spectral point opens the matching band');
  assert.equal(calls.length, fetchesBeforeSpectrumClick, 'Spectrum navigation reuses prepared catalog/previews');

  // IRSA recovery messages are informative, non-fatal, and don't alter the viewer.
  const originalResponse = response;
  response = {...originalResponse, fallback: true, partial: true,
    notice: 'Notice: IRSA did not respond for QR3. These results are partial; some observations may be missing.'};
  el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert.equal(el.archiveNotice.hidden, false, 'Partial catalog warning must be visible');
  assert(el.archiveNotice.textContent.includes('QR3'));
  assert(el.archiveNotice.textContent.includes('partial'));
  assert(!/resultados|parciales|falló/i.test(el.archiveNotice.textContent));
  assert.equal(el.loadingOverlay.hidden, true, 'Partial catalog still opens the viewer');
  assert.equal(el.skyImage.hidden, false, 'Partial catalog images remain playable');
  assert.equal(el.play.getAttribute('aria-label'), 'Play', 'Manual Pause remains respected');
  response = {status: 'error', message: 'NASA/IPAC (IRSA) is temporarily unavailable. Please try your search again in a few minutes.'};
  el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert(el.err.textContent.includes('NASA/IPAC'), 'Friendly error shown after all attempts');
  assert(!el.err.textContent.includes('HTTPSConnectionPool'), 'Raw network internals must be hidden');
  assert.equal(el.loadingOverlay.hidden, true, 'Failed search releases the spinner');
  assert.equal(el.archiveNotice.hidden, true, 'Old warning does not leak to failed search');
  response = originalResponse;
  el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert.equal(el.archiveNotice.hidden, true, 'Old partial warning is cleared on a healthy search');

  // Deep link only pre-fills RA/Dec. No automatic network requests.
  const linkEl = Object.fromEntries(ids.map(id => [id, new FakeEl(id)]));
  linkEl.intervalSeconds.value = '3'; linkEl.periodDays.value = '1';
  let urlCalls = 0;
  const doc2 = {
    getElementById(id) {return linkEl[id];},
    querySelectorAll(sel) {
      if (sel === '.band') return bands;
      if (sel === '.tick') return linkEl.ticks.children;
      throw new Error(sel);
    },
    createElement: tag => new FakeEl(tag),
    addEventListener(){}, dispatchEvent(){},
  };
  const win2 = {location: new URL('http://localhost:5000/?ra=100.75&dec=-22.25&radius=0.03'),
    history: {replaceState(){}}, addEventListener(){}};
  const context2 = {...context, document: doc2, window: win2,
    fetch: async () => {urlCalls++; throw new Error('Fetch on startup!');}};
  vm.runInNewContext(script, context2);
  assert.equal(linkEl.ra.value, 100.75);
  assert.equal(linkEl.dec.value, -22.25);
  assert(!Object.hasOwn(linkEl, 'radius'), 'Even legacy links do not restore a Radius field');
  assert.equal(urlCalls, 0, 'Even a valid URL must not trigger an automatic search');
  assert.equal(linkEl.loadingOverlay.hidden, true);

  assert(html.includes('id="loadingOverlay"'), 'Overlay exists');
  assert(html.indexOf('id="modeSwitch"') < html.indexOf('id="searchForm"'), 'Target toggle is above search form');
  assert(html.indexOf('id="querySwitch"') < html.indexOf('id="searchForm"'), 'Mode toggle is above search form');
  assert(/id="ra"[^>]*placeholder/.test(html), 'RA starts blank');
  console.log('PASS: quick/advanced switch, manual search, full timeline, playback days, zoom/pan, pause/autoplay, name resolver and URL prefill.');
}
run().catch(err => { console.error(err); process.exitCode = 1; });
