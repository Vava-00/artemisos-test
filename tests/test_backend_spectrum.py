"""No Flask or Astropy installation needed; test spectrum extraction with mocked WCS."""
import ast
import hashlib
import io
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import threading
import types
import unittest
from unittest.mock import patch
import numpy as np

root=Path(__file__).resolve().parents[1]
source=root/'main.py'
tree=ast.parse(source.read_text())
functions={'_finite_or_none','_spectrum_measure_fits','_spectrum_point','spectrum_point'}
nodes=[]
for n in tree.body:
    if isinstance(n,ast.FunctionDef) and n.name in functions:
        n.decorator_list=[]
        nodes.append(n)
code=compile(ast.fix_missing_locations(ast.Module(body=nodes,type_ignores=[])),str(source),'exec')

class Quantity:
    def __init__(self,value): self.value=value
    def to(self,unit): return self

class WCS:
    missing=False
    def __init__(self,header,fobj=None,key=None):
        if key == 'W' and self.missing: raise ValueError('WCS-W missing')
        self.key=key
        self.sip=None
    def world_to_pixel(self,coord): return (25.,25.)
    def pixel_to_world(self,x,y): return (Quantity(2.42),Quantity(.03))

class HDU:
    def __init__(self,data,unit='MJy/sr'):
        self.data=data
        self.header={'BUNIT':unit}
class HDUS:
    def __init__(self,data):
        self.item={'IMAGE':HDU(data),'VARIANCE':HDU(np.ones(data.shape)*.04)}
    def __enter__(self): return self
    def __exit__(self,*_): return False
    def __getitem__(self,key): return self.item[key]

class BackendSpectrumTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.calls=[]
        yy,xx=np.mgrid[0:51,0:51]
        data=10+35*np.exp(-.5*((xx-25)**2+(yy-25)**2)/2.0)
        self.hdus=HDUS(data)
        self.ns={
            'io':io,'json':json,'math':math,'os':os,'np':np,
            'hashlib':hashlib,'threading':threading,'SkyCoord':lambda *a,**kw: a,
            'fits':types.SimpleNamespace(open=lambda *a,**kw:self.hdus),
            'app':types.SimpleNamespace(logger=types.SimpleNamespace(debug=lambda *a:None,warning=lambda *a:None,exception=lambda *a:None)),
            'SPECTRUM_RADIUS_DEG':.04,'SPECTRUM_APERTURE_R':1.5,'SPECTRUM_BKG_IN':6,'SPECTRUM_BKG_OUT':12,
            'SPECTRUM_METHOD':'aperture-3x3-local-bkg-v1',
            'SPECTRUM_CACHE_DIR':Path(self.tmp.name),
            '_get_file_lock':lambda key:threading.Lock(),
            '_spherex_cutout_url':lambda url,ra,dec,rad:f'{url}?center={ra},{dec}&size={rad}',
            '_download_cutout':lambda url:(self.calls.append(url),b'fake-FITS')[1],
            'is_trusted_irsa_url':lambda url:url.startswith('https://irsa.ipac.caltech.edu/ibe/data/spherex/') and url.endswith('.fits'),
            'jsonify':lambda data:data,
            'requests':types.SimpleNamespace(RequestException=OSError)
        }
        exec(code,self.ns)

    def fake_astropy_modules(self):
        a=types.ModuleType('astropy'); a.units=types.SimpleNamespace(um=object())
        w=types.ModuleType('astropy.wcs'); w.WCS=WCS
        return patch.dict(sys.modules,{'astropy':a,'astropy.wcs':w})

    def test_aperture_and_pixel_wavelength(self):
        with self.fake_astropy_modules():
            result=self.ns['_spectrum_measure_fits'](b'fits',12,-2)
        self.assertAlmostEqual(result['lam'],2.42)
        self.assertAlmostEqual(result['width'],.03)
        self.assertGreater(result['flux'],1)
        self.assertGreater(result['err'],0)
        self.assertEqual(result['unit'],'MJy/sr')

    def test_missing_wcs_wave_never_fabricates_a_point(self):
        WCS.missing=True
        try:
            with self.fake_astropy_modules():
                result=self.ns['_spectrum_measure_fits'](b'fits',12,-2)
            self.assertIsNone(result['lam'])
            self.assertGreater(result['flux'],0)
        finally:
            WCS.missing=False

    def test_disk_cache_separate_from_images_and_modes(self):
        url='https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/a.fits'
        with self.fake_astropy_modules():
            a=self.ns['_spectrum_point'](url,12,-2,.02)
            b=self.ns['_spectrum_point'](url,12,-2,.02)
            c=self.ns['_spectrum_point'](url,13,-2,.02)
        self.assertEqual(a,b)
        self.assertEqual(len(self.calls),2)
        self.assertEqual(len(list(Path(self.tmp.name).glob('*.json'))),2)
        self.assertTrue(math.isfinite(c['flux']))

    def test_route_accepts_trusted_metadata_without_changing_preview(self):
        url='https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/a.fits'
        self.ns['request']=types.SimpleNamespace(get_json=lambda silent=True:{
            'access_url':url, 'ra':12, 'dec':-2, 'radius':.02})
        self.ns['_spectrum_point']=lambda *args:{'lam':2.42,'flux':3.5,'err':.1}
        result=self.ns['spectrum_point']()
        self.assertEqual(result['status'],'ok')
        self.assertEqual(result['lam'],2.42)
        self.assertEqual(result['flux'],3.5)

    def test_route_rejects_untrusted_url(self):
        self.ns['request']=types.SimpleNamespace(get_json=lambda silent=True:{
            'access_url':'https://evil.example/secret.fits', 'ra':12, 'dec':-2, 'radius':.02})
        result=self.ns['spectrum_point']()
        self.assertEqual(result[1],400)
        self.assertEqual(result[0]['status'],'error')

if __name__=='__main__': unittest.main()
