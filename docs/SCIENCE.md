# Scientific notes and limitations

Artemisos is designed to help people **inspect** changes in public infrared observations. A visible feature can suggest something worth studying, but this interface alone cannot establish a discovery, characterize a planet, or prove a molecular identification.

## What the viewer displays

SPHEREx images are collected in multiple infrared channels. The UI groups images into six detector bands and lets users compare observations at different times. Different timestamps, fields of view, sky motion, image quality, spectral channels, and instrumental effects can alter what appears in an animation.

- **Apparent motion:** a shifting point of light may be nearby or moving, but artifacts, image registration, and observation geometry must be ruled out.
- **Brightness changes:** intrinsic variability is possible, but so are differences in wavelength, background, exposure, or calibration.
- **Detector bands:** each band spans a wavelength range. A stack of images from one detector is not necessarily a monochromatic image.

## Two independent spectrum modes

| Mode | Source | Interpretation | Do not infer |
| --- | --- | --- | --- |
| **DR1 HiPS cube (102 channels)** | DR1 mosaic tile at the selected sky position | A 102-channel **pixel surface-brightness** trace, combining observations in the mosaic | Simultaneous source spectroscopy; a molecular detection |
| **Per-exposure measurements** | Individual SPHEREx FITS cutouts | An exploratory local pixel/aperture measurement with approximate uncertainty, background subtraction, flags, and dates | Calibrated source-integrated flux; a clean light curve across mixed wavelengths |

For the cube, examine `NHITS` (coverage) and `FLAGS` (quality). For per-exposure measurements, inspect flagged pixels, measurement uncertainties, crowding, and whether multiple points represent different wavelengths and times. The values can be expressed in image surface-brightness units such as **MJy/sr**, not automatically flux density for a point source.

## Detector stack

The stack reprojects images to a common celestial grid and uses variance weighting when it is available. Masked or invalid pixels are omitted. The result is an **exploratory composite**: exposures within a detector may come from different channels and dates. Moving objects can smear or appear at multiple positions; this is not a photometrically calibrated narrow-band coadd.

## WISE comparison

AllWISE Atlas is from another infrared mission and epoch. Side-by-side and WCS-aligned overlays help compare morphology and candidate position changes. Do not compare absolute pixel intensities across WISE and SPHEREx bands without calibration and bandpass corrections. Overlays can fail where coverage or usable WCS metadata is missing.

## Suggested demonstration targets

- **WISE 0855:** RA `08h55m10.831s`, DEC `−07°14′42.53″` (approximately `133.79513°`, `−7.24515°`).
- **Barnard's Star** and **Epsilon Indi B:** examples of nearby objects worth investigating for apparent motion.
- **RW Aurigae** and **R Draconis:** examples of variable stars worth examining for brightness changes.

A successful initial search does not imply an object will show measurable motion or variability over the available time coverage. Respect sensitivity, cadence, crowding, archival coverage, and quality limitations.

## Interpretation workflow

1. Verify the selected coordinates, time stamps, wavelengths, and the FITS observation metadata.
2. Inspect multiple detector bands and compare several dates before drawing a conclusion.
3. Check image artifacts, quality flags, background, detector footprints, and nearby sources.
4. Cross-check candidate movement or variability with external catalogues and the original FITS data.
5. For any scientific claim, perform independent astrometric/photometric analysis and report uncertainty and provenance.

## Sources

- [NASA/IPAC IRSA SPHEREx](https://irsa.ipac.caltech.edu/Missions/spherex.html)
- [IRSA SPHEREx tutorials](https://caltech-ipac.github.io/irsa-tutorials/spherex/)
- [NASA Space Apps Challenge: Planet X and SPHEREx](https://www.spaceappschallenge.org/2026/challenges/planet-x-and-spherex/)
