/* Isolated browser diagnostics for public Google Drive FITS access and OPFS.
 * No change to the viewer, API, or Render configuration is required.
 */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const helpers = window.ArtemisosDriveHelpers;
  const MAX_LOCAL_BYTES = 2 * 1024 * 1024 * 1024;
  const CACHE_FOLDER = 'artemisos-drive-test';
  const text = (id, value) => { $(id).textContent = value; };
  const fmt = bytes => `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;

  function updateLink() {
    const id = $('driveId').value.trim();
    if (helpers.validDriveId(id)) {
      $('driveLink').href = helpers.driveFileUrl(id);
      $('driveLink').hidden = false;
    } else {
      $('driveLink').hidden = true;
    }
  }

  // Check only the first chunk; do not buffer an entire FITS file in memory.
  async function probeCandidate(candidate) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(candidate.url, {
        mode: 'cors', cache: 'no-store', redirect: 'follow',
        headers: { Range: 'bytes=0-2879' }, signal: controller.signal
      });
      if (!response.ok) return `${candidate.label}: HTTP ${response.status}. No FITS bytes could be read.`;
      if (!response.body) return `${candidate.label}: the response body cannot be streamed.`;
      const reader = response.body.getReader();
      let first;
      try {
        const result = await reader.read();
        first = result.value || new Uint8Array();
      } finally {
        await reader.cancel().catch(() => {});
      }
      const parsed = helpers.inspectMagic(first);
      const range = response.status === 206 ? 'Partial response (HTTP 206)' :
        'HTTP 200: Drive may have ignored Range';
      return `${candidate.label}: ${range}; ${parsed.type}. ${parsed.note}`;
    } catch (err) {
      // Browser fetch cannot distinguish DNS, CORS, and some redirect failures.
      return `${candidate.label}: browser fetch failed (${err.name === 'AbortError' ? 'timeout' : 'network/CORS/redirect restriction'}).`;
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe() {
    const id = $('driveId').value.trim();
    if (!helpers.validDriveId(id)) return text('probeResult', 'Enter a valid public Google Drive file ID.');
    $('probe').disabled = true;
    text('probeResult', 'Testing two anonymous browser read paths. Only an initial byte range is requested...');
    try {
      const outcomes = [];
      for (const candidate of helpers.downloadCandidates(id)) {
        outcomes.push(await probeCandidate(candidate));
        text('probeResult', outcomes.join('\n\n'));
      }
      text('probeResult', outcomes.join('\n\n') +
        '\n\nA successful browser download link does not imply CORS success. A failed anonymous API test does not rule out authorized OAuth access.');
    } finally {
      $('probe').disabled = false;
    }
  }

  async function inspectLocal() {
    const file = $('localFile').files[0];
    if (!file) return text('localResult', 'Choose a local FITS file first.');
    const first = new Uint8Array(await file.slice(0, 2880).arrayBuffer());
    const result = helpers.inspectMagic(first);
    text('localResult', `File: ${file.name}\nSize: ${fmt(file.size)}\nSignature: ${result.type}\n${result.note}`);
    return result;
  }

  async function cacheFile() {
    const file = $('localFile').files[0];
    if (!file) return text('localResult', 'Choose a local FITS file first.');
    if (!navigator.storage?.getDirectory) return text('localResult', 'OPFS is unavailable in this browser or context.');
    if (!file.size || file.size > MAX_LOCAL_BYTES)
      return text('localResult', 'The test allows files up to 2 GiB. Use a smaller file.');
    const check = await inspectLocal();
    if (!check?.valid) return text('localResult', 'The file does not have a recognized FITS/gzip signature. Nothing was saved.');
    const estimate = await navigator.storage.estimate();
    if (estimate.quota && estimate.usage && file.size > estimate.quota - estimate.usage)
      return text('localResult', 'Insufficient browser storage quota. Nothing was saved.');
    const safeName = file.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 160) || 'observation.fits';
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_FOLDER, { create: true });
    const handle = await dir.getFileHandle(safeName, { create: true });
    const stream = await handle.createWritable();
    $('saveLocal').disabled = true;
    text('localResult', `Saving ${safeName} to local browser storage...`);
    try {
      // Streaming copy: file is never assembled into one giant ArrayBuffer.
      await file.stream().pipeTo(stream);
      const saved = await handle.getFile();
      text('localResult', `Saved ${safeName} (${fmt(saved.size)}) to OPFS. This does not upload to Render or Drive.`);
    } catch (err) {
      await stream.abort().catch(() => {});
      await dir.removeEntry(safeName).catch(() => {});
      text('localResult', `OPFS write failed: ${err.message}`);
    } finally {
      $('saveLocal').disabled = false;
    }
  }

  async function clearCache() {
    if (!navigator.storage?.getDirectory) return text('localResult', 'OPFS is unavailable.');
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(CACHE_FOLDER, { recursive: true });
      text('localResult', 'The isolated Artemisos Drive test cache was cleared. Your viewer data was not touched.');
    } catch (err) {
      text('localResult', err.name === 'NotFoundError' ? 'No test files are cached.' : `Could not clear test cache: ${err.message}`);
    }
  }

  $('driveId').addEventListener('input', updateLink);
  $('probe').addEventListener('click', probe);
  $('inspect').addEventListener('click', () => inspectLocal().catch(err => text('localResult', err.message)));
  $('saveLocal').addEventListener('click', () => cacheFile().catch(err => text('localResult', err.message)));
  $('clearLocal').addEventListener('click', () => clearCache().catch(err => text('localResult', err.message)));
  $('copyResults').addEventListener('click', async () => {
    const report = `Artemisos Google Drive FITS test\n\n${$('probeResult').textContent}\n\n${$('localResult').textContent}`;
    try {
      await navigator.clipboard.writeText(report);
      $('copyResults').textContent = 'Copied';
    } catch (err) {
      $('copyResults').textContent = 'Clipboard unavailable; select and copy the output manually';
    }
  });
  updateLink();
})();
