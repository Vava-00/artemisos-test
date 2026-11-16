# Artemisos — SPHEREx Sky Viewer

**A public, browser-based viewer for exploring changes in the infrared sky.**

Artemisos was created for the **2026 NASA Space Apps Challenge: Planet X and SPHEREx**. It retrieves public observations from NASA/IPAC IRSA and helps visitors compare the same region of sky over time. The project is an independent hackathon prototype, **not an official NASA product**.

> **Scientific caution:** The spectral plots and image stacks are exploratory visualizations, not calibrated source spectroscopy or discovery confirmations. Review [Scientific notes](docs/SCIENCE.md) before interpreting them.

## Features

- Search by **right ascension and declination** (decimal degrees) or resolve an astronomical object name.
- Retrieve observations from the **SPHEREx DR1 and QR3** IRSA collections, grouped into six detector bands.
- Animate observation dates, navigate the timeline, zoom and pan, and compare saved frames.
- Share a sky position, selected band, view mode, and observation through URL parameters.
- View fast **Quick** FITS cutouts or optionally enable **Advanced** full-frame previews on sufficiently powerful servers.
- Plot an exploratory **102-channel DR1 mosaic spectrum** (with CSV export) and optional per-exposure pixel measurements.
- Build an exploratory **WCS-aligned detector stack** from multiple exposures.
- Select a point in a displayed FITS image to retrieve its celestial coordinates.
- Compare with **WISE AllWISE Atlas** images side by side or as a WCS-aligned overlay in Quick mode.
- Continue using the basic viewer if an optional scientific service is unavailable.

## Quick start

**Requirements:** Python **3.11**, pip, and internet access for live astronomical data. Node.js **18+** is needed only for JavaScript tests.

```bash
# Run these commands from the project root.
python -m venv .venv
```

Activate the environment:

```powershell
# Windows PowerShell
.venv\Scripts\Activate.ps1
```

```bash
# macOS / Linux
source .venv/bin/activate
```

Install dependencies and start the local server:

```bash
python -m pip install -r requirements.txt
python main.py
```

Open **http://127.0.0.1:5000/**. Search requests are initiated only when the user submits a search. Do not open `templates/index.html` as a standalone file; Flask must serve the template and static assets.

**One application entry point:** `main.py` defines the Flask application and launches it locally. In production, Gunicorn imports the **same application** with `main:app`. There is no separate `app.py` or duplicate server.

## Deployment

The included [`render.yaml`](render.yaml) configures a Render Python web service:

```bash
gunicorn --workers 1 --threads 2 --timeout 180 --bind 0.0.0.0:$PORT main:app
```

Push the **contents** of this folder to a GitHub repository, then create a **Blueprint** in Render from that repository. Test `/health` after deployment and then make a real sky search. The free instance disables full-FITS Advanced mode to limit memory use. See [Deployment guide](docs/DEPLOYMENT.md) for instructions, caveats, and environment variables.

## Usage

1. Enter RA between **0 and 360°** and DEC between **−90 and +90°**, or search by object name. Select **Search**.
2. Select a SPHEREx detector band (1–6), choose a date, and play the timeline to spot movement or changes.
3. Adjust the interval, zoom, pan, save frames for comparison, or share the current view.
4. Open **Spectrum** (including the **Pick spectrum target on image** control), **Detector stack**, or **WISE comparison** only when needed; these options make additional requests.
5. Use the **CSV** button beside **DR1 cube · 102 channels** to export the cube spectrum, keeping the scientific limitations in mind.

Try WISE 0855 at **RA 08h55m10.831s, DEC −07°14′42.53″** (about **133.79513°, −7.24515°**), or explore Barnard's Star, Epsilon Indi B, RW Aurigae, and R Draconis. Observations depend on the selected region, date, detector, and archive coverage; visible motion or variability is not guaranteed.

Example share URL (the observation ID is a placeholder):

```text
https://example.org/?ra=133.79513&dec=-7.24515&view=quick&band=2&obs=example-observation
```

The link fills the controls but **does not automatically start an archive request**. Users still select Search.

## Project layout

```text
.
├── main.py                 # Single Flask entry point and core SPHEREx routes
├── cube_spectrum.py        # 102-channel DR1 HiPS data access
├── detector_stack.py       # Optional WCS-aligned detector coadds
├── wise_routes.py          # WISE search/preview/overlay Blueprint
├── wise_alignment.py       # WCS-based WISE image reprojection
├── templates/index.html    # HTML template and interactive controls
├── static/
│   ├── css/                # Viewer, layout, and WISE styles
│   ├── js/                 # Viewer, spectra, and WISE browser logic
│   └── assets/             # Project image assets (see branding note below)
├── tests/                  # Offline Python and Node.js regression tests
├── docs/                   # Architecture, API, science, deployment, contributors
├── render.yaml             # Production deployment configuration
├── requirements.txt        # Python runtime dependencies
├── .env.example            # Optional configuration reference
└── CHANGELOG.md            # Project integration history
```

Runtime files go to `.cache/` by default and are excluded from source control. Never commit telescope FITS downloads, secrets, virtual environments, or generated caches.

## Tests

Run the offline Python tests:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
```

For the additional pytest suite, install pytest separately and run:

```bash
python -m pip install pytest
python -m pytest -q
```

Run the Node.js browser simulations (no npm install required):

```bash
node tests/test_viewer.cjs
node tests/test_share_url.cjs
node tests/test_spectrum.cjs
node tests/test_cube_spectrum.cjs
node tests/test_wise.cjs
```

Most tests use synthetic inputs or mock HTTP calls and **do not validate the current IRSA service**. Before public release, complete the manual end-to-end checks in [Development & verification](docs/DEVELOPMENT.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — modules, request flow, responsibilities, caching, and extension points.
- [API reference](docs/API.md) — routes, request formats, responses, and example calls.
- [Scientific notes](docs/SCIENCE.md) — interpretation, uncertainties, and limitations.
- [Deployment](docs/DEPLOYMENT.md) — Render setup, configuration, health checks, and operational limits.
- [Development & verification](docs/DEVELOPMENT.md) — where to make changes, automated tests, and release checklist.
- [Changelog](CHANGELOG.md) — changes in this integrated deliverable.

## Credits and data sources

- [NASA/IPAC IRSA — SPHEREx archive](https://irsa.ipac.caltech.edu/Missions/spherex.html)
- [SPHEREx IRSA tutorial notebooks](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
- [NASA Space Apps Challenge — Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
- AllWISE Atlas data are accessed through NASA/IPAC IRSA.

**Branding:** `static/assets/nasa-logo.svg` is a project-supplied **placeholder wordmark**, not the official NASA insignia. Follow NASA's media/branding guidance before replacing it with official imagery.

**License:** The team has not specified a software license. Do not assume this repository is licensed for reuse; choose and add a `LICENSE` file before publishing it as an open-source project.
