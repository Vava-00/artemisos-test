# Artemisos V4 — SPHEREx Science Explorer + WISE

A web-based SPHEREx sky viewer for the NASA Space Apps Challenge. Search for astronomical observations by right ascension (RA) and declination (DEC) or object name, explore six near-infrared detector bands over time, compare observations, and optionally generate an exploratory spectrum.

**All user-facing messages are in English.** During a normal search, the interface simply reports that it is searching/retrieving observations. It does **not** warn about possible failures in advance. Only after IRSA actually fails does Artemisos show an appropriate recovery notice, partial-results warning, or unavailable-service message.


## What is new in V4

This release merges **Artemisos V3 Science Explorer** with the optional **WISE comparison and WCS-aligned overlay** from the teammate's `V12 WISE.rar` project. All existing V3 functions are retained: DR1 102-channel cube, epoch measurements, quality filters, time-series plots, detector WCS stacking, target picking, six-band timeline, playback, zoom/pan, quick/advanced FITS, and shareable URLs.

### Collapsible controls

The left sidebar now has independent, keyboard-accessible expandable sections:
**Search the sky**, **Playback**, **IR bands**, **Comparison**, **WISE comparison**, **Detector stack**, and **Spectrum**. Click a heading or use Enter/Space when focused. Search and IR bands are expanded on first load; the other panels start closed. Hiding a section does not erase its data or stop running calculations.

### WISE comparison / overlay

1. Search a position in the regular SPHEREx viewer. Without enabling WISE, this adds **no extra WISE requests**.
2. Open **WISE comparison** in the sidebar, then enable **Compare with WISE**. An independent AllWISE panel opens next to SPHEREx on wide screens, or underneath it on smaller screens. Choose W1 (3.4 µm), W2 (4.6 µm), W3 (12 µm), or W4 (22 µm).
3. Optionally press **Overlay WISE** beside Play. Choose a WISE band and adjust **Opacity**. The backend interpolates the WISE FITS onto the SPHEREx cutout pixel grid using WCS, and the overlay follows pan/zoom across SPHEREx exposures.
4. The WISE overlay is available **only in Quick mode**. The side-by-side panel can be used independently. If WISE/IRSA is unavailable, the original SPHEREx viewer and both spectra continue working.

WISE cutouts are stored in `.cache/spherex/wise/`. This release does **not** ship any large FITS downloads or caches from the teammate's RAR archive. WISE is a mostly static atlas and uses different wavelengths from SPHEREx, so use these panels to compare structure and positions, **not to compare their absolute brightness**.

### Responsive screen sizing

The main image remains square and its width/height are limited using viewport dimensions (`dvh`) and available column width. The timeline never exceeds the viewer width; on large screens the viewer stays visible while scrolling the sidebar where space allows. On phones, the viewer is arranged beneath the compact controls and the WISE panel stacks vertically. The layout was checked at 1440×900, 1366×768, 390×844 and 375×667 screen sizes for horizontal overflow and image dimensions.

### Files added

- `wise.js`: optional AllWISE panel and client-side overlay controls.
- `wise.css`: WISE styles and responsive layout.
- `tests/test_wise_overlay.py`: synthetic WCS alignment test, run with `python tests/test_wise_overlay.py`.

Server routes added: `/wise.js`, `/wise.css`, `/api/wise/buscar`, `/api/wise/preview`, `/api/wise/overlay`.

**Verification limitation:** Python and JavaScript syntax, existing viewer tests, WCS alignment on synthetic arrays, and responsive HTML/CSS layout checks passed. A real WISE and SPHEREx FITS retrieval through NASA/IPAC must still be tested on a computer with the dependencies installed and internet access.

---

## Get started

From the project directory, run:

```bash
python -m pip install -r requirements.txt
python api.py
```

Open **http://127.0.0.1:5000/** in your browser. Use the Flask server instead of opening `index.html` directly as a local file. Internet access is required to query IRSA and download SPHEREx FITS data.

## Searching the sky

The page starts empty: **no catalog request is sent until Search is pressed**.

1. Enter RA and DEC in degrees, or enable **Search by name** and provide an object name.
2. Leave **Advanced search (full FITS)** off for **Quick** mode, which uses FITS cutouts. Enable it to load full FITS images in Advanced mode.
3. Press **Search**. The loading indicator stays visible while the selected detector band is prepared.
4. Use the six band buttons, timeline, playback, zoom, captures, and comparisons to explore the observations.

The search radius is fixed internally at **0.02°**; there is no Radius field. This value is still sent to the backend, but it is intentionally omitted from new shareable URLs.

### Quick versus Advanced

| Mode | Image source | Caching | Typical trade-off |
| --- | --- | --- | --- |
| **Quick** | Small sky-centered FITS cutouts from IRSA | Generated PNG files | Smaller downloads; usually faster |
| **Advanced** | Entire original FITS exposures | Original FITS on disk plus generated PNG | Wider field of view; larger and slower downloads |

Both modes share the same observation catalog. Advanced previews display a reduced rendering of the **complete** exposure, not an enlarged Quick cutout. Caches are stored under `.cache/spherex/`, including `.cache/spherex/full/` for original FITS and `.cache/spherex/spectrum/` for optional spectral measurements.

### Loading and IRSA recovery

When a user starts a search, the loading messages are neutral, for example:

- **Searching the SPHEREx archive (DR1 + QR3)…**
- **Retrieving available SPHEREx observations…**

If the catalog request subsequently encounters a temporary network/server error (such as HTTP 502), the backend automatically retries eligible read-only GET requests, with up to **two additional attempts** and progressive delays. If the joint DR1 + QR3 request still fails, it tries DR1 and QR3 separately.

Only when a problem has **actually occurred** does the UI display a recovery message:

- **Full recovery:** If both collections are recovered separately, a notice explains the recovery. The viewer continues normally.
- **Partial recovery:** If only one collection responds, available observations are displayed along with a warning that results are partial and some observations may be missing.
- **Total failure:** If no collection responds, the user sees an English message explaining that NASA/IPAC IRSA is temporarily unavailable and suggesting another attempt later.

Technical exception details remain in the Python server logs rather than being displayed as raw network errors. The 15-minute in-memory catalog cache is unchanged; **partial results are not cached as complete**. Image and spectrum caches work as before. The new language changes do not alter retry limits or data-recovery behavior.

## Timeline, playback, and comparisons

- **Time interval (sec)** controls the pause between displayed images.
- **Period (days)** specifies the number of calendar days to advance on each playback step. It does **not** remove any observations from the timeline. If no observation exists exactly at the target date, playback selects the next available observation.
- Playback starts automatically after the selected band is ready, unless the user has manually pressed Pause. A manual pause stays in effect during band changes and subsequent searches.
- Zoom and pan persist across image/band changes and reset only when starting a completely new sky search.
- Use **Capture point** and **Comparison** to save and switch between selected observations.

### Shareable links

After a search, the page URL may contain `ra`, `dec`, `view`, `band`, and `obs`, allowing a particular observation to be shared. Example (fictional observation):

```text
http://127.0.0.1:5000/?ra=12.4&dec=-2.5&view=quick&band=3&obs=example-obs-123
```

The URL changes using `history.replaceState`, so playback does not flood the browser history. Shared links **prefill** the search and remember the requested band/exposure, but **do not automatically start a query**. The recipient must click Search. Older URLs containing `radio` remain readable, but the obsolete parameter is ignored and removed when a new URL is written. URLs beginning with `127.0.0.1` work only on the computer running Flask; public sharing requires public hosting.

## Spectrum module

The **Spectrum** section remains beneath **Comparison** and now has two separate tools:

1. **DR1 cube · 102 channels (automatic):** After Search resolves the target coordinate, Artemisos requests a quick-look pixel spectrum from the DR1 HiPS all-sky mosaic, **independently of the SIA DR1/QR3 observation catalog**. The chart appears when the data arrive, and it offers **Retry** if the cube service fails. No artificial spectrum is substituted. It does not interrupt the viewer or playback. A separate **CSV** export includes channel, detector, wavelength, brightness, NHITS and FLAGS. This is the *combined DR1 mosaic*, **not a time-resolved 102-channel spectrum for each observation**. There are 102 nominal channels; channels 51 and 52 are intentionally blank in the DR1 product.
2. **Epoch measurements (manual):** The team's original module remains unchanged. Click **Generate spectrum** to measure exploratory brightness values from the same observation catalog used by the viewer. You may pause/resume the analysis, click a plotted point to display its observation, and export its CSV.

For each single epoch, the existing module uses a small FITS cutout, identifies the target with WCS, and attempts to retrieve pixel-specific wavelength information from WCS-W. It estimates brightness from an aperture and local background, with uncertainties when supported by the FITS data. Epoch measurements use cutouts even in Advanced mode to avoid downloading complete FITS files solely for this analysis.

### How the new DR1 cube works

- Official collection name: **`spherex_dr1_cube`** (the spelling `spherex_d1_cube` is incorrect). The implementation **does not call `/SIA` for cubes**: it computes the HiPS order-5 NESTED HEALPix tile with `hpgeom`, then uses the official DR1 `hips_20261026` direct IBE URL. This avoids any SIA/502 outage that affects only the catalog endpoint. If the IBE server is also down, a Retry option appears.
- `cube_spectrum.py` reads `IMAGE`, `NHITS`, `FLAGS`, and `SPECTRAL_CHANNELS`. It uses the cube's celestial WCS to locate the sky pixel and extracts **`IMAGE.section[:, y, x]`**, not `IMAGE.data`. Astropy's `fsspec` support requests small byte ranges where the hosting server supports HTTP Range, instead of forcing a full ~300 MB download.
- The pixel surface-brightness values are displayed in **MJy/sr** (the FITS header BUNIT is forwarded). Channels with no valid pixel hits and the two documented blank dichroic channels are omitted from connected line segments.
- Results are cached in `.cache/spherex/cube102/*.json` per position and reused by later queries.
- **Resilient cube access:** The backend now tries IRSA IBE first and then the public **AWS S3 mirror** for the same DR1 FITS tile (`nasa-irsa-spherex`, prefix `dr1/`). This fallback is based on IRSA's public cloud-access documentation, but must be tested from your own network. It never replaces the data with a fabricated spectrum. By default, both locations are accessed through small HTTP ranges (when supported); complete ~300 MB downloads are disabled. The UI shows a short error category from the backend and stops displaying the loading state on failure. It automatically times out after three minutes and lets you Retry without interrupting the viewer.
- Optional `SPHEREX_CUBE_S3_ROOT` sets the HTTPS root of a public mirror if the release directory changes; `SPHEREX_CUBE_ROOT` sets the primary IRSA root. The original PNG/full-FITS caches are untouched.
- **Performance depends on IRSA and HTTP Range support.** It is not scientifically justified to promise 1–2 seconds for the first request; the official notebook reports that downloading an entire cube (~300 MB) can take 1–3 minutes. Range requests may be substantially faster, but require a compatible server. If they fail and you accept large downloads, you can opt in with `SPHEREX_CUBE_ALLOW_FULL_DOWNLOAD=1`; the complete tile then lives in `.cache/spherex/cube102/` and can be reused for other coordinates in the same tile. By default, this fallback is disabled to protect bandwidth and disk usage.
- You can change the HiPS source using the server-side environment variable `SPHEREX_CUBE_ROOT` if IRSA publishes a revised tile directory. This does not accept a user-provided URL from the browser.

**Scientific caution:** the cube contains mosaicked measurements at combined epochs; a single mosaic pixel is not aperture-calibrated source flux. Do not interpret this display alone as a physical detection or a time series. For scientific source analysis, NASA/IPAC recommends its SPHEREx Spectrophotometry tool.

Official references:
- https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/
- https://irsa.ipac.caltech.edu/spherex-archive-documentation/spherex-data-products/
- https://docs.astropy.org/en/stable/io/fits/usage/cloud.html


**Scientific limitation:** both charts are exploratory visualizations and should not be used alone as evidence of a molecule or astronomical discovery.

## Files

```text
api.py                  Flask server, catalog recovery, FITS previews, spectrum measurements
app.py                  Compatibility launcher (imports the same Flask app)
cube_spectrum.py        Direct HiPS cube retrieval, 102-channel extraction and JSON caching
app.js                  Search, bands, playback, comparison, shared links, UI statuses
spectrum.js             Original interactive epoch spectrum and CSV export
cube_spectrum.js        Independent automatic DR1 102-channel spectrum and CSV export
index.html              Interface structure
styles.css              Interface styling
assets/                 Team and NASA logos
requirements.txt        Python dependencies
README.md               This guide
tests/                  Network-free automated tests
.cache/spherex/         Local cache created at runtime (not bundled)
```

The server serves these files from the project root; its template/static paths also support common Flask folder layouts. The original `cosa.html` is retained only for reference. **Both `python api.py` and `python app.py` now start the same backend**; do not mix in an old `app.py` from previous project versions.

## Automated checks

The project includes tests that simulate search results, HTTP 502 recovery, full/partial failures, Quick/Advanced image handling, shared links, playback, zoom, and spectrum integration. From the project directory, run:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_viewer.cjs
node tests/test_share_url.cjs
node tests/test_spectrum.cjs
node tests/test_cube_spectrum.cjs
python tests/test_wise_overlay.py
```

These tests use simulated responses and do not require a real IRSA outage. A final end-to-end check with actual IRSA observations is still recommended.

## Local validation

The new offline suite checks 102 channel extraction, wavelength metadata, blank channels, NHITS masking, HEALPix URL naming, per-coordinate caching, error propagation, SVG rendering, Retry and CSV. The original viewer tests are preserved. **The sandbox could not contact IRSA for a real FITS transaction**: run one real sky search and monitor your server logs to verify your network/proxy allows HTTP Range access to the official IBE tile URL.

## Troubleshooting: DR1 cube unavailable

If sky images work but the cube spectrum shows **Cube spectrum unavailable — use Retry**, the issue is limited to cube access. The application now distinguishes, in English, between an HTTP/network outage, a missing Python package and a FITS format/read error. The console running `python api.py` contains details for the failed IRSA and S3 attempts; the viewer and **Epoch measurements** continue working.

1. Restart Flask to load the updated Python files; reload the browser with Ctrl+F5 to refresh `cube_spectrum.js`.
2. Make sure dependencies are installed in the same Python environment: `python -m pip install -r requirements.txt`.
3. Inspect the Flask console. A `502`, `403`, or missing tile on both servers may require waiting for the archive to recover. The new AWS path is an **alternative attempt, not a guarantee of availability**.
4. Only if you can accept a large download (about 300 MB per tile) and have available disk space, optionally enable complete downloads for subsequent reuse. Windows PowerShell: `$env:SPHEREX_CUBE_ALLOW_FULL_DOWNLOAD = "1"; python api.py`; Linux/macOS: `SPHEREX_CUBE_ALLOW_FULL_DOWNLOAD=1 python api.py`. Leave this off when network or space is limited.

Do not delete existing caches when updating. Spectrum CSV files contain measured values only; the software never makes up missing channels. The updated JavaScript fixes a previous interface bug that left “Loading 102 channels…” visible after a failed request.

Cloud data reference: https://irsa.ipac.caltech.edu/cloud_access/ (SPHEREx bucket `nasa-irsa-spherex`, region `us-east-1`).


## Correction: WCS coordinate arrays (2026-11-15)

`cube_spectrum.py` now normalizes the result of `WCS.world_to_pixel()`
when Astropy returns a NumPy array with a single element instead of a
Python float. This fixes `TypeError: type numpy.ndarray doesn't define
__round__ method`. A multi-element or non-finite coordinate raises a clear
error rather than silently choosing an arbitrary pixel. No changes are
needed to the sky viewer, its timeline, or epoch measurements.

Restart the Python server after replacing the file. If the DR1 cube still
fails, check the **new** traceback in the terminal: it will be a different
problem (for example a network error or an unexpected FITS structure).

---

## Artemisos V3 — Science Explorer (2026-11-15)

This release **preserves the V2 viewer**, both catalog/query modes, playback by selected band, the timeline, zoom/pan persistence, comparisons, shareable URLs, and the optional spectrum modules. It adds four non-blocking analysis features. The interface remains in English.

### 1. DR1 cube: coverage, flags and robust plot

- **Hide flagged channels** removes non-zero `FLAGS` pixels from the *plot only*. It does not change the FITS or the exported 102-channel CSV. Zero/unknown `NHITS` is handled conservatively; unknown is not claimed as zero.
- **Y scale: Robust (5–95%) / Full range** lets users inspect faint structure without a single peak flattening the plot. Robust mode hides out-of-range points visually but does not delete them from the extracted data or CSV.
- Hover over a channel for wavelength, detector, `NHITS` and `FLAGS`. An unusual peak **must not be interpreted as astrophysical without reviewing data quality**. The 1.083 µm helium artifact is documented by IRSA.

### 2. Epoch measurements: by wavelength or time

1. Search as usual. Click **Generate spectrum** in **Epoch measurements** when desired.
2. Choose **Plot: By wavelength** to view the original per-exposure scatter, or **Brightness vs date** to view a time-series within **Time-series band** (1–6).
3. Choose **Observation year**, **Y scale**, or **Hide flagged pixels** for filtering. Each measured observation remains available in the unfiltered catalog, even if it is hidden from a plot.
4. Click a point to open its corresponding observation on the main viewer. Export CSV with measurement uncertainty and pixel flags.

**Scientific caution:** per-exposure wavelengths vary even within one detector. The time-series is a *quick-look exploratory variability chart*, NOT a calibrated light curve. Spectral changes, contamination, backgrounds or image flags may mimic flux changes. `FLAGS` combines the flags under the small measurement aperture; missing `FLAGS` are reported as unknown rather than fabricated.

### 3. Detector stack: WCS-aligned image combination

1. Search and select one IR detector band.
2. Under **Detector stack** choose **Stack Band N**.
3. The Python server requests a small FITS cutout for **each** available exposure in that band, maps it onto a shared RA/DEC TAN grid using WCS, rejects flagged pixels and computes an inverse-variance weighted mean (when `VARIANCE` is present).
4. Progress and failures are shown independently of the sky viewer. The finished 96 × 96 grid is displayed enlarged for inspection; output PNG is cached under `.cache/spherex/stacks/` for later reuse.

Every supplied exposure is attempted; none is intentionally dropped to reduce the catalog. The operation can take a long time with thousands of observations. Only one background stack job runs at a time to protect IRSA and local resources. One stack at a time is available through the UI. The stack is **not** a rigorously wavelength-matched scientific coadd: exposures within a detector cover different wavelengths and dates, and an approximate pixel variance is not the same as a fully calibrated mosaic covariance. Do not treat its pixel brightness as calibrated source photometry.

Endpoints: `POST /api/stack/start`, `GET /api/stack/status/<job_id>`, `GET /api/stack/image/<job_id>`.

### 4. Click a position to inspect its spectrum

1. Search normally and wait for the main sky image to load.
2. Enable **Pick spectrum target on image** and click a pixel. Zoom and pan are taken into account, along with any image letterboxing.
3. The server converts the point into RA/DEC using the *source FITS WCS*, not a guessed linear RA/DEC transformation.
4. The selected coordinate starts a fresh **DR1 cube** query; **Epoch measurements** can be regenerated by clicking **Generate spectrum**. The sky *catalog region remains unchanged* so timeline and images still refer to the initial search. **Reset target** returns both spectra to the search center.

Because overlays and cutouts are different between epochs, the marker appears only on the image where the pixel was clicked. The selected sky coordinate remains active for spectral analysis. On Advanced full-FITS mode, the original FITS must still be present in the full-file cache for click-to-WCS; the button never silently re-downloads an enormous FITS.

Endpoint: `GET /api/sky-at-pixel` (validated IRSA URL and normalized on-image coordinates).

### Running and verifying

```bash
python -m pip install -r requirements.txt
python api.py
# Open http://127.0.0.1:5000

# Offline JS logic tests (Node.js required):
node tests/test_cube_spectrum.cjs
python tests/test_wise_overlay.py
node tests/test_spectrum.cjs
node tests/test_viewer.cjs
node tests/test_share_url.cjs

# Python tests with dependencies installed:
python -m pytest -q tests/
```

New dependency: `scipy` for WCS-grid resampling. The main viewer does not use SciPy until a stack is requested.

### Verification status and limitations

- The project was built from `ArtemisosV2_cubo_WCS_corregido.zip`. The original JS smoke tests pass in a simulated browser environment. Python modules compile successfully.
- The new scientific stack tests contain **synthetic FITS** fixtures to test WCS alignment, pixel quality masks and complete progress. They require Astropy, SciPy and Pytest, and **could not execute in the packaging environment because Astropy was not installed**. They will run after installing requirements and Pytest.
- A browser with a live Flask server and real NASA/IPAC FITS files was **not** available in this packaging environment. The visual and scientific behavior against real SPHEREx data needs to be validated by the team; do not advertise the coadds or variability curves as calibrated results.

### Official references

- [SPHEREx data products (cube IMAGE, NHITS, FLAGS and spectral image VARIANCE)](https://caltech-ipac.github.io/spherex-archive-documentation/spherex-data-products/)
- [SPHEREx IRSA archive and DR1](https://irsa.ipac.caltech.edu/data/SPHEREx/docs/overview_dr1.html)
- [SPHEREx photometry flags](https://irsa.ipac.caltech.edu/onlinehelp/spherex/spherex/sp.html)
- [DR1 spectral HiPS cube tutorial](https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/)
