'use strict';
const assert = require('node:assert/strict');
const helpers = require('../static/js/drive-helpers.js');
assert.equal(helpers.validDriveId('1yY7JmmuEkVBOWkJ6MsiYnBFuycskQk8C'), true);
assert.equal(helpers.validDriveId('https://google.com/?token=abc'), false);
assert.equal(helpers.validDriveId('a/b'), false);
assert.equal(helpers.downloadCandidates('1yY7JmmuEkVBOWkJ6MsiYnBFuycskQk8C').length, 2);
assert.equal(helpers.driveFileUrl('1yY7JmmuEkVBOWkJ6MsiYnBFuycskQk8C'),
  'https://drive.google.com/file/d/1yY7JmmuEkVBOWkJ6MsiYnBFuycskQk8C/view');
const header = new TextEncoder().encode('SIMPLE  =                    T');
assert.equal(helpers.inspectMagic(header).type, 'FITS primary HDU');
assert.equal(helpers.inspectMagic(new Uint8Array([0x1f,0x8b])).type, 'gzip stream');
assert.equal(helpers.inspectMagic(new TextEncoder().encode('<html>Error</html>')).valid, false);
assert.equal(helpers.inspectMagic(new Uint8Array([0,1,2])).valid, false);
console.log('Drive helper tests passed (network-free).');
