# Artemisos · SPHEREx Sky Viewer

An open-source, browser-based prototype for exploring time-variable observations from **NASA's SPHEREx mission**. Created for the **2026 NASA Space Apps Challenge — Planet X and SPHEREx**.

Artemisos lets visitors search by right ascension (RA) and declination (DEC) or an astronomical object name, explore six near-infrared detector bands, animate observations in time, compare selected epochs, inspect original FITS files, and generate an **exploratory** brightness-versus-wavelength plot.

> **Scientific scope:** The spectrum module estimates background-subtracted pixel surface brightness, not a calibrated source spectrum. Measurements may come from different observations and dates. It cannot, by itself, establish molecular detections or new discoveries.

## Features

- Search by coordinates or resolve an object name using Astropy's name resolver.
- Query the SPHEREx DR1 and QR3 collections through the NASA/IPAC IRSA SIA service.
- Explore six detector bands, a timestamped timeline, playback, zoom, and pan.
- Capture and compare observations; share a link to a specific sky region and image.
- **Quick:** request bounded FITS cutouts and render cached PNG previews.
- **Advanced (optional):** retrieve the full original FITS, then produce a downsampled preview; available only when the server enables it.
- Generate an optional pixel-based brightness plot with uncertainty estimates and CSV export.
- Recover automatically from transient catalog failures and identify incomplete catalog results.
- Expose `/health` for deployment monitoring.

## Project structure

```text
artemisos-spherex/
├── main.py                     Flask routes, IRSA access, FITS rendering, photometry
├── requirements.txt           Python dependencies (including Gunicorn)
├── render.yaml                Free-tier Render deployment blueprint
├── .python-version            Reproducible Python version
├── .env.example               Configuration reference (no secrets)
├── .gitignore                 Ignore local caches and build files
├── templates/
│   └── index.html             Flask/Jinja page and accessible UI structure
├── static/
│   ├── css/styles.css         All styles, including responsive layout
│   ├── js/app.js              Viewer UI + IRSA controller
│   ├── js/spectrum.js         Optional spectrum plot and CSV export
│   └── assets/                Placeholder/team SVG logos
└── tests/
    ├── test_api_contract.py
    ├── test_backend_modes.py
    ├── test_backend_spectrum.py
    ├── test_irsa_recovery.py
    ├── test_share_url.cjs
    ├── test_spectrum.cjs
    └── test_viewer.cjs
```

`.cache/spherex/` is created automatically at runtime and is **not** tracked by Git. It may contain large FITS downloads. The `static/assets/nasa-logo.svg` currently supplied with the project is a **placeholder wordmark, not the official NASA insignia**. Replace it with an approved asset if your use requires official mission branding; follow NASA's media guidelines.

## Run locally

**Prerequisites:** Python 3.11, pip, and internet access for the live IRSA archive. Node.js 18+ is needed only to run the browser tests.

```bash
# Create a virtual environment (optional but recommended).
python -m venv .venv

# Activate it: Windows PowerShell
.venv\Scripts\Activate.ps1
# Or macOS/Linux:
# source .venv/bin/activate

pip install -r requirements.txt
python main.py
```

Open **http://127.0.0.1:5000/**. Do not open `templates/index.html` directly; Flask renders its template and serves the static files.

The page does **not** contact the archive until the visitor presses **Search**. The Quick-mode search radius is fixed internally at **0.02 degrees**, not an exposed field. An internet connection is needed to resolve names and retrieve SPHEREx data.

## Deploy from GitHub to Render (Free)

1. Create a GitHub repository and push the **contents of this folder** to the repository root. Do not upload `.cache/`, `.env`, or virtual environments.
2. Sign in to [Render](https://dashboard.render.com/) and connect your GitHub account.
3. Use **New → Blueprint** and select your repository. Render will read `render.yaml` to create a **Python Web Service** with the **Free** instance type.
4. Wait for the deploy to finish and open the assigned `https://<your-service>.onrender.com` address.
5. Visit `https://<your-service>.onrender.com/health` to confirm the Flask process responds with JSON containing `"status": "ok"`.
6. Enter coordinates in the app and press **Search** to verify actual IRSA access.

If you create a **Web Service** manually instead of using the Blueprint, choose `Python 3`, the `Free` plan, the build command `pip install -r requirements.txt`, and the start command below. Also copy the `envVars` from `render.yaml` into the Render dashboard.

```bash
gunicorn --workers 1 --threads 2 --timeout 180 --bind 0.0.0.0:$PORT main:app
```

### Important Free plan limitations

Render Free web instances have **512 MB RAM**, **ephemeral local storage**, and may spin down after **15 minutes of inactivity**. The next visitor can experience a cold start. Runtime files and caches disappear when an instance restarts or redeploys; **this does not delete the GitHub repository**. Render's included free usage and bandwidth limits also apply.

To fit the available memory, `render.yaml`:

- Sets `SPHEREX_ALLOW_ADVANCED=false`: the full-FITS switch is visibly disabled and the server rejects direct Advanced preview requests.
- Uses **one Gunicorn worker** with two threads to avoid replicating large scientific libraries across multiple processes.
- Limits preview disk-cache capacity to **128 MB** and stores cache files under `/tmp/artemisos-spherex`.

**Quick search, six bands, playback, comparison, name resolution, original-FITS download links, and optional spectrum generation remain available.** Spectrum generation is an on-demand, sequential network workload and may still take time or be constrained by Free-tier resources. The original-FITS download link points to IRSA directly; it does not download the original file into the Render instance.

To enable the Advanced rendering mode on a larger server, set `SPHEREX_ALLOW_ADVANCED=true`, provision enough disk/RAM, and tune `SPHEREX_MAX_FULL_FITS_MB`, `SPHEREX_FULL_CACHE_MB`, and `SPHEREX_MAX_FULL_PIXELS`. Do **not** enable full-FITS downloads on Render Free.

Official references: [Render Flask guide](https://render.com/docs/deploy-flask), [free instance limits](https://render.com/docs/free), [Python versions](https://render.com/docs/python-version).

## Using the viewer

1. Enter coordinates in decimal degrees (RA **0–360**, DEC **−90 to +90**) or select **Search by name**.
2. Choose Quick mode (or Advanced if it is enabled on your server), then press **Search**.
3. Use **Band 1–6** to switch detectors. The selected band is prepared before playback begins.
4. Use **Time interval (sec)** to control animation speed and **Period (days)** to skip ahead to the first actual observation at or after the chosen time jump. All observed dates remain on the timeline.
5. Zoom, pan, capture selected dates, or use **Compare** to move among saved observations.
6. Click **Generate spectrum** to begin optional, sequential brightness measurements. Select points to open the corresponding sky image, or export CSV.

A valid shared link includes `ra`, `dec`, `view`, `band`, and `obs` parameters. The recipient must still press Search; opening a link does **not** start archive requests. Older links with a `radio` parameter are accepted, but that obsolete radius is ignored and removed when the app next updates the URL.

Example (the observation ID below is illustrative):

```text
https://your-app.onrender.com/?ra=12.4&dec=-2.5&view=quick&band=3&obs=example-obs-123
```

### Catalog recovery and cache behavior

The backend queries **DR1 + QR3** together; if the combined catalog query fails, it retries and then queries collections individually. When only one collection responds, it displays a nonfatal **partial-results** notice. If neither responds, it shows a user-friendly error instead of a Python traceback.

Full catalog responses are cached in memory for 15 minutes. PNG previews, optional full FITS data, and spectrum results are cached separately on disk where permitted. The application does **not** automatically discover newer archive collection names: update `COLLECTIONS` in `main.py` when new published collections are supported and re-run the tests.

## API reference

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Main viewer |
| `/health` | GET | Server health, no NASA request |
| `/api/resolve?name=Barnard%27s%20Star` | GET | Resolve astronomical object name |
| `/api/search?ra=133.7951&dec=-7.2451&radius=0.02` | GET | Group IRSA observations by detector |
| `/api/preview?url=...&ra=...&dec=...&radius=0.02&mode=quick` | GET | PNG preview for a trusted IRSA FITS URL |
| `/api/spectrum/point` | POST (JSON) | One exploratory brightness/wavelength measurement |

The English-language search response contains `status`, `total_found`, `bands`, `collections`, `fallback`, `partial`, and `notice`. Each observation has `obs_id`, `s_ra`, `s_dec`, `date`, `mjd`, and `access_url`. Standard IRSA FITS field names remain unchanged. Server-provided URLs are validated as trusted IRSA SPHEREx FITS URLs before they can be downloaded server-side.

The spectrum POST JSON body contains `access_url`, `ra`, `dec`, and `radius`. Successful measurements return `lam` (micrometers, or null), `width`, `flux`, `err`, `bkg`, `unit`, and `method`. Do not treat exploratory photometry as a calibrated source flux measurement.

## Configuration

Copy `.env.example` for reference; **Python does not automatically load this file**. Configure your environment variables in your shell or in Render. The key settings are:

| Variable | Local default | Description |
| --- | --- | --- |
| `SPHEREX_ALLOW_ADVANCED` | `true` | Enable full-FITS previews; Render Free sets `false` |
| `SPHEREX_CACHE_DIR` | `.cache/spherex` | Root of ephemeral runtime cache |
| `SPHEREX_PREVIEW_CACHE_MB` | `512` | PNG preview cache budget in MB |
| `SPHEREX_PREVIEW_CACHE_FILES` | `2500` | PNG file-count limit |
| `SPHEREX_MAX_FULL_FITS_MB` | `2048` | Maximum allowed full FITS download size |
| `SPHEREX_FULL_CACHE_MB` | `8192` | Total full FITS cache budget |
| `SPHEREX_MAX_FULL_PIXELS` | `150000000` | Safety limit for full-frame preview processing |
| `PORT` | `5000` locally | Local development port; Render supplies its own |
| `FLASK_DEBUG` | `false` | Enables development traceback output only when explicitly set |

## Run automated tests

The Python unit tests **simulate HTTP/FITS behavior** without contacting NASA. They exercise fallback, metadata validation, full/quick preview handling, caching, spectrum pixel photometry, and route contracts. JavaScript tests simulate a browser environment using Node.js and require no npm packages.

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
node tests/test_viewer.cjs
node tests/test_share_url.cjs
node tests/test_spectrum.cjs
```

An actual deployment test against the live IRSA service remains necessary. Tests cannot guarantee that a remote catalog or FITS endpoint is available at any given time.

## Data and acknowledgments

- [NASA/IPAC IRSA — SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html)
- [IRSA SPHEREx tutorial notebooks](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
- [NASA Space Apps Challenge](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
- SPHEREx observations and associated archival metadata: **NASA / Caltech / IPAC**.

This repository is a hackathon prototype, not an official NASA service. Add a license file before publicly licensing contributions; no license choice has been made on behalf of the team.
