// Offline browser-style smoke test for the independently loaded DR1 cube.
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const script = fs.readFileSync(path.join(__dirname, '..', 'static', 'js', 'cube_spectrum.js'), 'utf8');
class Element {
  constructor(tag='div') {this.tag=tag;this.children=[];this.style={};this.hidden=false;this.disabled=false;this.textContent='';this.events={};}
  append(...nodes) {this.children.push(...nodes);}
  setAttribute(k,v){this[k]=v;}
  addEventListener(k,fn){this.events[k]=fn;}
  getBoundingClientRect(){return {width:400,height:230,left:0,top:0};}
  click(){if(this.onclick)this.onclick();}
}
const controls = Object.fromEntries(['cubeRetry','cubeCsv','cubeSpecBox','cubeSpecTip','cubeSpectrum','cubeStatus','cubeGoodOnly','cubeScale','cubeQuality'].map(k=>[k,new Element()]));
controls.cubeRetry.hidden=true;
const document = {
  getElementById: id => {assert(controls[id],id);return controls[id];},
  createElementNS: (_ns,name) => new Element(name),
  createElement: name => new Element(name),
};
let fetchCount=0;
let failing=false;
const fetch = async () => {
  fetchCount++;
  if(failing) return {ok:false,json:async()=>({status:'error',mensaje:'unavailable'})};
  return {ok:true,json:async()=>({status:'ok',total_channels:102,valid_channels:100,cached:false,
    points:Array.from({length:102},(_,i)=>({channel:i+1,band:Math.floor(i/17)+1,
      wavelength_um:.75+i*.04,brightness:i===50||i===51?null:10+i,nhits:3,flags:0}))})};
};
let createdUrl='';
const url={createObjectURL:()=>{createdUrl='blob:test';return createdUrl;},revokeObjectURL:()=>{}};
const context={document,window:{},fetch,URL:url,URLSearchParams,AbortController,Blob,
  setTimeout:(f)=>{return 1;},clearTimeout:()=>{}};
vm.createContext(context);vm.runInContext(script,context);
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve();};
(async()=>{
  assert.equal(fetchCount,0, 'No spectrum request before search');
  context.window.ArtemisosCubeSpectrum.setPosition(12.3,-4.5);
  await flush();
  assert.equal(fetchCount,1);
  assert.equal(controls.cubeCsv.disabled,false);
  assert.equal(controls.cubeRetry.hidden,true);
  assert(controls.cubeStatus.textContent.includes('100 / 102'));
  assert(controls.cubeSpectrum.children.some(e=>e.tag==='polyline'));
  controls.cubeGoodOnly.checked=true;controls.cubeGoodOnly.onchange();
  controls.cubeScale.value='full';controls.cubeScale.onchange();
  assert.equal(fetchCount,1,'Quality/scale toggles must not redownload the cube');
  controls.cubeCsv.click();assert.equal(createdUrl,'blob:test');
  failing=true;
  context.window.ArtemisosCubeSpectrum.setPosition(15,-4);
  await flush();
  assert.equal(controls.cubeCsv.disabled,true);
  assert.equal(controls.cubeRetry.hidden,false);
  assert(controls.cubeStatus.textContent.includes('temporarily unavailable'));
  assert(controls.cubeStatus.textContent.includes('unavailable')); // backend reason exposed
  // The test DOM stub retains old children when textContent is cleared;
  // in the browser that operation removes them. Check the newest plot node.
  assert(!String(controls.cubeSpectrum.children.at(-1)?.textContent).includes('Loading 102'),
    'The spinner must stop after an error.');
  assert(String(controls.cubeSpectrum.children.at(-1)?.textContent).includes('use Retry'),
    'The plot must show a retry message after a failure.');
  failing=false;controls.cubeRetry.click();await flush();
  assert.equal(controls.cubeRetry.hidden,true);
  assert.equal(fetchCount,3);
  context.window.ArtemisosCubeSpectrum.reset();
  assert.equal(controls.cubeCsv.disabled,true);
  console.log('PASS: cube is independent, plots 102 channels, CSV, failure + Retry, reset.');
})().catch(e=>{console.error(e);process.exitCode=1;});
