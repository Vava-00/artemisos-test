"""Optional AllWISE Atlas catalog, previews and SPHEREx-aligned overlay.

Dependency injection into a Flask Blueprint keeps the primary SPHEREx API unchanged.
WISE is fetched only on user request and shares the bounded IRSA download/cache helpers.
"""
import hashlib
import math
import os
import threading
import time
from urllib.parse import urlsplit

import numpy as np
import requests
from astropy.coordinates import SkyCoord
from flask import Blueprint, request, jsonify, send_file

import wise_alignment

def create_wise_blueprint(core):
    """Register the optional routes against the existing Flask application."""
    app = core.app
    CACHE_DIR = core.CACHE_DIR
    metadata_cache = core.metadata_cache
    metadata_lock = core.metadata_lock
    METADATA_TTL = core.METADATA_TTL
    _query_sia_csv = core._query_sia_csv
    _get_file_lock = core._get_file_lock
    _spherex_cutout_url = core._spherex_cutout_url
    _download_cutout = core._download_cutout
    _fits_to_png = core._fits_to_png
    is_trusted_irsa_url = core.is_trusted_irsa_url
    _wise_overlay_png = wise_alignment._wise_overlay_png
    WISE_FOOTPRINT_MARGIN = wise_alignment.WISE_FOOTPRINT_MARGIN
    WISE_OVERLAY_VERSION = wise_alignment.WISE_OVERLAY_VERSION
    bp = Blueprint("wise", __name__, url_prefix="/api/wise")
    WISE_COLLECTION = "wise_allwise"
    # Detector bands by central wavelength (um): W1 3.4, W2 4.6, W3 12, W4 22.
    WISE_BANDS = ((1, 2.5, 4.0), (2, 4.0, 8.0), (3, 8.0, 17.0), (4, 17.0, 40.0))
    WISE_LABELS = {1: "3.4 µm", 2: "4.6 µm", 3: "12 µm", 4: "22 µm"}
    WISE_SKIP_PARTS = ("-unc-", "-cov-", "-msk", "-std-", "-mask")
    # Limited, separate WISE FITS cutout cache; no full-frame WISE downloads.
    WISE_CUTOUT_DIR = CACHE_DIR / "wise"
    WISE_CUTOUT_DIR.mkdir(parents=True, exist_ok=True)
    MAX_WISE_CUTOUTS = 400


    def is_trusted_wise_url(fits_url):
        """Allow only HTTPS FITS from IRSA's WISE archive (no SSRF)."""
        try:
            parsed = urlsplit(fits_url)
            return (parsed.scheme == "https" and parsed.hostname == "irsa.ipac.caltech.edu"
                    and parsed.username is None and parsed.password is None
                    and parsed.port in (None, 443)
                    and parsed.path.startswith("/ibe/data/wise/")
                    and parsed.path.lower().endswith((".fits", ".fits.gz")))
        except ValueError:
            return False


    def _wise_band(row):
        """Classify an AllWISE row into W1-W4 from its wavelength bounds."""
        values = []
        for key in (("em_min", "wavelength_min"), ("em_max", "wavelength_max")):
            for name in key:
                try:
                    val = float(row.get(name))
                except (TypeError, ValueError):
                    continue
                if math.isfinite(val) and val > 0:
                    values.append(val * 1e6 if val < 0.01 else val)
                    break
        if not values:
            return None
        center = sum(values) / len(values)
        for band, low, high in WISE_BANDS:
            if low <= center < high:
                return band
        return None


    def _get_wise_metadata(ra, dec, radius):
        """One best Atlas tile per band: the one whose center is closest to the target."""
        rows = _query_sia_csv((WISE_COLLECTION,), ra, dec, radius)
        target = SkyCoord(ra, dec, unit="deg", frame="icrs")
        best = {}
        for row in rows:
            url = (row.get("access_url") or row.get("acref") or "").strip()
            if not is_trusted_wise_url(url) or any(p in url.lower() for p in WISE_SKIP_PARTS):
                continue
            subtype = (row.get("dataproduct_subtype") or "").strip().lower()
            if subtype and subtype != "science":
                continue
            band = _wise_band(row)
            if not band:
                continue
            try:
                separation = target.separation(SkyCoord(
                    float(row["s_ra"]), float(row["s_dec"]), unit="deg")).deg
            except (KeyError, TypeError, ValueError):
                separation = 999.0
            if band not in best or separation < best[band][0]:
                best[band] = (separation, {
                    "band": band, "label": WISE_LABELS[band],
                    "obs_id": (row.get("obs_id") or "N/A").strip(),
                    "access_url": url})
        bands = {str(b): item for b, (_, item) in sorted(best.items())}
        return {"status": "ok", "bands": bands, "total": len(bands)}


    @bp.get("/search")
    def search_wise():
        try:
            ra = float(request.args["ra"])
            dec = float(request.args["dec"])
            radius = float(request.args.get("radius", 0.02))
        except (KeyError, TypeError, ValueError):
            return jsonify({"status": "error", "message": "RA, DEC and radius must be numeric."}), 400
        if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec)
                and -90 <= dec <= 90 and math.isfinite(radius) and 0.001 <= radius <= 0.5):
            return jsonify({"status": "error", "message": "Coordinates or radius are outside the allowed range."}), 400
        key = ("wise", round(ra, 5), round(dec, 5), round(radius, 4))
        with metadata_lock:
            cached = metadata_cache.get(key)
            if cached and time.monotonic() - cached[0] < METADATA_TTL:
                return jsonify(cached[1])
        try:
            result = _get_wise_metadata(ra, dec, radius)
        except (requests.RequestException, RuntimeError) as exc:
            app.logger.warning("WISE catalog request failed: %s", exc)
            return jsonify({"status": "error", "retryable": True,
                            "message": "WISE data from NASA/IPAC (IRSA) is temporarily unavailable. "
                                       "SPHEREx images are not affected. Please try again later."}), 503
        with metadata_lock:
            if len(metadata_cache) >= 64:
                metadata_cache.clear()
            metadata_cache[key] = (time.monotonic(), result)
        return jsonify(result)


    @bp.get("/preview")
    def preview_wise():
        fits_url = request.args.get("url", "").strip()
        if not is_trusted_wise_url(fits_url):
            return "A valid IRSA WISE FITS URL is required.", 400
        try:
            ra = float(request.args["ra"])
            dec = float(request.args["dec"])
            radius = float(request.args["radius"])
            if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec)
                    and -90 <= dec <= 90 and math.isfinite(radius)
                    and 0.001 <= radius <= 0.5):
                raise ValueError("Out of range")
        except (KeyError, ValueError):
            return "Valid RA, DEC and radius are required for a FITS cutout.", 400
        image_url = _spherex_cutout_url(fits_url, ra, dec, radius)  # generic IBE cutout URL
        digest = hashlib.sha256(f"wise:{image_url}".encode("utf-8")).hexdigest()
        path = CACHE_DIR / (digest + ".png")
        try:
            with _get_file_lock(digest):
                if not path.is_file():
                    png = _fits_to_png(_download_cutout(image_url))
                    temp = CACHE_DIR / f"{digest}.{threading.get_ident()}.tmp"
                    try:
                        temp.write_bytes(png)
                        os.replace(temp, path)
                    finally:
                        temp.unlink(missing_ok=True)
                path.touch()
            result = send_file(path, mimetype="image/png", conditional=True)
            result.headers["Cache-Control"] = "public, max-age=604800"
            return result
        except (requests.RequestException, OSError, ValueError, TypeError) as exc:
            app.logger.warning("Could not render WISE preview: %s", exc)
            return "The WISE image could not be prepared right now. Please try again later.", 502


    def _trim_wise_cutouts():
        files = sorted(WISE_CUTOUT_DIR.glob("*.fits"), key=lambda p: p.stat().st_mtime)
        for old in files[:max(0, len(files) - MAX_WISE_CUTOUTS)]:
            old.unlink(missing_ok=True)


    def _wise_cutout_bytes(url, digest):
        """WISE cutouts are small and reused by every SPHEREx epoch: cache them."""
        path = WISE_CUTOUT_DIR / (digest + ".fits")
        with _get_file_lock("wisecut:" + digest):
            if path.is_file():
                path.touch()
                return path.read_bytes()
            data = _download_cutout(url)
            temp = WISE_CUTOUT_DIR / f"{digest}.{threading.get_ident()}.tmp"
            try:
                temp.write_bytes(data)
                os.replace(temp, path)
            finally:
                temp.unlink(missing_ok=True)
            _trim_wise_cutouts()
            return data


    @bp.get("/overlay")
    def overlay_wise():
        wise_url = request.args.get("wise", "").strip()
        spherex_url = request.args.get("spherex", "").strip()
        if not is_trusted_wise_url(wise_url) or not is_trusted_irsa_url(spherex_url):
            return "Valid IRSA WISE and SPHEREx FITS URLs are required.", 400
        try:
            ra = float(request.args["ra"])
            dec = float(request.args["dec"])
            radius = float(request.args["radius"])
            if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec)
                    and -90 <= dec <= 90 and math.isfinite(radius)
                    and 0.001 <= radius <= 0.5):
                raise ValueError("Out of range")
        except (KeyError, ValueError):
            return "Valid RA, DEC and radius are required for the overlay.", 400
        spherex_cut = _spherex_cutout_url(spherex_url, ra, dec, radius)  # same as /api/preview
        wise_cut = _spherex_cutout_url(wise_url, ra, dec, radius * WISE_FOOTPRINT_MARGIN)
        digest = hashlib.sha256(
            f"wiseoverlay:{WISE_OVERLAY_VERSION}:{spherex_cut}:{wise_cut}".encode("utf-8")).hexdigest()
        wise_digest = hashlib.sha256(f"wisecut:{wise_cut}".encode("utf-8")).hexdigest()
        path = CACHE_DIR / (digest + ".png")
        try:
            with _get_file_lock(digest):
                if not path.is_file():
                    png = _wise_overlay_png(_download_cutout(spherex_cut),
                                            _wise_cutout_bytes(wise_cut, wise_digest))
                    temp = CACHE_DIR / f"{digest}.{threading.get_ident()}.tmp"
                    try:
                        temp.write_bytes(png)
                        os.replace(temp, path)
                    finally:
                        temp.unlink(missing_ok=True)
                path.touch()
            result = send_file(path, mimetype="image/png", conditional=True)
            result.headers["Cache-Control"] = "public, max-age=604800"
            return result
        except (requests.RequestException, OSError, ValueError, TypeError) as exc:
            app.logger.warning("Could not build WISE overlay: %s", exc)
            return "The WISE overlay could not be prepared right now. Please try again later.", 502
        except Exception:
            # Malformed WCS or astropy convergence problems must not break the viewer.
            app.logger.exception("WISE overlay failed")
            return "The WISE overlay could not be aligned for this observation.", 502




    return bp
