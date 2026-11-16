/* Zero-dependency checks for optional spectrum module. Run with Node.js. */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const code = fs.readFileSync(path.join(__dirname, '../static/js/spectrum.js'), 'utf8');
const html = fs.readFileSync(path.join(__dirname, '../templates/index.html'), 'utf8');
const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map(m => m[1]);
assert(html.indexOf('id="compareBtn"') < html.indexOf('id="spectrumTitle"'), 'Spectrum must come after Comparison');
assert(html.includes("filename='js/spectrum.js'"), 'Load the independent module');
assert(!html.includes('id="specCsv"'), 'Only the cube CSV button remains visible');
assert(html.includes('id="cubeCsv"'), 'The 102-channel cube retains its CSV export');
class El {
  constructor(id='') {
    this.id=id; this.attributes={}; this.children=[]; this.hidden=false; this.disabled=false;
    this._textContent=''; this.style={}; this.listeners={}; this.classList={toggle(){}};
  }
  get textContent() { return this._textContent; }
  set textContent(text) { this._textContent=String(text); this.children=[]; }
  append(...children) { this.children.push(...children); }
  setAttribute(k,v) { this.attributes[k]=String(v); }
  addEventListener(k,fn) { (this.listeners[k] ||= []).push(fn); }
  getBoundingClientRect() { return {left:0,top:0,width:400,height:230}; }
  click() { this.listeners.click?.forEach(f=>f()); }
}
const els = Object.fromEntries(ids.map(id => [id, new El(id)]));
let network=[];
const events=[];
const document = {
  getElementById: id => { assert(els[id], `Missing id: ${id}`); return els[id]; },
  createElementNS: (_ns,name) => new El(name),
  createElement: name => new El(name),
  dispatchEvent: e => events.push(e),
};
const context = {document, window:{}, URL,
  AbortController, Event: class {constructor(type){this.type=type;}},
  CustomEvent: class {constructor(type,options){this.type=type;this.detail=options.detail;}},
  fetch: async (url, options) => {
    network.push({url, options});
    const body=JSON.parse(options.body);
    assert.equal(body.ra, 12); assert.equal(body.dec, -2);
    assert.equal(body.radius, 0.02);
    return {ok: true, json: async()=>
      body.access_url.includes('missing') ? {status:'ok',lam:null,flux:5,err:null} :
      {status:'ok', lam:2.6,flux:8,err:.4,width:.05}};
  },
  setTimeout, clearTimeout, console};
vm.createContext(context);
vm.runInContext(code,context);
const spectrum=context.window.ArtemisosSpectrum;
assert(spectrum && typeof spectrum.setCatalog === 'function');
assert.equal(network.length, 0, 'Spectrum must not fetch on initial load');
assert(els.specGenerate.disabled, 'Generate disabled before a search');
const items=[{id:'1:0',band:1,mjd:60000,date:'2025-01-01',access_url:'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/a.fits'},
 {id:'2:0',band:2,mjd:60010,date:'2025-01-11',access_url:'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/missing.fits'}];
spectrum.setCatalog(items,{ra:12,dec:-2,radius:.02,queryType:'advanced'});
assert.equal(network.length,0, 'Spectrum generation must be opt-in even in Advanced');
assert.equal(els.specGenerate.disabled,false);
els.loadingOverlay.hidden=true;
(async()=>{
  await els.specGenerate.onclick();
  assert.equal(network.length,2, 'One small FITS measurement request per observation');
  assert(network.every(x=>x.url==='/api/spectrum/point' && x.options.method==='POST'));
  assert(els.specNote.textContent.includes('1 spectral points from 2'));
  assert(els.specGenerate.textContent.includes('Retry'));
  let hits=els.spectrum.children.filter(x=>x.attributes.class==='hit');
  assert.equal(hits.length,1,'No point with invented wavelength');
  spectrum.setCurrent('1:0'); spectrum.setSaved(['1:0']); spectrum.setBand(2);
  assert(els.spectrum.children.some(x=>x.attributes.class==='halo'),'Current observation has halo');
  assert(els.spectrum.children.some(x=>x.attributes.class==='pt saved'),'Captured point highlighted');
  hits=els.spectrum.children.filter(x=>x.attributes.class==='hit'); hits[0].click();
  assert.equal(events.at(-1).type,'spherex:spectrumselect');
  assert.equal(events.at(-1).detail.id,'1:0');
  spectrum.reset();
  assert.equal(network.length,2, 'Reset should not fetch');
  console.log('PASS: spectrum opt-in, search isolation, point extraction, SVG, capture, select.');
})().catch(error=>{console.error(error);process.exitCode=1;});
