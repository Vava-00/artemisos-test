# Artemisos Local Full FITS Preview (experimental)

## What was verified

The supplied SPHEREx file was read through the team's authorized Drive connection for development-time validation. The file is **65,692,800 bytes (62.65 MiB)**. Its primary HDU has no image data; the `IMAGE` extension contains a **2040 × 2040**, big-endian **32-bit floating-point** array with `BUNIT = MJy / sr`. Other HDUs include `FLAGS`, `VARIANCE`, `ZODI`, `EPSF`, and `WCS-WAVE`.

The independent JavaScript reader successfully parsed all seven HDUs and generated a **680 × 680** preview from the original `IMAGE` values using a three-pixel stride. The reader uses a contrast stretch for visualization, not calibrated photometry.

**These tests do not demonstrate anonymous Google Drive API access.** The previous browser diagnostics reported a blocked `fetch()` download and HTTP 403 from the anonymous Drive REST API. Google Drive's browser download link can still be used to download a file manually.

## How to run without changing the production viewer

1. Copy the new files in this add-on to the matching paths in the GitHub repository.
2. Push the commit; the existing Render web service can deploy the additional static files.
3. Visit `https://YOUR-SERVICE.onrender.com/static/local-fits-preview.html`.
4. Click **Open the sample SPHEREx FITS on Google Drive**, download the `.fits` file, and select it using the file picker.
5. Click **Preview full FITS**. A Web Worker reads and converts the pixels locally. The file is **not** uploaded to Render.
6. Optionally click **Save file to local browser storage**, then use **Preview cached FITS** to reopen it without downloading again. The same OPFS test folder is shared with `drive-test.html`.

The production viewer at `/` remains unchanged. This experiment does not change `main.py`, `render.yaml`, `requirements.txt`, existing templates, CSS, existing `app.js`, or `spectrum.js`.

## New files

```text
static/local-fits-preview.html          Standalone browser preview page
static/js/local-fits-preview.js        File picker, OPFS, Web Worker UI
static/js/fits-image-worker.js         FITS HDU parser and image rendering
tests/test_local_fits_preview.cjs     Network-free FITS test
docs/LOCAL_FITS_PREVIEW.md            This document
```

## Technical limitations

- The proof of concept accepts **uncompressed** standard FITS images with a supported **2-D IMAGE HDU** and `BITPIX` 8, 16, 32, -32, or -64. It does not currently decode `.fits.gz`, tiled-compressed images, tables into images, or 64-bit integer image values.
- It displays a downsampled full-frame thumbnail using a 1%–99.5% percentile contrast stretch and an illustrative palette. Numerical pixel values are read with their FITS big-endian encoding and `BSCALE`/`BZERO` when present. Invalid and blank pixels are masked.
- It respects FITS row origin when drawing but does **not** apply celestial WCS reprojection. Do **not** compare pixel positions across epochs as if the images were already aligned.
- No automatic IRSA or Google Drive downloads are included. Users must download the FITS using their browser and select it, or reopen a previously cached local copy.
- OPFS storage is isolated to the user's browser origin and is subject to quota and deletion by browser policies. This test imposes a 2 GiB maximum per selected FITS file but does not guarantee that the browser has that much free storage or memory.
- No Google OAuth tokens, API keys, private Drive data, or large FITS binaries are bundled or uploaded by these files.

## Next step for the main viewer

After real-browser validation, integrate a third `Local Full FITS` rendering path that uses the Web Worker and OPFS cache to populate the existing timeline and buttons. Keep the existing Quick mode unchanged. For automatic FITS downloads, first add a **CORS-enabled distribution origin** (e.g., an object store or an authorized upload pipeline); the anonymous Google Drive endpoints tested so far are insufficient for automatic `fetch()` access.

## Tests

```bash
node tests/test_local_fits_preview.cjs
```

This suite uses a synthetic FITS file, no network connection, and no Google Drive credentials. The actual team's sample FITS was additionally parsed and rendered with the same JavaScript reader during development; that sample file is deliberately not included in the repository.
