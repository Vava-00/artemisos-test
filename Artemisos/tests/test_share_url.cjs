// Integration tests for sharing a specific SPHEREx observation by URL.
// Run: node tests/test_share_url.cjs
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const code = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]);

const MJD_EPOCH = Date.UTC(1858, 10, 17);
const mjd = day => (Date.parse(day + 'T00:00:00Z') - MJD_EPOCH) / 86400000;
function observation(day, band) {
  return {obs_id: `${band}-${day}`, fecha: `${day} 00:00:00 UTC`, mjd: mjd(day),
    access_url: `https://irsa.ipac.caltech.edu/ibe/data/spherex/e${band}-${day}.fits`,
    s_ra: 12.4, s_dec: -2.5};
}
const catalog = {
  'Band 1': ['2025-05-01', '2025-05-02'].map(d => observation(d, 1)),
  'Band 3': ['2025-05-30', '2025-06-01'].map(d => observation(d, 3))
};
function setup(initialUrl) {
  class Element {
    constructor(id = '') {
      this.id = id; this.style = {}; this.dataset = {}; this.children = [];
      this.attributes = {}; this.listeners = {}; this.value = ''; this.checked = false;
      this.hidden = false; this.disabled = false; this.textContent = ''; this.className = '';
      this.classList = {add(){}, remove(){}, toggle(){}};
    }
    get src() { return this._src; }
    set src(value) { this._src = value; if (value) queueMicrotask(() => this.onload?.()); }
    get innerHTML() { return this._html; }
    set innerHTML(value) { this._html = value; this.children = []; }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    removeAttribute(name) { delete this.attributes[name]; }
    addEventListener(name, fn) { (this.listeners[name] ??= []).push(fn); }
    removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter(x => x !== fn); }
    append(...children) { this.children.push(...children); }
    add(opt) { this.children.push(opt); this.value ||= opt.value; }
    setPointerCapture() {}
    getBoundingClientRect() { return {width: 600, height: 600}; }
  }
  const el = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  el.intervalSeconds.value = '3'; el.periodDays.value = '1';
  const bands = Array.from({length:6}, (_, ix) => Object.assign(new Element(), {dataset:{band:String(ix+1)}}));
  const listeners = {};
  const document = {
    getElementById(id) { if (!el[id]) throw new Error('Missing HTML ID: '+id); return el[id]; },
    querySelectorAll(selector) {
      if (selector === '.band') return bands;
      if (selector === '.tick') return el.ticks.children;
      throw new Error('Unexpected selector: ' + selector);
    },
    createElement: tag => new Element(tag),
    addEventListener(name, fn) { (listeners[name] ??= []).push(fn); },
    dispatchEvent(event) { for (const fn of listeners[event.type] || []) fn(event); }
  };
  const calls = [], replaceCalls = [], timers = new Map();
  let tid = 0;
  const window = {location: new URL(initialUrl), history: {
    replaceState(_state, _title, url) {
      replaceCalls.push(String(url)); window.location = new URL(url, window.location);
    },
    pushState() { throw Error('Never push one history entry per frame'); }
  }, addEventListener(){}};
  const fetch = async url => {
    const parsed = new URL(url, window.location);
    calls.push(parsed.toString());
    if (parsed.pathname === '/api/buscar') return {ok:true, status:200,
      json:async () => ({status:'ok', total_encontrados:4, bandas_carrusel:catalog})};
    if (parsed.pathname === '/api/resolver') return {ok:true, status:200,
      json:async () => ({status:'ok', ra:12.4, dec:-2.5})};
    throw Error('Unexpected fetch: ' + url);
  };
  const context = {document, window, fetch, URL, URLSearchParams, AbortController, Image:Element,
    CustomEvent: class {constructor(type, obj) {this.type=type; this.detail=obj.detail;}},
    Option: class {constructor(text, value) {this.text=text; this.value=value;}},
    setTimeout(fn, ms) {const id=++tid; timers.set(id,{fn,ms}); return id;},
    clearTimeout(id) {timers.delete(id);}, console, queueMicrotask};
  vm.createContext(context);
  vm.runInContext(code, context);
  return {el, bands, calls, replaceCalls, timers, window};
}
const flush = async () => { for (let i=0; i<100; i++) await Promise.resolve(); };
async function run() {
  // Link into B3: observe that opening the URL does not fetch anything until Search.
  const restored = setup('http://localhost:5000/?ra=12.4&dec=-2.5&view=advanced&band=3&obs=3-2025-06-01&radio=0.5#viewer');
  assert.equal(restored.calls.length, 0, 'Landing on shared link must not search');
  assert.equal(restored.el.skyImage.hidden, true);
  assert.equal(restored.el.ra.value, 12.4);
  assert.equal(restored.el.dec.value, -2.5);
  assert.equal(restored.el.querySwitch.checked, true, 'Advanced selector prefilled from URL');
  restored.el.searchForm.onsubmit({preventDefault(){}});
  await flush();
  assert.equal(restored.calls.length, 1);
  assert.equal(new URL(restored.calls[0]).searchParams.get('radio'), '0.02', 'Legacy URL radius ignored');
  assert(restored.el.details.textContent.includes('Band 3'), 'Band from link selected after search');
  assert.equal(restored.el.date.textContent.slice(0, 10), '2025-06-01', 'Exact OBS ID recovered');
  const p = restored.window.location.searchParams;
  assert.equal(p.get('view'), 'advanced');
  assert.equal(p.get('ra'), '12.4');
  assert.equal(p.get('dec'), '-2.5');
  assert.equal(p.get('band'), '3');
  assert.equal(p.get('obs'), '3-2025-06-01');
  assert.equal(p.has('radio'), false, 'Hidden radius must not appear in shared links');
  assert.equal(restored.window.location.hash, '#viewer', 'Other URL components are preserved');
  const before = restored.replaceCalls.length;
  restored.el.slider.oninput({target:{value:0}}); await flush();
  assert.equal(restored.window.location.searchParams.get('obs'), '3-2025-05-30', 'Manual timeline updates shareable OBS ID');
  assert.equal(restored.replaceCalls.length, before+1, 'Frame updates via replaceState');
  restored.bands[0].onclick(); await flush();
  assert.equal(restored.window.location.searchParams.get('band'), '1', 'New band in URL');
  assert.equal(restored.window.location.searchParams.get('obs'), '1-2025-05-01');
  assert.equal(restored.el.play.getAttribute('aria-label'), 'Pause', 'Autoplay remains armed');
  restored.el.play.onclick();
  assert.equal(restored.timers.size, 0, 'Pause works as before');

  // Obsolete observation: preserve the valid requested band with normal fallback.
  const missing = setup('http://localhost:5000/?ra=12.4&dec=-2.5&band=3&obs=obsolete');
  assert.equal(missing.calls.length, 0);
  missing.el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert(missing.el.details.textContent.includes('Band 3'));
  assert.equal(missing.el.date.textContent.slice(0, 10), '2025-05-30', 'Obsolete OBS falls back to first of valid band');
  assert.equal(missing.window.location.searchParams.get('obs'), '3-2025-05-30');

  // No OBS ID is still enough to select the requested band.
  const onlyBand = setup('http://localhost:5000/?ra=12.4&dec=-2.5&band=3');
  onlyBand.el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert(onlyBand.el.details.textContent.includes('Band 3'));

  // Wrong sky inputs must never start an archive request, nor restore an OBS ID.
  const invalid = setup('http://localhost:5000/?ra=999&dec=-2.5&band=3&obs=3-2025-06-01');
  assert.equal(invalid.calls.length, 0);
  assert(invalid.el.err.textContent.includes('Invalid URL coordinates'));

  // A new search for different coordinates should not recover the old pending observation.
  const changed = setup('http://localhost:5000/?ra=12.4&dec=-2.5&band=3&obs=3-2025-06-01');
  changed.el.ra.value = '13.5';
  changed.el.searchForm.onsubmit({preventDefault(){}}); await flush();
  assert(changed.el.details.textContent.includes('Band 1'), 'Different sky starts at earliest band');
  assert.equal(changed.window.location.searchParams.get('ra'), '13.5');
  assert.equal(changed.window.location.searchParams.get('obs'), '1-2025-05-01');
  console.log('PASS: shareable RA/DEC/view/band/OBS, manual search, legacy radius ignored, missing OBS fallback, no history spam.');
}
run().catch(error => {console.error(error); process.exitCode=1;});
