# Changelog

This document records integration-level changes made for the cleaned, submission-oriented Artemisos package. It does not imply a formal software release or a completed live production validation.

## Submission candidate — 2026-11-15

### Application structure

- Kept **one Flask application entry point**, `main.py`, for local development and `main:app` for production.
- Removed the redundant `app.py` launcher; no alternative application backend is shipped.
- Preserved separate Python modules for WISE, WCS alignment, detector stacks, and the DR1 HiPS cube.
- Kept page structure, browser logic, and styles in their conventional `templates/` and `static/` directories.

### Integrated functionality

- Responsive, collapsible navigation panels and opt-in WISE side-by-side and aligned overlay views.
- 102-channel DR1 mosaic pixel-spectrum plot and CSV export.
- Exploratory per-exposure measurements, WCS-aligned detector stacking, and click-to-select sky coordinates.
- Preserved core SPHEREx search, six-band timeline/playback, comparison, sharing, and Quick/Advanced preview behavior.

### Reliability and regression coverage

- Preserved the established English-language API contracts, input validation, IRSA retry behavior, and mode restrictions.
- Corrected an undefined variable in AllWISE metadata selection that would break the WISE catalog search at runtime.
- Added isolated WISE metadata regression tests for tile selection, excluded products, and wavelength-unit handling.

### Documentation

- Replaced prior merge-only Spanish notes with maintainable English documentation: architecture, HTTP API, scientific interpretation, deployment, and contributor verification.
- Clarified that offline tests are not a substitute for deployed Flask/IRSA smoke tests.
- Documented the placeholder logo and the team's still-undecided software license.

## Interface refinements — 2026-11-15

- Keep the comparison-date chips at two per row and align the WISE frame with the SPHEREx image.
- Display WISE overlay controls under the optional WISE frame, only while WISE is enabled.
- Open only the Search the sky accordion on initial load.
- Place the **Pick spectrum target on image** selection and reset controls within the Spectrum accordion.
- Keep only the **102-channel DR1 cube CSV** export button; remove the redundant top-level Spectrum CSV control and the associated unused JavaScript handler.
- No changes were made to WISE archive routes, image-processing algorithms, or server deployment settings in these interface revisions.

## Overlay control visibility fix — 2026-11-15

- Fixed the WISE toggle handler to synchronize the overlay button's visibility immediately when the side-by-side viewer is enabled. Previously the button could remain hidden until a later sky-search event.
- Preserved the overlay's existing WCS alignment behavior and API requests; no server-side WISE configuration was changed.
- Expanded offline JavaScript regression coverage for initial, enabled, disabled, and re-enabled overlay control states.
