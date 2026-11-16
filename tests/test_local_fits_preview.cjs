/* Network-free tests for local, uncompressed FITS rendering in the browser. */
'use strict';
const assert = require('node:assert/strict');
const { scanFits, makePreview } = require('../static/js/fits-image-worker.js');

function cards(values) {
  const lines = values.map(([key, value]) => `${key.padEnd(8)}= ${String(value).padEnd(20)}`.padEnd(80));
  lines.push('END'.padEnd(80));
  return Buffer.from(lines.join('').padEnd(Math.ceil(lines.length * 80 / 2880) * 2880, ' '), 'ascii');
}
function fitsImage() {
  const primary = cards([['SIMPLE', 'T'], ['BITPIX', '8'], ['NAXIS', '0'], ['EXTEND', 'T']]);
  const image = cards([['XTENSION', "'IMAGE   '"], ['BITPIX', '-32'], ['NAXIS', '2'],
    ['NAXIS1', '2'], ['NAXIS2', '2'], ['PCOUNT', '0'], ['GCOUNT', '1'], ['EXTNAME', "'IMAGE'"]]);
  const pixels = Buffer.alloc(2880);
  for (const [i, val] of [0.2, 0.4, 0.6, 0.8].entries()) pixels.writeFloatBE(val, 4 * i);
  return new Blob([primary, image, pixels]);
}
(async () => {
  const file = fitsImage();
  const hdus = await scanFits(file);
  assert.equal(hdus.length, 2);
  assert.equal(hdus[1].name, 'IMAGE');
  assert.deepEqual(hdus[1].dims, [2, 2]);
  const preview = await makePreview(file);
  assert.equal(preview.width, 2);
  assert.equal(preview.height, 2);
  assert.equal(preview.rgba.byteLength, 16);
  assert.equal(preview.metadata.imageWidth, 2);
  assert.equal(preview.metadata.hdu, 'IMAGE');
  assert.equal(preview.metadata.validPercent, 100);
  assert.notDeepEqual([...preview.rgba.subarray(0, 3)], [...preview.rgba.subarray(8, 11)]);
  await assert.rejects(() => scanFits(new Blob(['<html>error</html>'])), /valid FITS|Choose a valid/);
  console.log('Local FITS preview: synthetic 2-D IMAGE FITS and error handling passed.');
})().catch(err => { console.error(err); process.exitCode = 1; });
