# Development and verification

This guide is the team handoff for a codebase intended to be easy to maintain, test, and submit.

## Working agreements for contributors

- **Keep one Flask application.** `main.py` is the entry point; new features can live in small Python modules or Blueprints. Do not add a second `app.py` or a parallel API server.
- Use `templates/` for Jinja HTML, `static/js/` for browser behavior, and `static/css/` for appearance. Avoid large inline `<script>` and `<style>` blocks.
- Add a route and its JavaScript consumer **together**. Preserve established route names, request fields, and response fields unless the related tests and documentation are updated.
- Keep external archive calls opt-in, bounded, and independent of the core viewer. Validate URL hosts/paths and all numerical inputs before fetching FITS data.
- Do not commit `.env`, `.cache/`, large FITS files, virtual environments, compiled Python files, or machine-local assets.
- Use **English** for documentation, code comments, UI strings, commit/PR descriptions, and new tests.
- State uncertainty and data provenance accurately. Avoid presenting provisional pixel estimates as calibrated results.

## Where to make changes

| Task | Files to check |
| --- | --- |
| Change page structure or sidebar | `templates/index.html`, `static/css/layout.css` |
| Change colors or shared UI appearance | `static/css/styles.css` |
| Change search, playback, timeline, or shared link | `static/js/app.js`, core routes in `main.py` |
| Add a published SPHEREx collection | `main.py` (`COLLECTIONS`), archive tests, docs |
| Change per-exposure plots | `static/js/spectrum.js`, photometry in `main.py` |
| Improve 102-channel mosaic sampling | `cube_spectrum.py`, `static/js/cube_spectrum.js` |
| Change stacked images | `detector_stack.py`, corresponding UI in `static/js/app.js` |
| Change WISE archive integration | `wise_routes.py`, `wise_alignment.py`, `static/js/wise.js` |
| Change deployment limits | `render.yaml`, `.env.example`, `docs/DEPLOYMENT.md` |

## Local development

Use Python 3.11 and follow the environment/install steps in [README](../README.md). Run with `python main.py`; check `/health` to confirm the local server is responding. A live sky search requires internet access and the NASA/IPAC archive.

`.env.example` is a reference only. Values must be exported separately or configured with the hosting provider; there is no automatic dotenv loader.

## Automated tests

Run Python unit tests without pytest:

```bash
python -m unittest discover -s tests -p 'test_*.py' -v
```

If pytest is installed:

```bash
python -m pytest -q
```

Run Node.js browser simulations with Node 18+:

```bash
node tests/test_viewer.cjs
node tests/test_share_url.cjs
node tests/test_spectrum.cjs
node tests/test_cube_spectrum.cjs
node tests/test_wise.cjs
```

Check code syntax without starting the server:

```bash
python -m compileall -q main.py cube_spectrum.py detector_stack.py wise_routes.py wise_alignment.py
node --check static/js/app.js
node --check static/js/spectrum.js
node --check static/js/cube_spectrum.js
node --check static/js/wise.js
```

Most tests use isolated source-code execution, synthetic FITS data, or simulated browser environments. They catch regressions but do **not** replace a live Flask + IRSA integration check. A dependency-free WISE catalog regression test specifically ensures the expected AllWISE band selection still works.

## Manual release acceptance checklist

Before announcing a public deployment, mark each item only after **observing it work on the target environment**:

- [ ] The application starts with `python main.py` and production Gunicorn imports `main:app`.
- [ ] `/health` returns a successful JSON response.
- [ ] Search by RA/DEC displays a real IRSA catalog result (or explains verified lack of coverage).
- [ ] Search by name resolves a known object.
- [ ] Switching SPHEREx bands and animation dates updates the displayed image correctly.
- [ ] Zoom, pan, capture/compare, and shared URLs work in desktop and mobile browsers.
- [ ] Quick-mode FITS previews load, and Advanced mode is disabled on a small server.
- [ ] Optional per-exposure spectrum and 102-channel cube show correct quality metadata or fail gracefully.
- [ ] Detector stack reports progress and handles incomplete/invalid FITS coverage.
- [ ] WISE search loads tiles, supports band switching, and Quick-mode WCS overlay aligns where coverage exists.
- [ ] Invalid coordinates, invalid FITS URLs, and upstream errors do not expose stack traces in the UI.
- [ ] Documentation and UI are in English and do not claim calibrated spectroscopy or confirmed discoveries.
- [ ] No secrets, caches, FITS files, or unrelated temporary files are included in the submission ZIP/repository.
- [ ] The team has reviewed branding, attribution, and whether a software `LICENSE` should be added.

The checklist is intentionally **not pre-checked**: offline test success does not imply these live checks have been completed.

## Handoff and change review

Before merging a teammate's change, verify its route contract, its expected user interaction, its regression test, and any scientific or deployment caveat. Review the change in a separate branch when possible. See [Architecture](ARCHITECTURE.md) for ownership boundaries and [API](API.md) for endpoint formats.
