# Architecture

Artemisos is a Flask application with a Jinja template and plain JavaScript/CSS. Its initial design intentionally avoids a frontend build system, a database, and user accounts. The backend serves UI files and exposes JSON/PNG endpoints that retrieve public astronomy data on demand.

## Single application entry point

**`main.py` is the only server entry point.** It defines the Flask `app`, the main IRSA/SPHEREx routes, request validation, FITS previewing, exploratory pixel photometry, and the optional stack/cube endpoints.

- **Development:** `python main.py` calls `app.run()` only when invoked as a script.
- **Production:** `gunicorn ... main:app` imports the Flask object without running the development server.
- **WISE:** `wise_routes.py` registers an optional Flask Blueprint using helpers from `main.py`. This is a module, not another application.

Do not create a second Flask application to add endpoints. Prefer adding a small module or Blueprint for new external data sources while keeping endpoint contracts stable.

## Module ownership

| File | Responsibility | When to edit |
| --- | --- | --- |
| `main.py` | Flask app, SPHEREx archive query, source-URL checks, preview/caching, core endpoints | Updating core API or archive collections |
| `cube_spectrum.py` | IRSA DR1 HiPS cube tile access and 102-channel pixel sampling | Changing cube source, interpretation, or validation |
| `detector_stack.py` | Shared celestial grid, reprojection, stacking jobs, PNG generation | Improving detector coadds and progress reporting |
| `wise_routes.py` | AllWISE catalog lookup, preview, and overlay routes | Updating WISE catalog or transport behavior |
| `wise_alignment.py` | WCS alignment and image resampling | Improving image overlay numerical methods |
| `templates/index.html` | Semantic UI structure, controls, accessible labels | Adding or rearranging interface elements |
| `static/js/app.js` | Search, bands, playback, zoom/pan, compare, share link, pixel targeting | Changing the central viewer |
| `static/js/spectrum.js` | Per-exposure pixel measurement plots and target updates | Changing epoch spectra UI |
| `static/js/cube_spectrum.js` | 102-channel HiPS spectrum visualization | Changing cube plotting and export |
| `static/js/wise.js` | Side-by-side WISE viewer and optional overlay | Changing WISE UI |
| `static/css/styles.css` | Shared appearance and viewer styles | Changing base design |
| `static/css/layout.css` | Responsive layout | Changing sizing and panel behavior |
| `static/css/wise.css` | WISE-specific appearance | Changing WISE presentation |
| `tests/` | Offline regression tests | Whenever changing a route or UI contract |

## Request flow

```text
Browser (templates/index.html + static/*)
    |
    | user enters RA/DEC and selects Search
    v
GET /api/search --> main.py --> IRSA SIA metadata (DR1 + QR3)
    |
    | grouped observations with dates and trusted FITS URLs
    v
Browser timeline + bands
    |
    | user selects an observation
    v
GET /api/preview --> bounded FITS cutout --> WCS-aware PNG preview/cache
    |
    +--> Optional cube spectrum: /api/spectrum/cube --> cube_spectrum.py
    +--> Optional per-exposure sample: /api/spectrum/point
    +--> Optional detector stack: /api/stack/* --> detector_stack.py
    +--> Optional WISE imagery: /api/wise/* --> wise_routes.py
                                              |
                                              +--> wise_alignment.py
```

The browser waits for user action before initiating the initial archive query. Scientific extensions are independent of the image-search endpoint, so a failed WISE or cube request need not block the viewer.

## Data and caching

- **Source metadata** uses a bounded in-memory cache (15-minute TTL). When a combined SIA request fails, the backend retries DR1 and QR3 separately. Partial catalog results are identified explicitly and are not cached as complete.
- **Quick preview:** a small IRSA FITS cutout is converted to PNG and stored on disk. Full-FITS **Advanced** downloads are optional, bounded, and disabled on Render Free.
- **Cube spectrum, per-exposure measurements, WISE cutouts, and detector stacks** use separate caches or jobs beneath `SPHEREX_CACHE_DIR`.
- Runtime caches are disposable and are excluded by `.gitignore`. Render Free's filesystem is ephemeral; cached files must never be treated as permanent storage.
- A per-resource lock reduces duplicate downloads during concurrent requests. Stack jobs use one in-process worker at a time and are **not** a distributed task queue.

## Input validation and boundaries

- Numerical coordinates and radii are validated before most archive requests.
- Server-side FITS fetches accept only validated HTTPS IRSA archive URLs in the SPHEREx or WISE paths.
- Responses from remote archives can be absent, delayed, partial, or malformed. Core viewer errors are returned as friendly messages; operational details are logged.
- The application has no user accounts, no persistence layer, and no write API for arbitrary files. It is a public demo, not a hardened multi-tenant data-processing platform.

## Updating SPHEREx releases

1. Confirm the new IRSA collection exists and identify changes to its SIA metadata fields, FITS layout, quality extensions, and wavelength definitions.
2. Update `COLLECTIONS` in `main.py` only when the release is publicly available and compatible.
3. Update any HiPS cube source/version in `cube_spectrum.py` separately; this is **not** automatically coupled to SIA collections.
4. Add an offline regression test for any new fields or formats and manually verify actual IRSA responses.
5. Update `README.md`, [API](API.md), [Scientific notes](SCIENCE.md), and `CHANGELOG.md` when behavior changes.

**Important:** The application does not automatically discover newly published IRSA collection names or recalibrate old data.
