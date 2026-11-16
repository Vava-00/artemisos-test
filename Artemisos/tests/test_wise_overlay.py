import ast, io, math, sys
import numpy as np
from PIL import Image

src = open(__import__('pathlib').Path(__file__).resolve().parent.parent / 'api.py').read()
tree = ast.parse(src)
want = {'_bilinear_sample', '_resample_to_grid', '_sampled_to_png'}
consts = {'WISE_OVERLAY_MAX_PX', 'WISE_OVERLAY_MAX_OVERSAMPLE'}
body = [n for n in tree.body if (isinstance(n, ast.FunctionDef) and n.name in want)
        or (isinstance(n, ast.Assign) and getattr(n.targets[0], 'id', '') in consts)]
class ZScaleInterval:
    def get_limits(self, v): return float(np.percentile(v, 5)), float(np.percentile(v, 99.5))
ns = {'np': np, 'Image': Image, 'io': io, 'ZScaleInterval': ZScaleInterval}
exec(compile(ast.Module(body=body, type_ignores=[]), 'api_slice', 'exec'), ns)

# Synthetic sky: flat coords in degrees around (0,0). Source at (+0.004, -0.003).
src_x, src_y = 0.004, -0.003
nx = ny = 23; scale_s = 6.15/3600; th = math.radians(30)   # SPHEREx: rotated 30 deg
def spx_pix2world(px, py):
    dx, dy = (px - (nx-1)/2)*scale_s, (py - (ny-1)/2)*scale_s
    return dx*math.cos(th) - dy*math.sin(th), dx*math.sin(th) + dy*math.cos(th)
scale_w = 1.375/3600; wn = 200       # WISE: north-up
def wise_world2pix(x, y): return x/scale_w + (wn-1)/2, y/scale_w + (wn-1)/2
yy, xx = np.mgrid[0:wn, 0:wn]
wx, wy = wise_world2pix(src_x, src_y)
wise = np.exp(-((xx-wx)**2 + (yy-wy)**2)/(2*3.0**2)) + 0.01*np.random.default_rng(0).normal(size=(wn, wn))

sampled, k = ns['_resample_to_grid'](nx, ny, spx_pix2world, wise_world2pix, wise)
print('oversample', k, 'shape', sampled.shape)
iy, ix = np.unravel_index(np.nanargmax(sampled), sampled.shape)
found = ((ix+0.5)/k-0.5, (iy+0.5)/k-0.5)
# expected SPHEREx pixel of the source: invert rotation
dx = src_x*math.cos(th) + src_y*math.sin(th); dy = -src_x*math.sin(th) + src_y*math.cos(th)
exp = (dx/scale_s + (nx-1)/2, dy/scale_s + (ny-1)/2)
print('peak found (spherex px):', tuple(round(v,2) for v in found), 'expected:', tuple(round(v,2) for v in exp))
assert abs(found[0]-exp[0]) < 0.6 and abs(found[1]-exp[1]) < 0.6, 'misaligned'
png = ns['_sampled_to_png'](sampled)
im = Image.open(io.BytesIO(png)); print('png', im.size, im.mode, 'aspect', im.size[0]/im.size[1])
assert im.size == (nx*k, ny*k)
# footprint outside WISE coverage -> NaN handled
s2, _ = ns['_resample_to_grid'](nx, ny, spx_pix2world, lambda x, y: (x*0+9999, y*0+9999), wise)
assert np.isnan(s2).all()
try: ns['_sampled_to_png'](s2); raise SystemExit('should have raised')
except ValueError as e: print('no-coverage ->', e)
print('ALL OK')
