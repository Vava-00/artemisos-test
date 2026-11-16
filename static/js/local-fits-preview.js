/* Standalone local FITS interface. No backend changes and no remote uploads. */
(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const CACHE_DIR = 'artemisos-drive-test'; // Reuse the original diagnostic cache.
  const LIMIT_BYTES = 2 * 1024 * 1024 * 1024;
  const worker = new Worker('/static/js/fits-image-worker.js');
  let file = null, running = false, token = 0;
  const out = message => { $('result').textContent = message; };
  const sizeLabel = size => `${(size / (1024 * 1024)).toFixed(2)} MiB`;
  const setBusy = value => {
    running = value;
    $('render').disabled = !file || value;
    $('save').disabled = !file || value;
    $('openCached').disabled = !$('cacheSelect').value || value;
  };

  async function directory(create = false) {
    if (!navigator.storage || !navigator.storage.getDirectory)
      throw new Error('This browser does not support OPFS storage. Local previews still work.');
    return (await navigator.storage.getDirectory()).getDirectoryHandle(CACHE_DIR, { create });
  }

  async function refreshCache() {
    const select = $('cacheSelect');
    select.replaceChildren();
    try {
      const dir = await directory();
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'file') select.add(new Option(name, name));
      }
    } catch (err) {
      if (err.name !== 'NotFoundError') out(`Cannot list browser cache: ${err.message}`);
    }
    if (!select.options.length) select.add(new Option('No saved FITS files', ''));
    setBusy(running);
  }

  async function chooseFile(next) {
    if (!next || !Number.isFinite(next.size) || next.size <= 0 || next.size > LIMIT_BYTES)
      throw new Error('Choose an uncompressed FITS file smaller than 2 GiB.');
    file = next;
    $('image').hidden = true;
    out(`Selected ${next.name} (${sizeLabel(next.size)}). Click Preview full FITS.`);
    setBusy(false);
  }

  function preview() {
    if (!file || running) return;
    const id = ++token;
    $('image').hidden = true;
    setBusy(true);
    out(`Reading FITS extensions and preparing a downsampled image from ${file.name}…`);
    worker.postMessage({ type: 'preview', id, file });
  }

  worker.addEventListener('message', event => {
    const message = event.data;
    if (!message || message.id !== token) return;
    setBusy(false);
    if (message.type === 'error') {
      out(`Preview failed: ${message.message}`);
      return;
    }
    const { width, height, rgba, metadata } = message;
    const canvas = $('image');
    canvas.width = width; canvas.height = height;
    const context = canvas.getContext('2d');
    context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    canvas.hidden = false;
    out([
      `File: ${file?.name || 'Cached FITS'}`,
      `Scientific image: ${metadata.imageWidth} × ${metadata.imageHeight} pixels`,
      `Preview: ${width} × ${height} pixels (stride ${metadata.stride})`,
      `Image extension: ${metadata.hdu}`, `BITPIX: ${metadata.bitpix}`,
      `Image units: ${metadata.bunit}`,
      `Display contrast: ${metadata.scaleLow.toPrecision(5)} .. ${metadata.scaleHigh.toPrecision(5)}`,
      `Finite preview pixels: ${metadata.validPercent}%`,
      '', 'FITS extensions:', ...metadata.hdus.map(h => `• ${h}`),
      '', metadata.displayConvention
    ].join('\n'));
  });
  worker.addEventListener('error', event => {
    setBusy(false);
    out(`The FITS worker failed: ${event.message || 'unknown error'}`);
  });

  async function save() {
    if (!file || running) return;
    const estimate = await navigator.storage.estimate();
    if (Number.isFinite(estimate.quota) && Number.isFinite(estimate.usage)
        && file.size > estimate.quota - estimate.usage)
      throw new Error('Not enough browser storage quota for this FITS.');
    const name = file.name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160);
    const dir = await directory(true);
    const handle = await dir.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    setBusy(true);
    out(`Saving ${name} (${sizeLabel(file.size)}) to local browser storage…`);
    try {
      await file.stream().pipeTo(writable);
      const check = await handle.getFile();
      if (check.size !== file.size) throw new Error('Cached file length does not match the original.');
      out(`Cached ${name} (${sizeLabel(check.size)}) on this device. No upload to Render or Drive occurred.`);
    } catch (error) {
      await writable.abort().catch(() => {});
      await dir.removeEntry(name).catch(() => {});
      throw error;
    } finally {
      setBusy(false);
      await refreshCache();
    }
  }

  async function openCached() {
    const name = $('cacheSelect').value;
    if (!name) return;
    const cachedFile = await (await directory()).getFileHandle(name);
    await chooseFile(await cachedFile.getFile());
    preview();
  }

  async function clearCache() {
    if (!window.confirm('Delete only the files saved by the Artemisos FITS diagnostics?')) return;
    try {
      const root = await navigator.storage.getDirectory();
      await root.removeEntry(CACHE_DIR, { recursive: true });
      out('The isolated FITS cache was deleted. Main viewer files were not changed.');
    } catch (err) {
      if (err.name !== 'NotFoundError') throw err;
      out('The FITS test cache was already empty.');
    }
    await refreshCache();
  }

  const handle = action => () => Promise.resolve().then(action).catch(error => out(`Error: ${error.message}`));
  $('localFile').addEventListener('change', handle(() => chooseFile($('localFile').files[0])));
  $('render').addEventListener('click', preview);
  $('save').addEventListener('click', handle(save));
  $('refresh').addEventListener('click', handle(refreshCache));
  $('openCached').addEventListener('click', handle(openCached));
  $('clear').addEventListener('click', handle(clearCache));
  refreshCache();
})();
