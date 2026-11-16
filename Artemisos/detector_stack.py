"""Optional WCS-aligned per-detector quick-look stack.

Each exposure in a selected SPHEREx detector band is reprojected onto the SAME
TAN sky grid before contributing to a quality-masked inverse-variance mean.
Important: a band spans multiple wavelengths, so this is a broad-band exploratory
visualization, NOT a scientific narrow-band coadd or calibrated flux.
"""
import hashlib
import io
import json
import math
import os
import threading
import uuid
from pathlib import Path

import numpy as np
from astropy.coordinates import SkyCoord
from astropy.io import fits
from astropy.wcs import WCS
from astropy import units as u
from scipy.ndimage import map_coordinates
from PIL import Image
from matplotlib import colormaps
from astropy.visualization import ZScaleInterval

GRID_SIZE = 96
FIELD_DEG = 0.08
# One job at a time prevents this optional feature from saturating IRSA.
_JOB_LOCK = threading.Lock()
_JOBS = {}
_ACTIVE = None


def common_grid(ra, dec, n=GRID_SIZE, field=FIELD_DEG):
    """Target-centered tangent plane grid, same coordinates for every frame."""
    w = WCS(naxis=2)
    w.wcs.crpix = [(n + 1) / 2, (n + 1) / 2]
    w.wcs.crval = [ra, dec]
    w.wcs.cdelt = [-field / n, field / n]
    w.wcs.ctype = ['RA---TAN', 'DEC--TAN']
    yy, xx = np.indices((n, n))
    return w.pixel_to_world(xx, yy)


def reproject_frame(hdus, sky):
    """Return aligned science values and inverse-variance weights, reject flagged pixels."""
    hdu = hdus['IMAGE'] if 'IMAGE' in hdus else next(
        (h for h in hdus if h.data is not None and getattr(h.data, 'ndim', 0) == 2), None)
    if hdu is None or hdu.data is None or hdu.data.ndim != 2:
        raise ValueError('No 2D image')
    bunit = str(hdu.header.get('BUNIT', 'MJy/sr')).lower().replace(' ', '')
    if bunit not in ('mjy/sr', 'mjysr-1', 'mjysr**-1'):
        raise ValueError('Incompatible units')
    data = np.asarray(hdu.data, dtype=np.float32)
    xin, yin = WCS(hdu.header).celestial.world_to_pixel(sky)
    coords = [yin, xin]
    inside = ((xin >= 0.5) & (xin < data.shape[1] - 1.5) &
              (yin >= 0.5) & (yin < data.shape[0] - 1.5))
    pixel = map_coordinates(data, coords, order=1, mode='constant', cval=np.nan)
    good = inside & np.isfinite(pixel)
    if 'FLAGS' in hdus and hdus['FLAGS'].data is not None:
        flags = hdus['FLAGS'].data
        if flags.shape == data.shape:
            mapped_flags = map_coordinates(np.asarray(flags, dtype=np.float32), coords,
                                            order=0, mode='constant', cval=1)
            good &= (mapped_flags == 0)
    weights = np.ones(pixel.shape, dtype=np.float64)
    if 'VARIANCE' in hdus and hdus['VARIANCE'].data is not None:
        var = hdus['VARIANCE'].data
        if var.shape == data.shape:
            mapped = map_coordinates(np.asarray(var, dtype=np.float32), coords,
                                    order=1, mode='constant', cval=np.nan)
            good &= np.isfinite(mapped) & (mapped > 0)
            np.divide(1.0, mapped, out=weights, where=(np.isfinite(mapped) & (mapped > 0)))
            weights = np.clip(weights, 0, 1e10)
    weights[~good] = 0
    pixel[~good] = 0
    return pixel, weights, good


def build_stack(ra, dec, urls, get_cutout_bytes, dest, on_progress=None, cancelled=lambda: False):
    """Stream all input images one at a time. No arbitrary exposure subsampling."""
    sky = common_grid(ra, dec)
    n = GRID_SIZE
    numerator = np.zeros((n, n), dtype=np.float64)
    denominator = np.zeros((n, n), dtype=np.float64)
    counts = np.zeros((n, n), dtype=np.uint32)
    ok = bad = 0
    for index, url in enumerate(urls):
        if cancelled():
            raise RuntimeError('Stack cancelled')
        try:
            raw = get_cutout_bytes(url, ra, dec)
            with fits.open(io.BytesIO(raw), memmap=False) as hdus:
                val, weight, valid = reproject_frame(hdus, sky)
            if np.any(valid):
                numerator += val * weight
                denominator += weight
                counts += valid.astype(np.uint32)
                ok += 1
            else:
                bad += 1
        except Exception:
            bad += 1
        if on_progress:
            on_progress(index + 1, len(urls), ok, bad)
    output = np.full((n, n), np.nan, dtype=np.float32)
    np.divide(numerator, denominator, out=output, where=denominator > 0)
    finite = np.isfinite(output)
    if not finite.any():
        raise RuntimeError('No valid overlapping pixels after WCS alignment')
    low, high = ZScaleInterval().get_limits(output[finite])
    contrast = max(float(high - low), 1e-9)
    scale = np.clip((np.nan_to_num(output, nan=low) - low) / contrast, 0, 1)
    rgb = colormaps['inferno'](np.flipud(scale), bytes=True)[..., :3]
    image = Image.fromarray(np.ascontiguousarray(rgb), 'RGB').resize((576, 576), Image.Resampling.NEAREST)
    temp = dest.with_name(dest.stem + '.tmp.png')
    try:
        image.save(temp)
        os.replace(temp, dest)
    finally:
        temp.unlink(missing_ok=True)
    return {'total': len(urls), 'included': ok, 'failed': bad,
            'center_pixel_contributors': int(counts[n//2, n//2]),
            'field_deg': FIELD_DEG, 'grid_size': n,
            'note': 'WCS-aligned inverse-variance image mean within one detector; wavelengths may differ.'}


def submit(ra, dec, band, urls, cache_dir, is_url, cutout_url, download):
    """Start a single optional stack job; reuse a completed stack across searches."""
    global _ACTIVE
    if not (math.isfinite(ra) and 0 <= ra <= 360 and math.isfinite(dec) and -90 <= dec <= 90):
        raise ValueError('Invalid coordinates')
    if band not in range(1, 7) or not urls or not all(isinstance(url, str) and is_url(url) for url in urls):
        raise ValueError('Invalid band or FITS URLs')
    if len(urls) != len(set(urls)):
        urls = list(dict.fromkeys(urls))
    directory = Path(cache_dir) / 'stacks'
    directory.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(json.dumps([round(ra,6), round(dec,6), band, sorted(urls), FIELD_DEG]).encode()).hexdigest()[:32]
    output = directory / (digest + '.png')
    with _JOB_LOCK:
        if output.is_file():
            _JOBS[digest] = {'status':'ready','done':len(urls),'total':len(urls),
                             'message':'Cached stack available','image_id':digest}
            return digest
        if _ACTIVE and _JOBS.get(_ACTIVE,{}).get('status') == 'running' and _ACTIVE != digest:
            raise RuntimeError('A detector stack is already running. Try again after it finishes.')
        if _JOBS.get(digest,{}).get('status') == 'running':
            return digest
        _ACTIVE = digest
        _JOBS[digest] = {'status':'running','done':0,'total':len(urls), 'message':'Preparing WCS grid'}
    def work():
        global _ACTIVE
        def progress(done, total, ok, bad):
            with _JOB_LOCK:
                _JOBS[digest].update(done=done,total=total,included=ok,failed=bad)
        def get_cutout(url, x, y):
            return download(cutout_url(url, x, y, FIELD_DEG / 2))
        try:
            details = build_stack(ra, dec, urls, get_cutout, output, on_progress=progress)
            with _JOB_LOCK:
                _JOBS[digest].update(status='ready',image_id=digest,message='WCS-aligned stack ready',**details)
        except Exception:
            with _JOB_LOCK:
                _JOBS[digest].update(status='failed',message='Could not build the stack; check IRSA access and FITS WCS.')
        finally:
            with _JOB_LOCK:
                if _ACTIVE == digest: _ACTIVE = None
    threading.Thread(target=work, daemon=True, name='detector-stack').start()
    return digest


def status(job_id):
    with _JOB_LOCK:
        return dict(_JOBS.get(job_id, {}))


def image_path(job_id, cache_dir):
    if len(job_id)!=32 or any(c not in '0123456789abcdef' for c in job_id):
        return None
    path=Path(cache_dir)/'stacks'/(job_id+'.png')
    return path if path.is_file() else None
