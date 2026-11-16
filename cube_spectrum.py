"""DR1 HiPS all-sky cube: one quick-look 102-channel pixel spectrum.

The official IRSA HiPS notebook provides the order-5 NESTED tile layout:
https://caltech-ipac.github.io/irsa-tutorials/spherex-hipscube/

Unlike the per-exposure spectrum, this is a DR1 mosaic over multiple epochs.
Remote FITS sections avoid transferring a ~300 MB cube if IRSA supports HTTP Range.
The result is a *pixel surface-brightness visualization*, not calibrated source photometry.
"""
from __future__ import annotations

import hashlib
import json
import logging
import math
import os
import threading
from pathlib import Path

import numpy as np

LOGGER = logging.getLogger(__name__)
CUBE_ROOT = os.environ.get(
    "SPHEREX_CUBE_ROOT",
    "https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/hips5_cube/hips_20261026",
).rstrip("/")
ORDER = 5
NSIDE = 1 << ORDER
# Official public AWS bucket documented by IRSA (no credentials needed over HTTPS).
# The S3 origin is a fallback; a missing cube there will not block the image viewer.
S3_CUBE_ROOT = os.environ.get(
    "SPHEREX_CUBE_S3_ROOT",
    "https://nasa-irsa-spherex.s3.us-east-1.amazonaws.com/dr1/hips5_cube/hips_20261026",
).rstrip("/")
VERSION = "dr1-hips-20261026-pixel-v2"
_LOCK = threading.RLock()
_LOCKS: dict[str, threading.Lock] = {}


class CubeUnavailable(RuntimeError):
    """A tile could not be read. `code` helps the interface display a useful warning."""

    def __init__(self, message, *, code="cube_unavailable"):
        super().__init__(message)
        self.code = code


def validate_position(ra, dec):
    """Reject invalid input before any costly remote request."""
    try:
        ra, dec = float(ra), float(dec)
    except (ValueError, TypeError) as exc:
        raise ValueError("RA and DEC must be numeric degrees.") from exc
    if not (math.isfinite(ra) and math.isfinite(dec) and 0 <= ra <= 360 and -90 <= dec <= 90):
        raise ValueError("RA must be 0–360° and DEC must be −90–90°.")
    return ra % 360, dec


def healpix_tile(ra, dec):
    """Resolve HiPS order-5 NESTED tile without using the unstable SIA endpoint."""
    import hpgeom as hp
    return int(hp.angle_to_pixel(NSIDE, ra, dec, nest=True, lonlat=True))


def tile_url(pix, root=None):
    if not isinstance(pix, int) or not (0 <= pix < 12 * NSIDE * NSIDE):
        raise ValueError("Invalid HEALPix tile")
    directory = (pix // 10000) * 10000
    return f"{root or CUBE_ROOT}/Norder{ORDER}/Dir{directory}/Npix{pix}_cube.fits"


def cube_sources(pix):
    """Same real DR1 tile via IBE then AWS public S3 (if distinct)."""
    urls = [tile_url(pix)]
    if S3_CUBE_ROOT and S3_CUBE_ROOT != CUBE_ROOT:
        urls.append(tile_url(pix, root=S3_CUBE_ROOT))
    return urls


def _failure_kind(exc):
    """Classify a technical failure without displaying raw internal exceptions."""
    msg = str(exc).lower()
    if isinstance(exc, (ModuleNotFoundError, ImportError)):
        return "missing_dependency"
    if any(x in msg for x in ("404", "not found", "nosuchkey")):
        return "cube_not_found"
    if any(x in msg for x in ("403", "accessdenied", "forbidden")):
        return "access_denied"
    if any(x in msg for x in ("502", "503", "504", "timeout", "timed out", "connection", "dns", "resolve")):
        return "remote_service_error"
    if any(x in msg for x in ("range", "partial", "seek", "blocksize", "requested bytes")):
        return "range_not_supported"
    if isinstance(exc, CubeUnavailable) and ("WCS" in str(exc) or "pixel coordinate" in str(exc)):
        return "invalid_fits"
    if isinstance(exc, (ValueError, KeyError, IndexError, TypeError)):
        return "invalid_fits"
    return "cube_unavailable"


def _message_for(kind):
    messages = {
        "missing_dependency": "The cube reader is missing a Python dependency. Reinstall requirements.txt and restart Flask.",
        "cube_not_found": "The DR1 tile could not be found at the official data sources. Try another sky position or Retry later.",
        "access_denied": "The public cube data sources denied this download. Their permissions may be temporarily unavailable.",
        "remote_service_error": "The cube data sources are not responding. Retry later; sky images and epoch measurements still work.",
        "range_not_supported": "The cube server did not allow partial FITS reads (HTTP Range). A full-tile download can be enabled explicitly.",
        "invalid_fits": "The cube was retrieved but its FITS structure or coordinates could not be read. See the Python console.",
    }
    return messages.get(kind, "The DR1 cube could not be read. See the Python console for details, then Retry.")


def _number(value):
    try:
        result = float(value)
    except (ValueError, TypeError):
        return None
    return result if math.isfinite(result) else None


def _scalar_pixel(value, axis):
    """Normalize an Astropy WCS pixel coordinate to one real Python float.

    Depending on Astropy/WCS versions, world_to_pixel can return a scalar,
    a 0-D ndarray or a 1-element ndarray. Python's round() cannot operate
    on an ndarray, even when it contains exactly one value.
    """
    try:
        arr = np.asarray(value, dtype=float)
    except (TypeError, ValueError) as exc:
        raise CubeUnavailable(f"Invalid WCS {axis} pixel coordinate.") from exc
    if arr.size != 1:
        raise CubeUnavailable(
            f"WCS returned {arr.size} {axis} coordinates for one sky position "
            f"(array shape {arr.shape}); expected one."
        )
    scalar = float(arr.item())
    if not math.isfinite(scalar):
        raise CubeUnavailable(f"Non-finite WCS {axis} pixel coordinate.")
    return scalar


def extract_hdul(hdul, ra, dec, pix=None, url=None):
    """Read one sky pixel in 102 planes; crucially use .section, not .data.

    Keeping this separate from network I/O allows deterministic FITS tests.
    """
    from astropy.coordinates import SkyCoord
    from astropy.wcs import WCS
    from astropy import units as u

    image = hdul["IMAGE"]
    shape = image.shape
    if len(shape) != 3 or shape[0] != 102:
        raise CubeUnavailable(f"Unexpected SPHEREx cube shape: {shape}")
    # FITS table axes contain WAVE-TAB, so include fobj=hdul.
    celestial = WCS(image.header, fobj=hdul).celestial
    x_raw, y_raw = celestial.world_to_pixel(SkyCoord(ra * u.deg, dec * u.deg, frame="icrs"))
    x = _scalar_pixel(x_raw, "X")
    y = _scalar_pixel(y_raw, "Y")
    ix, iy = int(round(x)), int(round(y))
    if not (0 <= ix < shape[2] and 0 <= iy < shape[1]):
        raise CubeUnavailable("The position falls outside its HiPS cube tile.")

    channels = hdul["SPECTRAL_CHANNELS"].data
    wavelengths = np.asarray(channels["WAVELENGTH"], dtype=float).reshape(-1)
    if len(wavelengths) != 102:
        raise CubeUnavailable("SPECTRAL_CHANNELS must describe 102 channels.")
    # A single 102-value column: avoid reading the entire 512x512x102 cube.
    brightness = np.asarray(image.section[:, iy, ix], dtype=float).reshape(-1)
    hits_hdu = hdul["NHITS"] if "NHITS" in hdul else None
    hits = (np.asarray(hits_hdu.section[:, iy, ix], dtype=np.int64).reshape(-1)
            if hits_hdu is not None else np.full(102, -1, dtype=np.int64))
    flags_hdu = hdul["FLAGS"] if "FLAGS" in hdul else None
    flags = (np.asarray(flags_hdu.section[:, iy, ix], dtype=np.int64).reshape(-1)
             if flags_hdu is not None else np.zeros(102, dtype=np.int64))
    if len(brightness) != 102 or len(hits) != 102 or len(flags) != 102:
        raise CubeUnavailable("The extracted pixel has an unexpected channel count.")

    points = []
    for index in range(102):
        valid = (index not in (50, 51)  # official DR1 dichroic blank channels
                 and np.isfinite(brightness[index])
                 and (hits[index] != 0))
        points.append({
            "channel": index + 1,
            "band": index // 17 + 1,
            "wavelength_um": _number(wavelengths[index]),
            "brightness": _number(brightness[index]) if valid else None,
            "nhits": int(hits[index]) if hits[index] >= 0 else None,
            "flags": int(flags[index]),
        })
    valid_count = sum(p["brightness"] is not None and p["wavelength_um"] is not None for p in points)
    return {
        "status": "ok", "source": "SPHEREx DR1 HiPS all-sky cube", "kind": "mosaic",
        "ra": ra, "dec": dec, "healpix": pix, "order": ORDER,
        "cube_url": url, "unit": image.header.get("BUNIT", "MJy/sr"),
        "points": points, "total_channels": 102, "valid_channels": valid_count,
        "notice": ("Quick-look brightness for a single mosaic pixel, not calibrated source "
                   "photometry or a time-resolved spectrum."),
    }


def _load_remote(url, ra, dec, pix):
    from astropy.io import fits
    # Astropy + fsspec uses HTTP Range requests if IRSA supports them.
    # The lazy .section[] read is significantly smaller than a ~300 MB FITS.
    with fits.open(url, use_fsspec=True, lazy_load_hdus=True,
                   fsspec_kwargs={"block_size": 2 * 1024 * 1024}) as hdul:
        return extract_hdul(hdul, ra, dec, pix=pix, url=url)


def _download_complete(url, destination):
    """Opt-in fallback when the hosting server does not honor range reads."""
    import requests
    limit = 450 * 1024 * 1024
    temp = destination.with_name(destination.name + f".{threading.get_ident()}.tmp")
    try:
        with requests.get(url, stream=True, timeout=(15, 90),
                          headers={"User-Agent": "Artemisos-SPHEREx/2.2"}) as response:
            response.raise_for_status()
            length = int(response.headers.get("Content-Length", "0") or 0)
            if length > limit:
                raise CubeUnavailable("The spectral cube is too large to cache safely.")
            total = 0
            with open(temp, "wb") as fd:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if chunk:
                        total += len(chunk)
                        if total > limit:
                            raise CubeUnavailable("The cube exceeds the configured size limit.")
                        fd.write(chunk)
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def extract_cube(ra, dec, cache_dir):
    ra, dec = validate_position(ra, dec)
    cache_dir = Path(cache_dir) / "cube102"
    cache_dir.mkdir(parents=True, exist_ok=True)
    try:
        pix = healpix_tile(ra, dec)
    except (ImportError, ModuleNotFoundError) as exc:
        LOGGER.exception("Cube reader is missing hpgeom")
        raise CubeUnavailable(_message_for("missing_dependency"), code="missing_dependency") from exc

    urls = cube_sources(pix)
    cache_key = hashlib.sha256(f"{VERSION}:{pix}:{ra:.6f}:{dec:.6f}".encode()).hexdigest()
    result_file = cache_dir / f"{cache_key}.json"
    with _LOCK:
        lock = _LOCKS.setdefault(cache_key, threading.Lock())
    with lock:
        if result_file.is_file():
            try:
                result = json.loads(result_file.read_text(encoding="utf-8"))
                if result.get("total_channels") == 102 and len(result.get("points", [])) == 102:
                    result["cached"] = True
                    return result
            except (ValueError, OSError):
                result_file.unlink(missing_ok=True)

        full_path = cache_dir / f"Npix{pix}_cube.fits"
        result = None
        failures = []
        if full_path.is_file():
            try:
                from astropy.io import fits
                with fits.open(full_path, memmap=True) as hdul:
                    result = extract_hdul(hdul, ra, dec, pix=pix, url="Local FITS cache")
            except Exception as exc:
                LOGGER.exception("Cached cube FITS is corrupt or unreadable, will retry remote sources: %s", full_path)
                failures.append(exc)
                # Do not destroy a user's locally supplied FITS automatically.

        if result is None:
            for index, url in enumerate(urls):
                try:
                    result = _load_remote(url, ra, dec, pix)
                    result["access_source"] = "IRSA" if index == 0 else "S3"
                    break
                except Exception as exc:
                    failures.append(exc)
                    LOGGER.warning("DR1 cube access failed via %s (HEALPix %d): %s",
                                   "IRSA" if index == 0 else "S3", pix, exc, exc_info=True)
                    # A missing dependency is local, retrying a different host cannot fix it.
                    if isinstance(exc, (ImportError, ModuleNotFoundError)):
                        break

        if result is None and os.environ.get("SPHEREX_CUBE_ALLOW_FULL_DOWNLOAD", "0") == "1":
            for index, url in enumerate(urls):
                try:
                    if not full_path.is_file():
                        _download_complete(url, full_path)
                    from astropy.io import fits
                    with fits.open(full_path, memmap=True) as hdul:
                        result = extract_hdul(hdul, ra, dec, pix=pix, url=url)
                    result["access_source"] = "IRSA full tile" if index == 0 else "S3 full tile"
                    break
                except Exception as exc:
                    failures.append(exc)
                    LOGGER.warning("Full-tile download/read failed from %s: %s", url, exc, exc_info=True)
                    if full_path.is_file() and full_path.stat().st_size == 0:
                        full_path.unlink(missing_ok=True)

        if result is None:
            kinds = [_failure_kind(f) for f in failures]
            if "missing_dependency" in kinds:
                kind = "missing_dependency"
            elif "range_not_supported" in kinds and not any(k == "remote_service_error" for k in kinds):
                kind = "range_not_supported"
            elif "remote_service_error" in kinds:
                kind = "remote_service_error"
            elif "access_denied" in kinds:
                kind = "access_denied"
            elif "cube_not_found" in kinds:
                kind = "cube_not_found"
            elif "invalid_fits" in kinds:
                kind = "invalid_fits"
            else:
                kind = "cube_unavailable"
            LOGGER.error("Cube unavailable after %d attempts for RA=%.6f DEC=%.6f HEALPix=%d; last failure: %r",
                         len(failures), ra, dec, pix, failures[-1] if failures else None)
            raise CubeUnavailable(_message_for(kind), code=kind) from (failures[-1] if failures else None)

        result["cached"] = False
        temp = result_file.with_name(result_file.name + f".{threading.get_ident()}.tmp")
        try:
            temp.write_text(json.dumps(result, allow_nan=False), encoding="utf-8")
            os.replace(temp, result_file)
        finally:
            temp.unlink(missing_ok=True)
        return result
