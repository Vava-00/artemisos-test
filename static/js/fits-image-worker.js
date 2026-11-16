/* Artemisos: offline FITS preview reader.
 * Supports uncompressed, 2-D FITS IMAGE HDUs using big-endian standard BITPIX
 * encodings. It never requests remote URLs or changes the main sky viewer.
 * Preview contrast is illustrative; this is not astrometric reprojection or
 * calibrated source photometry.
 */
(function (scope) {
  'use strict';

  const FITS_BLOCK = 2880;
  const MAX_HEADER_BYTES = 4 * 1024 * 1024;
  const MAX_HDUS = 48;
  const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
  const MAX_IN_MEMORY_IMAGE_BYTES = 64 * 1024 * 1024;
  const SUPPORTED_BITPIX = new Set([8, 16, 32, -32, -64]);
  const decoder = new TextDecoder('ascii');

  function numberOf(value, fallback = NaN) {
    if (typeof value === 'number') return value;
    if (value == null) return fallback;
    const parsed = Number(String(value).replace(/[dD]/g, 'E'));
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function parseCard(card) {
    const keyword = card.slice(0, 8).trim();
    if (card.slice(8, 10) !== '= ') return null;
    const raw = card.slice(10);
    if (raw.trimStart().startsWith("'")) {
      const match = raw.trimStart().match(/^'((?:''|[^'])*)'/);
      return [keyword, match ? match[1].replace(/''/g, "'").trim() : raw.trim()];
    }
    return [keyword, raw.split('/')[0].trim()];
  }

  async function readHeader(file, offset) {
    const meta = {};
    let length = 0;
    let ended = false;
    while (length < MAX_HEADER_BYTES) {
      const bytes = await file.slice(offset + length, offset + length + FITS_BLOCK).arrayBuffer();
      if (bytes.byteLength !== FITS_BLOCK) throw new Error('Truncated FITS header.');
      const block = decoder.decode(bytes);
      length += FITS_BLOCK;
      for (let i = 0; i < FITS_BLOCK; i += 80) {
        const card = block.slice(i, i + 80);
        if (card.slice(0, 8).trim() === 'END') { ended = true; break; }
        const pair = parseCard(card);
        if (pair) meta[pair[0]] = pair[1];
      }
      if (ended) break;
    }
    if (!ended) throw new Error('FITS header is missing END or exceeds the safety limit.');
    return { meta, length };
  }

  function hduSize(meta) {
    const naxis = numberOf(meta.NAXIS, 0);
    const bitpix = numberOf(meta.BITPIX, NaN);
    if (!Number.isInteger(naxis) || naxis < 0 || naxis > 12) throw new Error('Invalid FITS NAXIS.');
    if (!Number.isInteger(bitpix) || ![8, 16, 32, 64, -32, -64].includes(bitpix))
      throw new Error('Unsupported FITS BITPIX.');
    const dims = [];
    for (let i = 1; i <= naxis; i++) {
      const d = numberOf(meta[`NAXIS${i}`]);
      if (!Number.isInteger(d) || d < 0) throw new Error('Invalid FITS dimensions.');
      dims.push(d);
    }
    const pcount = numberOf(meta.PCOUNT, 0);
    const gcount = numberOf(meta.GCOUNT, 1);
    if (!Number.isInteger(pcount) || pcount < 0 || !Number.isInteger(gcount) || gcount < 1)
      throw new Error('Invalid FITS PCOUNT or GCOUNT.');
    // FITS specifies group size = (PCOUNT + NAXIS product) * GCOUNT.
    const elements = dims.length ? dims.reduce((a, b) => a * b, 1) : 0;
    const dataBytes = (elements + pcount) * gcount * Math.abs(bitpix) / 8;
    if (!Number.isSafeInteger(dataBytes)) throw new Error('FITS data length is unsafe.');
    return { bitpix, dims, dataBytes };
  }

  async function scanFits(file) {
    if (!file || !Number.isFinite(file.size) || file.size < FITS_BLOCK)
      throw new Error('Choose a valid FITS file.');
    if (file.size > MAX_FILE_BYTES)
      throw new Error('This proof of concept accepts files of at most 2 GiB.');
    const signature = decoder.decode(await file.slice(0, 16).arrayBuffer());
    if (!signature.startsWith('SIMPLE  =')) {
      if (signature.charCodeAt(0) === 31 && signature.charCodeAt(1) === 139)
        throw new Error('Gzip-compressed FITS is not supported in this preview. Use an uncompressed .fits file.');
      throw new Error('The selected file does not have a FITS primary header.');
    }
    const hdus = [];
    let offset = 0;
    for (let i = 0; i < MAX_HDUS && offset + FITS_BLOCK <= file.size; i++) {
      const { meta, length } = await readHeader(file, offset);
      const { bitpix, dims, dataBytes } = hduSize(meta);
      const dataStart = offset + length;
      if (dataStart + dataBytes > file.size) throw new Error('Truncated FITS data block.');
      const name = String(meta.EXTNAME || (i === 0 ? 'PRIMARY' : `HDU ${i}`)).trim();
      hdus.push({ name, dims, bitpix, dataBytes, dataStart, meta });
      const nextOffset = dataStart + Math.ceil(dataBytes / FITS_BLOCK) * FITS_BLOCK;
      if (nextOffset <= offset) throw new Error('Invalid FITS header offsets.');
      offset = nextOffset;
    }
    return hdus;
  }

  function readPixel(view, offset, bitpix, blank) {
    let value;
    switch (bitpix) {
      case 8: value = view.getUint8(offset); break;
      case 16: value = view.getInt16(offset, false); break;
      case 32: value = view.getInt32(offset, false); break;
      case -32: value = view.getFloat32(offset, false); break;
      case -64: value = view.getFloat64(offset, false); break;
      default: return NaN;
    }
    return bitpix > 0 && Number.isFinite(blank) && value === blank ? NaN : value;
  }

  function quantile(sorted, fraction) {
    if (!sorted.length) return NaN;
    return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)))];
  }

  // Simple perceptually ordered night-sky palette, not a calibrated heat map.
  const palette = [
    [0, 5, 6, 22], [0.2, 57, 16, 91], [0.45, 141, 32, 108],
    [0.7, 226, 78, 62], [0.9, 252, 173, 49], [1, 252, 251, 185]
  ];
  function shade(t) {
    const x = Math.max(0, Math.min(1, t));
    let a = palette[0], b = palette[palette.length - 1];
    for (let i = 1; i < palette.length; i++) {
      if (x <= palette[i][0]) { a = palette[i - 1]; b = palette[i]; break; }
    }
    const factor = (x - a[0]) / (b[0] - a[0] || 1);
    return [1, 2, 3].map(k => Math.round(a[k] + (b[k] - a[k]) * factor));
  }

  async function makePreview(file, maxSide = 1000) {
    const hdus = await scanFits(file);
    const candidates = hdus.filter(h => h.dims.length === 2 && h.dims.every(d => d > 0)
      && SUPPORTED_BITPIX.has(h.bitpix) && h.meta.ZIMAGE !== 'T');
    const hdu = candidates.find(h => h.name.toUpperCase() === 'IMAGE') || candidates[0];
    if (!hdu) throw new Error('No supported uncompressed 2-D IMAGE HDU was found.');

    const [width, height] = hdu.dims;
    const stride = Math.max(1, Math.ceil(Math.max(width, height) / Math.max(32, Math.min(1200, maxSide))));
    const outWidth = Math.ceil(width / stride), outHeight = Math.ceil(height / stride);
    const bytesPerPixel = Math.abs(hdu.bitpix) / 8;
    const bscale = numberOf(hdu.meta.BSCALE, 1), bzero = numberOf(hdu.meta.BZERO, 0);
    const blank = numberOf(hdu.meta.BLANK);
    const sample = new Float32Array(outWidth * outHeight);
    const rowBytes = width * bytesPerPixel;
    let wholeImage = null;
    if (hdu.dataBytes <= MAX_IN_MEMORY_IMAGE_BYTES) {
      wholeImage = new DataView(await file.slice(hdu.dataStart, hdu.dataStart + hdu.dataBytes).arrayBuffer());
    }
    for (let oy = 0; oy < outHeight; oy++) {
      const sy = Math.min(height - 1, oy * stride);
      const row = wholeImage || new DataView(await file.slice(
        hdu.dataStart + sy * rowBytes, hdu.dataStart + (sy + 1) * rowBytes).arrayBuffer());
      const offset = wholeImage ? sy * rowBytes : 0;
      for (let ox = 0; ox < outWidth; ox++) {
        const value = readPixel(row, offset + Math.min(width - 1, ox * stride) * bytesPerPixel, hdu.bitpix, blank);
        sample[oy * outWidth + ox] = Number.isFinite(value) ? value * bscale + bzero : NaN;
      }
    }
    const finite = [];
    const step = Math.max(1, Math.ceil(sample.length / 60000));
    for (let i = 0; i < sample.length; i += step) if (Number.isFinite(sample[i])) finite.push(sample[i]);
    if (!finite.length) throw new Error('No finite pixel values in the image preview.');
    finite.sort((a, b) => a - b);
    const low = quantile(finite, 0.01), high = quantile(finite, 0.995);
    const span = Math.max(1e-12, high - low);
    const rgba = new Uint8ClampedArray(outWidth * outHeight * 4);
    let valid = 0;
    // FITS array row zero is the bottom row; canvas row zero is the top row.
    for (let y = 0; y < outHeight; y++) {
      for (let x = 0; x < outWidth; x++) {
        const val = sample[(outHeight - 1 - y) * outWidth + x];
        const idx = (y * outWidth + x) * 4;
        if (Number.isFinite(val)) {
          valid++;
          const rgb = shade((val - low) / span);
          rgba[idx] = rgb[0]; rgba[idx + 1] = rgb[1]; rgba[idx + 2] = rgb[2];
        } else {
          rgba[idx] = 6; rgba[idx + 1] = 7; rgba[idx + 2] = 12;
        }
        rgba[idx + 3] = 255;
      }
    }
    return { width: outWidth, height: outHeight, rgba, metadata: {
      hdu: hdu.name, imageWidth: width, imageHeight: height, bitpix: hdu.bitpix,
      bunit: hdu.meta.BUNIT || 'Unspecified', scaleLow: low, scaleHigh: high,
      validPercent: +(100 * valid / sample.length).toFixed(3),
      hdus: hdus.map(h => `${h.name}: ${h.dims.join(' × ') || 'no image'} [BITPIX ${h.bitpix}]`),
      stride, displayConvention: 'FITS row order (bottom to top); no WCS reprojection'
    }};
  }

  const api = { parseCard, scanFits, makePreview };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof scope.postMessage === 'function' && typeof scope.importScripts === 'function') {
    scope.addEventListener('message', async event => {
      if (!event.data || event.data.type !== 'preview') return;
      const id = event.data.id;
      try {
        const result = await makePreview(event.data.file);
        scope.postMessage({ id, type: 'preview', ...result }, [result.rgba.buffer]);
      } catch (error) {
        scope.postMessage({ id, type: 'error', message: error.message || 'Could not read FITS.' });
      }
    });
  }
})(typeof self !== 'undefined' ? self : globalThis);
