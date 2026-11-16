"""Backend mode tests without installing Flask/Astropy; network responses are fake.
Run: python -m unittest discover -s tests -p 'test_backend_modes.py'
"""
import ast
import hashlib
import io
import math
import os
from pathlib import Path
import tempfile
import threading
import unittest
from types import SimpleNamespace
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

import numpy as np
from PIL import Image
from matplotlib import colormaps
import requests

root = Path(__file__).resolve().parents[1]
source = root / 'api.py'
tree = ast.parse(source.read_text())
names = {
    'es_url_irsa', '_spherex_full_url', '_spherex_cutout_url', '_get_file_lock',
    '_download_full_fits', '_fits_to_png', 'preview_fits',
}
funcs = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in names:
        node.decorator_list = []  # Flask route decorators are tested via direct calls.
        funcs.append(node)
module = ast.fix_missing_locations(ast.Module(body=funcs, type_ignores=[]))
ns = dict(
    hashlib=hashlib, io=io, math=math, os=os, Path=Path, threading=threading,
    urlsplit=urlsplit, parse_qsl=parse_qsl, urlencode=urlencode, urlunsplit=urlunsplit,
    np=np, Image=Image, colormaps=colormaps, requests=requests,
    ZScaleInterval=lambda: SimpleNamespace(get_limits=lambda data: (float(data.min()), float(data.max()))),
    MAX_FULL_BYTES=1024, MAX_FULL_PIXELS=100_000,
    file_locks_guard=threading.Lock(), file_locks={},
)
exec(compile(module, str(source), 'exec'), ns)

URL = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/level2/test.fits?center=10,20&size=0.1&token=good'

class HDU:
    is_image = True
    data = np.arange(10000, dtype=np.float32).reshape(100, 100)

class FakeFITS:
    def __enter__(self):
        return [HDU()]
    def __exit__(self, *_):
        return None

class FitsModesTests(unittest.TestCase):
    def test_urls_for_both_modes(self):
        full = ns['_spherex_full_url'](URL)
        quick = ns['_spherex_cutout_url'](URL, 10., 20., .02)
        self.assertEqual(dict(parse_qsl(urlsplit(full).query)), {'token': 'good'})
        self.assertEqual(dict(parse_qsl(urlsplit(quick).query))['size'], '0.04000')
        self.assertEqual(dict(parse_qsl(urlsplit(quick).query))['center'], '10.000000,20.000000')
        self.assertTrue(ns['es_url_irsa'](URL))
        self.assertFalse(ns['es_url_irsa']('https://other.example/file.fits'))

    def test_full_render_reads_path_and_quick_reads_buffer(self):
        opened = []
        def openfits(source, **opts):
            opened.append((source, opts))
            return FakeFITS()
        ns['fits'] = SimpleNamespace(open=openfits)
        self.assertTrue(ns['_fits_to_png'](Path('/fake/original.fits'), full=True).startswith(b'\x89PNG'))
        self.assertTrue(opened[-1][1]['memmap'])
        self.assertTrue(opened[-1][1]['do_not_scale_image_data'])
        self.assertTrue(ns['_fits_to_png'](b'fake cutout', full=False).startswith(b'\x89PNG'))
        self.assertFalse(opened[-1][1]['memmap'])
        self.assertIsInstance(opened[-1][0], io.BytesIO)

    def test_complete_download_is_streamed_and_limited(self):
        class Stream:
            status_code = 200
            headers = {'Content-Length':'6'}
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def raise_for_status(self): pass
            def iter_content(self, chunk_size): yield b'abc'; yield b'def'
        called = []
        ns['session'] = SimpleNamespace(get=lambda url, **kw: (called.append((url, kw)), Stream())[1])
        with tempfile.TemporaryDirectory() as temp:
            file = Path(temp) / 'original.fits'
            ns['_download_full_fits'](URL, file)
            self.assertEqual(file.read_bytes(), b'abcdef')
            self.assertFalse(called[0][1]['allow_redirects'])
            self.assertEqual(called[0][0], URL)
            ns['MAX_FULL_BYTES'] = 5
            with self.assertRaises(ValueError):
                ns['_download_full_fits'](URL, file)
            self.assertEqual(file.read_bytes(), b'abcdef', 'Failure must not replace the cached original')
            self.assertFalse(list(Path(temp).glob('*.tmp')), 'No leftover partial downloads')

    def test_quick_and_advanced_route_have_isolated_caches(self):
        seen = {'quick':0, 'full_download':0, 'full_render':0}
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp); (cache/'full').mkdir()
            ns['CACHE_DIR'] = cache
            ns['FULL_CACHE_DIR'] = cache/'full'
            ns['request'] = SimpleNamespace(args={})
            ns['send_file'] = lambda path, **kw: SimpleNamespace(headers={}, path=Path(path))
            ns['_download_cutout'] = lambda url: seen.__setitem__('quick',seen['quick']+1) or b'CUTOUT'
            def download(url, path):
                seen['full_download'] += 1
                self.assertNotIn('center=',url)
                path.write_bytes(b'FULL FITS')
            ns['_download_full_fits'] = download
            def png(source, full=False):
                if full:
                    seen['full_render'] += 1
                    self.assertEqual(Path(source).read_bytes(), b'FULL FITS')
                else:
                    self.assertEqual(source, b'CUTOUT')
                return b'PNG DATA'
            ns['_fits_to_png'] = png
            ns['_trim_full_cache'] = lambda protect=None: None
            ns['_trim_disk_cache'] = lambda: None
            args = {'url':URL, 'ra':'10', 'dec':'20', 'radio':'0.02', 'mode':'quick'}
            ns['request'].args = args
            quick = ns['preview_fits']()
            self.assertEqual(quick.headers['X-SPHEREx-Mode'], 'quick')
            args['mode'] = 'advanced'
            advanced = ns['preview_fits']()
            self.assertEqual(advanced.headers['X-SPHEREx-Mode'], 'advanced')
            self.assertNotEqual(advanced.path, quick.path)
            advanced_again = ns['preview_fits']()
            self.assertEqual(advanced_again.path, advanced.path)
            self.assertEqual(seen, {'quick':1, 'full_download':1, 'full_render':1})
            self.assertEqual(len(list((cache/'full').glob('*.fits'))), 1)
            args['mode'] = 'bad'
            self.assertEqual(ns['preview_fits']()[1], 400)

if __name__=='__main__': unittest.main()
