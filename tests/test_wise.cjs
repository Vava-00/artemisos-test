// Offline integration: enabling WISE is opt-in and cannot interrupt SPHEREx.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root,'templates','index.html'),'utf8');
const code = fs.readFileSync(path.join(root,'static','js','wise.js'),'utf8');
const ids = [...html.matchAll(/\bid="([\w-]+)"/g)].map(m=>m[1]);
class Element {
  constructor(id='') {this.id=id;this.dataset={};this.attributes={};this.style={};this.hidden=false;
    this.value='';this.checked=false;this.disabled=false;this.textContent='';this.children=[];this.listeners={};
    this.classList={toggle(){},add(){},remove(){}};}
  set src(s){this._src=s; if(s) queueMicrotask(()=>this.onload?.());}
  get src(){return this._src;}
  getAttribute(k){return this.attributes[k]??(k==='src'?this._src:null);}
  setAttribute(k,v){this.attributes[k]=String(v);}
  removeAttribute(k){delete this.attributes[k];if(k==='src')this._src=null;}
  insertBefore(el){this.children.push(el);}
  querySelector(){return this.children[0]||new Element();}
  addEventListener(k,fn){(this.listeners[k]??=[]).push(fn);}
  append(...els){this.children.push(...els);}
}
const el=Object.fromEntries(ids.map(id=>[id,new Element(id)]));
el.wiseOpacity.value='55';
el.frame.children.push(new Element('zoom'));
el.skyImage.src='/api/preview?'+new URLSearchParams({url:'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/a.fits',mode:'quick'});
el.skyImage.hidden=false;
const listeners={}, wbands=Array.from({length:4},(_,i)=>Object.assign(new Element('W'+(i+1)),{dataset:{wband:String(i+1)}}));
const document={
  getElementById(id){ assert(el[id],`missing ${id}`);return el[id];},
  querySelector(s){ assert.equal(s,'.viewer');return new Element();},
  querySelectorAll(s){assert.equal(s,'[data-wband]');return wbands;},
  createElement(tag){return new Element(tag);},
  addEventListener(k,fn){(listeners[k]??=[]).push(fn);},
  dispatchEvent(ev){for(const fn of listeners[ev.type]||[])fn(ev);}
};
const calls=[];
const fetch=async url=>{calls.push(url);let response={status:'ok',bands:{1:{band:1,label:'3.4 µm',obs_id:'WISE-A',access_url:'https://irsa.ipac.caltech.edu/ibe/data/wise/a.fits'}}};return {ok:true,json:async()=>response};};
const context={document,window:{location:new URL('https://local.test/')},MutationObserver:class{observe(){}},fetch,URL,URLSearchParams,AbortController,console};
vm.createContext(context);vm.runInContext(code,context);
const flush=async()=>{for(let i=0;i<50;i++)await Promise.resolve();};
(async()=>{
  assert.equal(calls.length,0,'No WISE call on page load');
  assert.equal(el.wiseOverlayBtn.hidden,true,'Overlay button must start hidden');
  document.dispatchEvent({type:'spherex:skyresolved',detail:{ra:42,dec:-7,radius:.02}});
  await flush();assert.equal(calls.length,0,'No WISE request when feature is off');
  el.wiseSwitch.checked=true;el.wiseSwitch.onchange({target:el.wiseSwitch});await flush();
  assert.equal(el.wiseOverlayBtn.hidden,false,'Enabling WISE must reveal Overlay WISE immediately');
  assert.equal(el.wiseOverlayBtn.disabled,false,'Overlay WISE must be enabled after sky resolution');
  assert.equal(el.wiseOverlayBar.hidden,true,'Overlay settings must remain hidden until requested');
  assert.equal(calls.length,1);
  assert.equal(new URL(calls[0],'https://local.test').pathname,'/api/wise/search');
  assert.equal(new URL(calls[0],'https://local.test').searchParams.get('radius'),'0.02');
  assert.equal(el.wisePanel.hidden,false);
  assert(el.wiseImage.src.includes('/api/wise/preview'));
  el.wiseOverlayBtn.onclick();await flush();
  assert.equal(el.wiseOverlayBtn.getAttribute('aria-pressed'),'true');
  assert.equal(el.wiseOverlayBar.hidden,false,'Overlay settings must be visible when active');
  assert(el.frame.children.some(e=>e.id==='wiseOverlayImg'));
  assert(el.frame.children.find(e=>e.id==='wiseOverlayImg').src.includes('/api/wise/overlay'));
  el.wiseSwitch.checked=false;el.wiseSwitch.onchange({target:el.wiseSwitch});
  assert.equal(el.wisePanel.hidden,true);
  assert.equal(el.wiseOverlayBtn.hidden,true,'Disabling WISE must hide the overlay button');
  assert.equal(el.wiseOverlayBar.hidden,true,'Disabling WISE must hide overlay controls');
  assert.equal(el.wiseOverlayBtn.getAttribute('aria-pressed'),'false');
  assert.equal(el.frame.children.find(e=>e.id==='wiseOverlayImg').hidden,true);
  el.wiseSwitch.checked=true;el.wiseSwitch.onchange({target:el.wiseSwitch});await flush();
  assert.equal(el.wiseOverlayBtn.hidden,false,'Re-enabling WISE must reveal overlay button again');
  assert.equal(el.wiseOverlayBar.hidden,true,'Overlay must not turn on by itself');
  console.log('PASS: WISE opt-in, visible overlay control, WCS overlay, disable/re-enable.');
})().catch(err=>{console.error(err);process.exitCode=1;});
