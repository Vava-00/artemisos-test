/* Artemisos Drive proof of concept: pure FITS/Drive helpers, no network activity. */
(function (root) {
  'use strict';

  function validDriveId(value) {
    return typeof value === 'string' && /^[A-Za-z0-9_-]{10,128}$/.test(value);
  }

  function driveFileUrl(id) {
    if (!validDriveId(id)) throw new Error('Invalid Google Drive file ID.');
    return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
  }

  function downloadCandidates(id) {
    if (!validDriveId(id)) throw new Error('Invalid Google Drive file ID.');
    const safe = encodeURIComponent(id);
    return [
      { label: 'Drive browser download endpoint', url: `https://drive.google.com/uc?export=download&id=${safe}` },
      { label: 'Google Drive REST API (anonymous)', url: `https://www.googleapis.com/drive/v3/files/${safe}?alt=media` }
    ];
  }

  function inspectMagic(bytes) {
    if (!(bytes instanceof Uint8Array)) bytes = new Uint8Array(bytes);
    if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
      return { valid: true, type: 'gzip stream', note: 'A compressed FITS candidate; decompress and validate the FITS header before scientific use.' };
    }
    const header = new TextDecoder('ascii').decode(bytes.subarray(0, 80));
    if (header.startsWith('SIMPLE  =')) return { valid: true, type: 'FITS primary HDU', note: 'Standard FITS primary header found.' };
    if (header.startsWith('XTENSION=')) return { valid: true, type: 'FITS extension', note: 'An extension header was found, not a complete primary FITS.' };
    if (/^\s*(?:<!doctype|<html|<head|\{|\[)/i.test(header)) return { valid: false, type: 'HTML/JSON', note: 'This appears to be a web page or API error rather than FITS data.' };
    return { valid: false, type: 'unknown', note: 'The first bytes are not a recognized FITS or gzip signature.' };
  }

  const api = { validDriveId, driveFileUrl, downloadCandidates, inspectMagic };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ArtemisosDriveHelpers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
