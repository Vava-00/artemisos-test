"""SPHEREx viewer backend: shared metadata and two rendering modes.

Quick renders IRSA FITS cutouts; Advanced downloads the original, complete
FITS once into a separate on-disk cache, then renders its entire frame.
"""
import csv
import hashlib
import io
import json
import math
import os
import threading
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import matplotlib
matplotlib.use("Agg")
from matplotlib import colormaps
import numpy as np
import requests
from PIL import Image
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.time import Time
from astropy.visualization import ZScaleInterval
from flask import Flask, jsonify, render_template, request, send_file, send_from_directory
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

BASE_DIR = Path(__file__).resolve().parent
TEMPLATE_DIR = BASE_DIR / "templates" if (BASE_DIR / "templates" / "index.html").is_file() else BASE_DIR
app = Flask(__name__, template_folder=str(TEMPLATE_DIR))

SIA_URL = "https://irsa.ipac.caltech.edu/SIA"
# Both sets are uniformly reprocessed: DR1 survey 1-2, QR3 survey 3-4.
COLLECTIONS = ("spherex_dr1", "spherex_qr3")
CACHE_DIR = Path(os.environ.get("SPHEREX_CACHE_DIR", str(BASE_DIR / ".cache" / "spherex")))
CACHE_DIR.mkdir(parents=True, exist_ok=True)
MAX_CUTOUT_BYTES = 80 * 1024 * 1024  # avoid accidentally downloading original large FITS
MAX_CACHE_BYTES = 512 * 1024 * 1024
MAX_CACHE_FILES = 2500
# Advanced-mode originals are streamed to disk, never collected into RAM.
# Tune these environment variables for disk space and available bandwidth.
FULL_CACHE_DIR = CACHE_DIR / "full"
FULL_CACHE_DIR.mkdir(parents=True, exist_ok=True)
MAX_FULL_BYTES = int(os.environ.get("SPHEREX_MAX_FULL_FITS_MB", "2048")) * 1024 * 1024
MAX_FULL_CACHE_BYTES = int(os.environ.get("SPHEREX_FULL_CACHE_MB", "8192")) * 1024 * 1024
MAX_FULL_PIXELS = 150_000_000
METADATA_TTL = 15 * 60
metadata_cache = {}
metadata_lock = threading.Lock()
file_locks = {}
file_locks_guard = threading.Lock()

session = requests.Session()
# HTTP 429/5xx can be transient. At most three attempts (initial + two retries)
# with exponential backoff and jitter. Only read-only GET requests are retried.
retry = Retry(total=2, connect=2, read=1, status=2, other=0,
              backoff_factor=1.25, backoff_max=8, backoff_jitter=0.25,
              status_forcelist=[429, 500, 502, 503, 504],
              allowed_methods=frozenset(["GET"]),
              respect_retry_after_header=True, retry_after_max=30,
              raise_on_status=False)
session.mount("https://", HTTPAdapter(max_retries=retry, pool_connections=12, pool_maxsize=12))
session.headers.update({"User-Agent": "Artemisos-SPHEREx-Sky-Viewer/2.1 (NASA IRSA)"})

# Remote outages are intermittent. Technical details are logged server-side
# and never exposed directly in user-facing messages.
IRSA_UNAVAILABLE_MESSAGE = (
    "NASA/IPAC (IRSA) is temporarily unavailable. "
    "Artemisos retried the request and checked DR1 and QR3 separately. "
    "Please try your search again in a few minutes."
)


class CatalogUnavailable(RuntimeError):
    """Neither IRSA catalog collection could be retrieved."""


def clasificar_banda(em_min):
    """Use IRSA wavelength metadata in meters (or microns) to infer detector."""
    try:
        val = float(em_min)
        if not math.isfinite(val):
            return None
        micras = val * 1e6 if val < 0.01 else val
    except (ValueError, TypeError):
        return None
    for band, low, high in ((1, 0.70, 1.10), (2, 1.10, 1.62),
                            (3, 1.62, 2.40), (4, 2.40, 3.78),
                            (5, 3.78, 4.41), (6, 4.41, 5.10)):
        if low <= micras < high or (band == 6 and micras == high):
            return f"Band {band}"
    return None


def mjd_a_fecha(value):
    try:
        mjd = float(value)
        if not math.isfinite(mjd):
            raise ValueError("Non-finite date")
        return Time(mjd, format="mjd", scale="utc").iso[:19] + " UTC", mjd
    except (ValueError, TypeError):
        return "Unknown date", 0.0


def frontend_file(filename):
    for folder in (BASE_DIR / "static", BASE_DIR):
        if (folder / filename).is_file():
            return send_from_directory(folder, filename)
    return "Public asset not found", 404


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/app.js")
def public_javascript():
    return frontend_file("app.js")


@app.route("/styles.css")
def public_stylesheet():
    return frontend_file("styles.css")


@app.route("/spectrum.js")
def public_spectrum_javascript():
    return frontend_file("spectrum.js")


@app.route("/cube_spectrum.js")
def public_cube_spectrum_javascript():
    return frontend_file("cube_spectrum.js")


@app.route("/assets/<path:filename>")
def public_asset(filename):
    for folder in (BASE_DIR / "static" / "assets", BASE_DIR / "assets"):
        if (folder / filename).is_file():
            return send_from_directory(folder, filename)
    return "Asset not found", 404


@app.route("/api/resolver")
def resolver_nombre():
    nombre = request.args.get("nombre", "").strip()
    if not nombre:
        return jsonify({"status": "error", "mensaje": "Enter an astronomical object name."}), 400
    try:
        coord = SkyCoord.from_name(nombre)
        return jsonify({"status": "ok", "nombre": nombre,
                        "ra": round(coord.ra.deg, 5), "dec": round(coord.dec.deg, 5)})
    except Exception:
        return jsonify({"status": "error", "mensaje": f"Object '{nombre}' could not be found."}), 404


def es_url_irsa(fits_url):
    """Allow only HTTPS FITS from IRSA's on-prem SPHEREx archive (no SSRF)."""
    try:
        parsed = urlsplit(fits_url)
        return (parsed.scheme == "https" and parsed.hostname == "irsa.ipac.caltech.edu"
                and parsed.username is None and parsed.password is None
                and parsed.port in (None, 443)
                and parsed.path.startswith("/ibe/data/spherex/")
                and parsed.path.lower().endswith((".fits", ".fits.gz")))
    except ValueError:
        return False


def _query_sia_csv(collections, ra, dec, radius):
    """Request one or more collections and validate the CSV response.

    requests/urllib3 handles retries before reporting a failure. Empty,
    HTML or malformed CSV responses are treated as errors.
    """
    params = [("COLLECTION", collection) for collection in collections] + [
        ("POS", f"circle {ra} {dec} {radius}"), ("RESPONSEFORMAT", "CSV")]
    response = session.get(SIA_URL, params=params, timeout=(8, 30))
    response.raise_for_status()
    raw = response.text.lstrip("\ufeff").strip()
    if not raw or raw.startswith("<"):
        raise RuntimeError("IRSA returned an empty response or HTML instead of CSV.")
    try:
        reader = csv.DictReader(io.StringIO(raw))
        if not reader.fieldnames or not ({"access_url", "acref"} & set(reader.fieldnames)):
            raise RuntimeError("The IRSA catalog returned a CSV file without observation columns.")
        return list(reader)
    except csv.Error as exc:
        raise RuntimeError("IRSA returned a CSV file that could not be parsed.") from exc


def _get_metadata(ra, dec, radius):
    """Try DR1 + QR3 together, then each collection individually if needed.

    Partial results are returned only when at least one collection responds.
    The `partial` flag prevents presenting an incomplete catalog as complete.
    """
    fallback = False
    partial = False
    recovered = list(COLLECTIONS)
    try:
        rows = _query_sia_csv(COLLECTIONS, ra, dec, radius)
    except (requests.RequestException, RuntimeError) as exc:
        fallback = True
        app.logger.warning("Combined IRSA catalog request failed: %s; querying collections separately", exc)
        rows, recovered = [], []
        for collection in COLLECTIONS:
            try:
                rows.extend(_query_sia_csv((collection,), ra, dec, radius))
                recovered.append(collection)
            except (requests.RequestException, RuntimeError) as sub_exc:
                app.logger.warning("IRSA collection %s also failed: %s", collection, sub_exc)
        if not recovered:
            raise CatalogUnavailable(IRSA_UNAVAILABLE_MESSAGE) from exc
        partial = len(recovered) < len(COLLECTIONS)

    grouped = {}
    seen = set()
    for fila in rows:
        access_url = (fila.get("access_url") or fila.get("acref") or "").strip()
        if not es_url_irsa(access_url) or access_url in seen:
            continue  # non-on-prem/cloud URLs cannot use fast IRSA cutouts
        band = clasificar_banda(fila.get("em_min") or fila.get("wavelength_min"))
        if not band:
            continue
        seen.add(access_url)
        fecha, mjd = mjd_a_fecha(fila.get("t_min"))
        grouped.setdefault(band, []).append({
            "obs_id": (fila.get("obs_id") or "N/A").strip(),
            "s_ra": fila.get("s_ra") or ra,
            "s_dec": fila.get("s_dec") or dec,
            "fecha": fecha, "mjd": mjd, "access_url": access_url,
        })

    for items in grouped.values():
        items.sort(key=lambda item: item["mjd"])

    notice = ""
    if partial:
        missing = [c.upper() for c in COLLECTIONS if c not in recovered]
        notice = ("Notice: IRSA did not respond for " + ", ".join(missing)
                  + ". These results are partial; some observations may be missing.")
    elif fallback:
        notice = ("The combined IRSA request failed, but Artemisos recovered "
                  "DR1 and QR3 separately.")

    return {"status": "ok", "total_encontrados": sum(map(len, grouped.values())),
            "bandas_carrusel": dict(sorted(grouped.items())),
            "colecciones": recovered, "fallback": fallback,
            "partial": partial, "aviso": notice}


@app.route("/api/buscar")
def buscar_spherex():
    try:
        ra = float(request.args.get("ra", 133.7951))
        dec = float(request.args.get("dec", -7.2451))
        radio = float(request.args.get("radio", 0.02))
    except (TypeError, ValueError):
        return jsonify({"status": "error", "mensaje": "RA, DEC and radius must be numeric."}), 400
    if not (math.isfinite(ra) and 0 <= ra <= 360
            and math.isfinite(dec) and -90 <= dec <= 90
            and math.isfinite(radio) and 0.001 <= radio <= 0.5):
        return jsonify({"status": "error", "mensaje": "RA must be 0–360, DEC −90–90 and radius 0.001–0.5 degrees."}), 400
    key = (round(ra, 5), round(dec, 5), round(radio, 4))
    now = time.monotonic()
    with metadata_lock:
        cached = metadata_cache.get(key)
        if cached and now - cached[0] < METADATA_TTL:
            return jsonify(cached[1])
    try:
        result = _get_metadata(ra, dec, radio)
    except (requests.RequestException, RuntimeError) as exc:
        app.logger.warning("IRSA catalog request failed after retries: %s", exc)
        return jsonify({"status": "error", "mensaje": IRSA_UNAVAILABLE_MESSAGE,
                        "retryable": True}), 503
    # Do not cache partial results as complete for 15 minutes; a future
    # search may recover the missing collection.
    if not result.get("partial"):
        with metadata_lock:
            if len(metadata_cache) >= 64:
                metadata_cache.clear()
            metadata_cache[key] = (time.monotonic(), result)
    return jsonify(result)


def _get_file_lock(key):
    with file_locks_guard:
        return file_locks.setdefault(key, threading.Lock())


def _spherex_cutout_url(fits_url, ra, dec, radius):
    """IRSA: ?center=RA,DEC&size=diameter_deg; return cutout, not full FITS."""
    parsed = urlsplit(fits_url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update({"center": f"{ra:.6f},{dec:.6f}",
                  "size": f"{2 * radius:.5f}", "gzip": "false"})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                       urlencode(query), ""))


def _spherex_full_url(fits_url):
    """Remove cutout-only arguments if the archive provided any."""
    parsed = urlsplit(fits_url)
    query = [(key, val) for key, val in parse_qsl(parsed.query, keep_blank_values=True)
             if key.lower() not in ("center", "size", "gzip")]
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path,
                       urlencode(query), ""))


def _download_full_fits(fits_url, destination):
    """Download an entire original FITS safely with bounded disk usage."""
    temp = destination.with_name(f"{destination.name}.{threading.get_ident()}.tmp")
    try:
        with session.get(fits_url, stream=True, timeout=(15, 180),
                         allow_redirects=False) as response:
            if 300 <= response.status_code < 400:
                raise ValueError("IRSA redirected the full FITS request.")
            response.raise_for_status()
            declared = response.headers.get("Content-Length")
            if declared and int(declared) > MAX_FULL_BYTES:
                raise ValueError("The full FITS exceeds the configured download size limit.")
            size = 0
            with temp.open("wb") as handle:
                for chunk in response.iter_content(chunk_size=1024 * 1024):
                    if not chunk:
                        continue
                    size += len(chunk)
                    if size > MAX_FULL_BYTES:
                        raise ValueError("The full FITS exceeds the configured download size limit.")
                    handle.write(chunk)
            if size == 0:
                raise ValueError("IRSA returned an empty FITS file.")
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def _download_cutout(url):
    chunks, size = [], 0
    with session.get(url, stream=True, timeout=(10, 75), allow_redirects=False) as response:
        if 300 <= response.status_code < 400:
            raise ValueError("IRSA redirect not allowed.")
        response.raise_for_status()
        for chunk in response.iter_content(chunk_size=256 * 1024):
            if chunk:
                size += len(chunk)
                if size > MAX_CUTOUT_BYTES:
                    raise ValueError("FITS cutout is too large for processing.")
                chunks.append(chunk)
    return b"".join(chunks)


def _fits_to_png(source, full=False):
    """Render a FITS preview (full-frame in advanced mode; cutout in quick mode).

    When full=True, source is a disk Path and pixel data is decimated BEFORE
    converting to float32, preventing multi-gigabyte thumbnails in memory.
    """
    source = source if full else io.BytesIO(source)
    with fits.open(source, memmap=full, lazy_load_hdus=True,
                   do_not_scale_image_data=full) as hdus:
        hdu = next((h for h in hdus if h.is_image and h.data is not None and h.data.ndim == 2), None)
        if hdu is None:
            raise ValueError("The FITS does not contain a two-dimensional image.")
        data = hdu.data
        if full:
            if data.size > MAX_FULL_PIXELS:
                raise ValueError("This FITS contains too many pixels to generate a preview.")
            stride = max(1, math.ceil(max(data.shape) / 1024))
            data = data[::stride, ::stride]
        elif data.size > 12_000_000:
            raise ValueError("This FITS cutout is too large for processing.")
        pixels = np.asarray(data, dtype=np.float32)
        valid = np.isfinite(pixels)
        if not valid.any():
            raise ValueError("The exposure contains no valid pixels.")
        pixels = np.where(valid, pixels, 0.0)
        low, high = ZScaleInterval().get_limits(pixels[valid])
        scale = max(float(high - low), 1e-12)
        normalized = np.clip((pixels - low) / scale, 0, 1)
        normalized[~valid] = 0
        rgb = colormaps["inferno"](np.flipud(normalized), bytes=True)[..., :3]
        image = Image.fromarray(np.ascontiguousarray(rgb), "RGB")
        image.thumbnail((768, 768), Image.Resampling.LANCZOS)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG", optimize=False)
        return buffer.getvalue()


def _trim_full_cache(protect=None):
    """Keep advanced-mode FITS originals bounded independently of PNG cache."""
    files = sorted((p for p in FULL_CACHE_DIR.iterdir() if p.is_file()
                    and p.name.endswith((".fits", ".fits.gz"))),
                   key=lambda p: p.stat().st_mtime)
    total = sum(p.stat().st_size for p in files)
    for old in files:
        if total <= MAX_FULL_CACHE_BYTES:
            break
        if old == protect:
            continue
        try:
            size = old.stat().st_size
            old.unlink()
            total -= size
        except (FileNotFoundError, PermissionError):
            pass


def _trim_disk_cache():
    files = sorted(CACHE_DIR.glob("*.png"), key=lambda p: p.stat().st_mtime)
    total_bytes = sum(p.stat().st_size for p in files)
    while files and (len(files) > MAX_CACHE_FILES or total_bytes > MAX_CACHE_BYTES):
        oldest = files.pop(0)
        try:
            total_bytes -= oldest.stat().st_size
            oldest.unlink()
        except FileNotFoundError:
            pass


@app.route("/api/preview")
def preview_fits():
    fits_url = request.args.get("url", "").strip()
    if not es_url_irsa(fits_url):
        return "A valid IRSA SPHEREx FITS URL is required.", 400
    mode = request.args.get("mode", "quick").strip().lower()
    if mode not in ("quick", "advanced"):
        return "The view mode must be quick or advanced.", 400

    if mode == "quick":
        try:
            ra = float(request.args["ra"])
            dec = float(request.args["dec"])
            radius = float(request.args["radio"])
            if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec)
                    and -90 <= dec <= 90 and math.isfinite(radius)
                    and 0.001 <= radius <= 0.5):
                raise ValueError("Out of range")
        except (KeyError, ValueError):
            return "Valid RA, DEC and radius are required for a FITS cutout.", 400
        image_url = _spherex_cutout_url(fits_url, ra, dec, radius)
    else:
        image_url = _spherex_full_url(fits_url)

    digest = hashlib.sha256(f"{mode}:{image_url}".encode("utf-8")).hexdigest()
    path = CACHE_DIR / (digest + ".png")
    try:
        with _get_file_lock(digest):
            if not path.is_file():
                if mode == "quick":
                    png = _fits_to_png(_download_cutout(image_url))
                else:
                    full_digest = hashlib.sha256(image_url.encode("utf-8")).hexdigest()
                    suffix = ".fits.gz" if urlsplit(image_url).path.lower().endswith(".fits.gz") else ".fits"
                    original = FULL_CACHE_DIR / (full_digest + suffix)
                    with _get_file_lock("full:" + full_digest):
                        if not original.is_file():
                            _download_full_fits(image_url, original)
                        original.touch()
                    png = _fits_to_png(original, full=True)
                    _trim_full_cache(protect=original)
                temp = CACHE_DIR / f"{digest}.{threading.get_ident()}.tmp"
                try:
                    temp.write_bytes(png)
                    os.replace(temp, path)
                finally:
                    temp.unlink(missing_ok=True)
            path.touch()
        result = send_file(path, mimetype="image/png", conditional=True)
        result.headers["Cache-Control"] = "public, max-age=604800"
        result.headers["X-SPHEREx-Mode"] = mode
        if digest.endswith("0"):
            _trim_disk_cache()
        return result
    except (requests.RequestException, OSError, ValueError, TypeError) as exc:
        app.logger.warning("Could not render FITS preview (%s): %s", mode, exc)
        return "The sky image could not be prepared right now. Please try again later.", 502


# ---------------------------------------------------------------------------
# Optional spectrum add-on (adapted from the teammates' app.py).
# Does not change /api/buscar or /api/preview. Measurements always use a
# small FITS cutout around the selected sky position in BOTH viewer modes.
# The browser sends one request at a time only after "Generate spectrum".
# ---------------------------------------------------------------------------
# A fixed, target-centered 0.08-degree cutout provides enough pixels for
# the local background ring, regardless of the catalog search radius.
# Avoid downloading huge cutouts for a user-selected 0.5-degree search.
SPECTRUM_RADIUS_DEG = 0.04
SPECTRUM_CACHE_DIR = CACHE_DIR / "spectrum"
SPECTRUM_CACHE_DIR.mkdir(parents=True, exist_ok=True)
SPECTRUM_METHOD = "aperture-3x3-local-bkg-flags-v2"
SPECTRUM_APERTURE_R = 1.5
SPECTRUM_BKG_IN, SPECTRUM_BKG_OUT = 6, 12


def _finite_or_none(number):
    try:
        value = float(number)
        return value if math.isfinite(value) else None
    except (ValueError, TypeError, OverflowError):
        return None


def _spectrum_measure_fits(fits_bytes, ra, dec):
    """One target-centered pixel measurement from the SPHEREx WCS-W extension.

    Like the original teammates' approach, this is exploratory aperture
    photometry (not a calibrated object spectrum or point-source flux).
    The pixel values are treated as MJy/sr only if FITS BUNIT agrees or is
    absent; arbitrary alternate units must not be mislabeled.
    """
    from astropy import units as u
    from astropy.wcs import WCS

    target = SkyCoord(ra, dec, unit="deg", frame="icrs")
    with fits.open(io.BytesIO(fits_bytes), memmap=False) as hdus:
        try:
            hdu = hdus["IMAGE"]
        except (KeyError, IndexError):
            hdu = next((h for h in hdus if h.data is not None and getattr(h.data, "ndim", 0) == 2), None)
        if hdu is None or hdu.data is None or hdu.data.ndim != 2:
            raise ValueError("The FITS does not contain a measurable two-dimensional image.")
        data = hdu.data
        header = hdu.header
        unit = str(header.get("BUNIT", "MJy/sr")).lower().replace(" ", "")
        if unit not in ("mjy/sr", "mjysr-1", "mjysr**-1"):
            raise ValueError("FITS units are not compatible with MJy/sr: " + unit[:32])

        x, y = WCS(header).world_to_pixel(target)
        x, y = float(x), float(y)
        if not (math.isfinite(x) and math.isfinite(y) and
                -0.5 <= x < data.shape[1] - 0.5 and
                -0.5 <= y < data.shape[0] - 0.5):
            raise ValueError("The target is outside the FITS cutout.")

        # Pixel-specific wavelength. Do not substitute the band's midpoint:
        # that would silently turn the chart into an invented spectrum.
        lam, width = None, None
        try:
            spectral = WCS(header, fobj=hdus, key="W")
            spectral.sip = None
            coords = spectral.pixel_to_world(x, y)
            wave = coords[0] if isinstance(coords, (tuple, list)) else coords
            lam = _finite_or_none(wave.to(u.um).value)
            if isinstance(coords, (tuple, list)) and len(coords) >= 2:
                width = _finite_or_none(coords[1].to(u.um).value)
            if lam is not None and not (0.5 <= lam <= 6.0):
                lam = None
            if width is not None:
                width = abs(width)
        except Exception as exc:
            app.logger.debug("SPHEREx WCS-W unavailable: %s", exc)

        # Work only on a 25x25 neighborhood, not the entire image. The ring
        # (6..12 pixels) estimates the local background and its uncertainty.
        ix, iy = int(round(x)), int(round(y))
        left, right = max(0, ix - 13), min(data.shape[1], ix + 14)
        bottom, top = max(0, iy - 13), min(data.shape[0], iy + 14)
        patch = np.asarray(data[bottom:top, left:right], dtype=np.float64)
        yy, xx = np.mgrid[bottom:top, left:right]
        dist = np.hypot(xx - x, yy - y)
        finite = np.isfinite(patch)
        aperture = (dist <= SPECTRUM_APERTURE_R) & finite
        background = (dist >= SPECTRUM_BKG_IN) & (dist <= SPECTRUM_BKG_OUT) & finite
        n = int(aperture.sum())
        if n == 0 or background.sum() < 12:
            raise ValueError("Not enough valid pixels for the aperture and background measurement.")
        baseline = float(np.median(patch[background]))
        flux = float(np.mean(patch[aperture]) - baseline)
        sd = float(np.std(patch[background]))
        sigma_bkg = 1.2533 * sd / math.sqrt(int(background.sum()))
        sigma_ap = sd / math.sqrt(n)
        try:
            variance_hdu = hdus["VARIANCE"]
            if variance_hdu.data is not None and variance_hdu.data.shape == data.shape:
                variance = np.asarray(variance_hdu.data[bottom:top, left:right], dtype=np.float64)
                values = variance[aperture]
                if values.size == n and np.isfinite(values).all() and (values >= 0).all():
                    sigma_ap = math.sqrt(float(values.sum())) / n
        except (KeyError, IndexError):
            pass
        # Track pixel-quality information, but do not silently discard a source.
        # The frontend can filter flagged observations and preserves the raw flags in CSV.
        flag_value, flagged_pixels = None, None
        if "FLAGS" in hdus:
            quality = hdus["FLAGS"].data
            if quality is not None and quality.shape == data.shape:
                flag_patch = np.asarray(quality[bottom:top,left:right], dtype=np.int64)
                ap_flags = flag_patch[aperture]
                flag_value = int(np.bitwise_or.reduce(ap_flags)) if ap_flags.size else 0
                flagged_pixels = int(np.count_nonzero(ap_flags))
        uncertainty = math.hypot(sigma_ap, sigma_bkg)
        return {"flags": flag_value, "flagged_pixels": flagged_pixels,
                "lam": lam, "width": width, "flux": _finite_or_none(flux),
                "err": _finite_or_none(uncertainty), "bkg": _finite_or_none(baseline),
                "unit": "MJy/sr", "method": SPECTRUM_METHOD}


def _spectrum_point(access_url, ra, dec, radius):
    """Reuses independently cached radiometry across searches/modes/restarts."""
    cutout = _spherex_cutout_url(access_url, ra, dec, SPECTRUM_RADIUS_DEG)
    digest = hashlib.sha256(
        f"{SPECTRUM_METHOD}:{cutout}".encode("utf-8")
    ).hexdigest()
    meta = SPECTRUM_CACHE_DIR / (digest + ".json")
    with _get_file_lock("spectrum:" + digest):
        if meta.is_file():
            try:
                return json.loads(meta.read_text("utf-8"))
            except (ValueError, OSError):
                meta.unlink(missing_ok=True)
        data = _spectrum_measure_fits(_download_cutout(cutout), ra, dec)
        temp = SPECTRUM_CACHE_DIR / f"{digest}.{threading.get_ident()}.tmp"
        try:
            temp.write_text(json.dumps(data, allow_nan=False), encoding="utf-8")
            os.replace(temp, meta)
        finally:
            temp.unlink(missing_ok=True)
        return data


@app.get("/api/spectrum/cube")
def cube_spectrum():
    """Independent DR1 mosaic spectrum. Never blocks the image catalog route."""
    from cube_spectrum import CubeUnavailable, extract_cube, validate_position
    try:
        ra, dec = validate_position(request.args.get("ra"), request.args.get("dec"))
    except ValueError as exc:
        return jsonify({"status": "error", "mensaje": str(exc)}), 400
    try:
        return jsonify(extract_cube(ra, dec, CACHE_DIR))
    except CubeUnavailable as exc:
        app.logger.warning("Cube spectrum unavailable: %s", exc)
        return jsonify({"status": "error", "mensaje": str(exc), "code": exc.code}), 503
    except Exception:
        app.logger.exception("Unexpected cube extraction error")
        return jsonify({"status": "error", "mensaje": "The spectral cube is temporarily unavailable."}), 503


@app.post("/api/spectrum/point")
def spectrum_point():
    """Opt-in per-exposure measurement; errors do not interrupt the viewer."""
    payload = request.get_json(silent=True) or {}
    url = str(payload.get("access_url", "")).strip()
    if not es_url_irsa(url):
        return jsonify({"status": "error", "mensaje": "Invalid IRSA SPHEREx FITS URL."}), 400
    try:
        ra = float(payload["ra"])
        dec = float(payload["dec"])
        radius = float(payload["radius"])
    except (KeyError, TypeError, ValueError):
        return jsonify({"status": "error", "mensaje": "Invalid RA, DEC or radius."}), 400
    if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec)
            and -90 <= dec <= 90 and math.isfinite(radius)
            and 0.001 <= radius <= 0.5):
        return jsonify({"status": "error", "mensaje": "Coordinates or radius are outside the allowed range."}), 400
    try:
        point = _spectrum_point(url, ra, dec, radius)
        return jsonify({"status": "ok", **point})
    except (requests.RequestException, OSError, ValueError, TypeError) as exc:
        app.logger.warning("Spectrum point unavailable: %s", exc)
        return jsonify({"status": "error", "mensaje": "This spectrum measurement is temporarily unavailable."}), 502
    except Exception as exc:
        # Astropy WCS variants and malformed FITS must not break playback.
        app.logger.exception("Spectrum extraction failed")
        return jsonify({"status": "error", "mensaje": "The FITS spectrum measurement could not be extracted."}), 502


# ---------------------------------------------------------------------------
# Optional detector coadds and click-to-inspect WCS, independent of the viewer.
# ---------------------------------------------------------------------------
@app.post('/api/stack/start')
def stack_start():
    import detector_stack as stack
    payload = request.get_json(silent=True) or {}
    try:
        ra, dec = float(payload['ra']), float(payload['dec'])
        band = int(payload['band'])
        urls = payload['access_urls']
        if not isinstance(urls, list):
            raise ValueError('Expected a list of observation URLs')
        job_id = stack.submit(ra, dec, band, urls, CACHE_DIR, es_url_irsa,
                              _spherex_cutout_url, _download_cutout)
        return jsonify({'status':'ok', 'job_id':job_id})
    except (ValueError, TypeError, KeyError) as exc:
        return jsonify({'status':'error','mensaje':str(exc)}),400
    except RuntimeError as exc:
        return jsonify({'status':'error','mensaje':str(exc)}),409


@app.get('/api/stack/status/<job_id>')
def stack_status(job_id):
    import detector_stack as stack
    info = stack.status(job_id)
    if not info:
        path = stack.image_path(job_id, CACHE_DIR)
        if not path:
            return jsonify({'status':'error','mensaje':'Unknown stack'}),404
        return jsonify({'status':'ready','image_id':job_id,'message':'Cached stack ready'})
    return jsonify(info)


@app.get('/api/stack/image/<job_id>')
def stack_image(job_id):
    import detector_stack as stack
    path = stack.image_path(job_id, CACHE_DIR)
    if path is None:
        return jsonify({'status':'error','mensaje':'Stack not ready'}),404
    return send_file(path, mimetype='image/png', conditional=True)


@app.get('/api/sky-at-pixel')
def sky_at_pixel():
    """Convert normalized coordinates on the rendered PNG back to FITS WCS.

    In the viewer PNG, FITS rows were flipped vertically. The normalized
    content coordinates account for zoom, pan and image letterboxing in JS.
    """
    from astropy.wcs import WCS
    url = request.args.get('url','').strip()
    if not es_url_irsa(url):
        return jsonify({'status':'error','mensaje':'Invalid FITS URL'}),400
    try:
        ra, dec = float(request.args['ra']), float(request.args['dec'])
        radius, sx, sy = float(request.args['radio']), float(request.args['u']), float(request.args['v'])
        mode = request.args.get('mode','quick')
        if not (0<=ra<=360 and -90<=dec<=90 and .001<=radius<=.5 and
                0<=sx<=1 and 0<=sy<=1 and mode in ('quick','advanced')):
            raise ValueError('Invalid viewer coordinates')
    except (KeyError,TypeError,ValueError):
        return jsonify({'status':'error','mensaje':'Invalid viewer coordinates'}),400
    try:
        if mode == 'quick':
            source = io.BytesIO(_download_cutout(_spherex_cutout_url(url,ra,dec,radius)))
        else:
            full_url=_spherex_full_url(url)
            digest=hashlib.sha256(full_url.encode('utf-8')).hexdigest()
            suffix='.fits.gz' if urlsplit(full_url).path.lower().endswith('.fits.gz') else '.fits'
            source=FULL_CACHE_DIR/(digest+suffix)
            # Never trigger a full FITS download from clicking an image.
            if not source.is_file():
                raise ValueError('Full FITS is no longer cached. Reopen the exposure.')
        with fits.open(source, memmap=(mode=='advanced'), lazy_load_hdus=True) as hdus:
            hdu=next((h for h in hdus if h.is_image and h.data is not None and h.data.ndim==2),None)
            if hdu is None:
                raise ValueError('Missing image WCS')
            nx,ny=hdu.data.shape[1],hdu.data.shape[0]
            x=sx*(nx-1)
            y=(1-sy)*(ny-1)
            sky = WCS(hdu.header).celestial.pixel_to_world(x,y)
            ra_out=float(np.asarray(sky.ra.deg).item())
            dec_out=float(np.asarray(sky.dec.deg).item())
            if not (math.isfinite(ra_out) and math.isfinite(dec_out)):
                raise ValueError('Invalid WCS solution')
        return jsonify({'status':'ok','ra':ra_out,'dec':dec_out})
    except Exception as exc:
        app.logger.warning('Pixel-to-sky conversion unavailable: %s',exc)
        return jsonify({'status':'error','mensaje':'Could not locate this pixel in the FITS WCS.'}),502


# WISE comparison add-on (AllWISE Atlas images from IRSA).
# Independent of the SPHEREx catalog: it never changes /api/buscar,
# /api/preview or the spectrum endpoints. The browser calls it only after a
# SPHEREx search has resolved a sky position AND "Compare with WISE" is on.
# ---------------------------------------------------------------------------
WISE_COLLECTION = "wise_allwise"
# Detector bands by central wavelength (um): W1 3.4, W2 4.6, W3 12, W4 22.
WISE_BANDS = ((1, 2.5, 4.0), (2, 4.0, 8.0), (3, 8.0, 17.0), (4, 17.0, 40.0))
WISE_LABELS = {1: "3.4 µm", 2: "4.6 µm", 3: "12 µm", 4: "22 µm"}
WISE_SKIP_PARTS = ("-unc-", "-cov-", "-msk", "-std-", "-mask")


@app.route("/wise.js")
def public_wise_javascript():
    return frontend_file("wise.js")


@app.route("/wise.css")
def public_wise_stylesheet():
    return frontend_file("wise.css")


def es_url_wise(fits_url):
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
    for fila in rows:
        url = (fila.get("access_url") or fila.get("acref") or "").strip()
        if not es_url_wise(url) or any(p in url.lower() for p in WISE_SKIP_PARTS):
            continue
        subtype = (fila.get("dataproduct_subtype") or "").strip().lower()
        if subtype and subtype != "science":
            continue
        band = _wise_band(fila)
        if not band:
            continue
        try:
            separation = target.separation(SkyCoord(
                float(fila["s_ra"]), float(fila["s_dec"]), unit="deg")).deg
        except (KeyError, TypeError, ValueError):
            separation = 999.0
        if band not in best or separation < best[band][0]:
            best[band] = (separation, {
                "band": band, "label": WISE_LABELS[band],
                "obs_id": (fila.get("obs_id") or "N/A").strip(),
                "access_url": url})
    bands = {str(b): item for b, (_, item) in sorted(best.items())}
    return {"status": "ok", "bands": bands, "total": len(bands)}


@app.route("/api/wise/buscar")
def buscar_wise():
    try:
        ra = float(request.args["ra"])
        dec = float(request.args["dec"])
        radio = float(request.args.get("radio", 0.02))
    except (KeyError, TypeError, ValueError):
        return jsonify({"status": "error", "mensaje": "RA, DEC and radius must be numeric."}), 400
    if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec)
            and -90 <= dec <= 90 and math.isfinite(radio) and 0.001 <= radio <= 0.5):
        return jsonify({"status": "error", "mensaje": "Coordinates or radius are outside the allowed range."}), 400
    key = ("wise", round(ra, 5), round(dec, 5), round(radio, 4))
    with metadata_lock:
        cached = metadata_cache.get(key)
        if cached and time.monotonic() - cached[0] < METADATA_TTL:
            return jsonify(cached[1])
    try:
        result = _get_wise_metadata(ra, dec, radio)
    except (requests.RequestException, RuntimeError) as exc:
        app.logger.warning("WISE catalog request failed: %s", exc)
        return jsonify({"status": "error", "retryable": True,
                        "mensaje": "WISE data from NASA/IPAC (IRSA) is temporarily unavailable. "
                                   "SPHEREx images are not affected. Please try again later."}), 503
    with metadata_lock:
        if len(metadata_cache) >= 64:
            metadata_cache.clear()
        metadata_cache[key] = (time.monotonic(), result)
    return jsonify(result)


@app.route("/api/wise/preview")
def preview_wise():
    fits_url = request.args.get("url", "").strip()
    if not es_url_wise(fits_url):
        return "A valid IRSA WISE FITS URL is required.", 400
    try:
        ra = float(request.args["ra"])
        dec = float(request.args["dec"])
        radius = float(request.args["radio"])
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


# ---------------------------------------------------------------------------
# WISE overlay: the WISE cutout is re-sampled onto the pixel grid of the
# SPHEREx cutout that is on screen, using BOTH FITS WCS solutions. The result
# therefore lines up with the SPHEREx image even when the detector frame is
# rotated or offset relative to the (north-up) WISE atlas tile.
# Only used in Quick mode, where the viewer shows the same cutout we fetch.
# ---------------------------------------------------------------------------
WISE_CUTOUT_DIR = CACHE_DIR / "wise"
WISE_CUTOUT_DIR.mkdir(parents=True, exist_ok=True)
MAX_WISE_CUTOUTS = 400
WISE_OVERLAY_MAX_PX = 768
WISE_OVERLAY_MAX_OVERSAMPLE = 8
# Extra WISE margin so a rotated SPHEREx footprint is still fully covered.
WISE_FOOTPRINT_MARGIN = 1.6
WISE_OVERLAY_VERSION = "v1"


def _bilinear_sample(data, x, y):
    """Bilinear interpolation of data[y, x] (0-based pixels); NaN outside."""
    height, width = data.shape
    finite = np.isfinite(x) & np.isfinite(y)
    x = np.where(finite, x, -10.0)
    y = np.where(finite, y, -10.0)
    x0 = np.floor(x).astype(np.int64)
    y0 = np.floor(y).astype(np.int64)
    inside = (x0 >= 0) & (x0 < width - 1) & (y0 >= 0) & (y0 < height - 1)
    x0c = np.clip(x0, 0, width - 2)
    y0c = np.clip(y0, 0, height - 2)
    fx = np.clip(x - x0c, 0.0, 1.0)
    fy = np.clip(y - y0c, 0.0, 1.0)
    out = (data[y0c, x0c] * (1 - fx) * (1 - fy) + data[y0c, x0c + 1] * fx * (1 - fy)
           + data[y0c + 1, x0c] * (1 - fx) * fy + data[y0c + 1, x0c + 1] * fx * fy)
    return np.where(inside, out, np.nan)


def _resample_to_grid(nx, ny, spherex_pix2world, wise_world2pix, wise_data):
    """Sample the WISE image at the centers of an oversampled SPHEREx grid.

    Returns (array, oversample). Row 0 is detector row 0, like the viewer's
    own array before it flips the image vertically for display.
    """
    k = int(max(1, min(WISE_OVERLAY_MAX_OVERSAMPLE, WISE_OVERLAY_MAX_PX // max(nx, ny))))
    xs = (np.arange(nx * k) + 0.5) / k - 0.5
    ys = (np.arange(ny * k) + 0.5) / k - 0.5
    gx, gy = np.meshgrid(xs, ys)
    ra_grid, dec_grid = spherex_pix2world(gx, gy)
    wx, wy = wise_world2pix(ra_grid, dec_grid)
    return _bilinear_sample(wise_data, np.asarray(wx), np.asarray(wy)), k


def _sampled_to_png(sampled):
    """Cyan-tinted PNG (black = no data) meant for 'screen' blending over inferno."""
    valid = np.isfinite(sampled)
    if not valid.any():
        raise ValueError("WISE does not cover this SPHEREx field.")
    low, high = ZScaleInterval().get_limits(sampled[valid])
    scale = max(float(high - low), 1e-12)
    norm = np.clip((np.where(valid, sampled, low) - low) / scale, 0, 1)
    norm[~valid] = 0
    norm = np.flipud(norm)  # same vertical flip as _fits_to_png
    rgb = np.stack([norm * 0.25, norm * 0.85, norm], axis=-1)
    image = Image.fromarray((rgb * 255).astype(np.uint8), "RGB")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG", optimize=False)
    return buffer.getvalue()


def _first_image_hdu(hdus):
    try:
        return hdus["IMAGE"]
    except (KeyError, IndexError):
        return next((h for h in hdus if h.is_image and h.data is not None
                     and getattr(h.data, "ndim", 0) == 2), None)


def _wise_overlay_png(spherex_bytes, wise_bytes):
    from astropy.wcs import WCS

    with fits.open(io.BytesIO(spherex_bytes), memmap=False) as hdus:
        hdu = _first_image_hdu(hdus)
        if hdu is None or hdu.data is None or hdu.data.ndim != 2:
            raise ValueError("The SPHEREx cutout has no two-dimensional image.")
        ny, nx = hdu.data.shape
        spherex_wcs = WCS(hdu.header).celestial
    with fits.open(io.BytesIO(wise_bytes), memmap=False) as hdus:
        hdu = _first_image_hdu(hdus)
        if hdu is None or hdu.data is None or hdu.data.ndim != 2:
            raise ValueError("The WISE cutout has no two-dimensional image.")
        wise_data = np.asarray(hdu.data, dtype=np.float64)
        wise_wcs = WCS(hdu.header).celestial
    sampled, _ = _resample_to_grid(
        nx, ny,
        lambda px, py: spherex_wcs.all_pix2world(px, py, 0),
        lambda ra, dec: wise_wcs.all_world2pix(ra, dec, 0),
        wise_data)
    return _sampled_to_png(sampled)


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


@app.route("/api/wise/overlay")
def overlay_wise():
    wise_url = request.args.get("wise", "").strip()
    spherex_url = request.args.get("spherex", "").strip()
    if not es_url_wise(wise_url) or not es_url_irsa(spherex_url):
        return "Valid IRSA WISE and SPHEREx FITS URLs are required.", 400
    try:
        ra = float(request.args["ra"])
        dec = float(request.args["dec"])
        radius = float(request.args["radio"])
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



if __name__ == "__main__":
    app.run(debug=True, port=5000, threaded=True)
