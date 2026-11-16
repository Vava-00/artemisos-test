"""Pure WCS reprojection and image-rendering helpers for the optional WISE overlay."""
import io
import numpy as np
from PIL import Image
from astropy.io import fits
from astropy.visualization import ZScaleInterval

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


