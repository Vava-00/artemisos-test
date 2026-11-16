"""Offline DR1 HiPS cube checks; no network/Astropy/Flask required."""
import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import cube_spectrum as cube

class FakeSection:
    def __init__(self, arr): self.arr=arr
    def __getitem__(self, key): return self.arr[key]

class FakeHDU:
    def __init__(self, data, header=None):
        self.shape=data.shape
        self.section=FakeSection(data)
        self.header=header or {'BUNIT':'MJy/sr'}

class FakeHDUS:
    def __init__(self):
        pixels=np.ones((102,16,16),dtype=np.float32)*5
        pixels[:,7,6]=np.arange(102,dtype=float) / 3
        pixels[50,7,6]=12345
        hits=np.ones_like(pixels,dtype=np.int32)
        hits[60,7,6]=0
        flags=np.zeros_like(hits)
        flags[22,7,6]=128
        table=np.zeros(102,dtype=[('WAVELENGTH','f8')]);table['WAVELENGTH']=np.linspace(.75,5,102)
        self.data={'IMAGE':FakeHDU(pixels),'NHITS':FakeHDU(hits),'FLAGS':FakeHDU(flags),
                   'SPECTRAL_CHANNELS':types.SimpleNamespace(data=table)}
    def __getitem__(self,key):return self.data[key]
    def __contains__(self,key):return key in self.data

class CubeTests(unittest.TestCase):
    def test_tiles_and_input_validation(self):
        self.assertEqual(cube.tile_url(445).split('/')[-3:],['Norder5','Dir0','Npix445_cube.fits'])
        self.assertEqual(cube.tile_url(10123).split('/')[-3:],['Norder5','Dir10000','Npix10123_cube.fits'])
        self.assertEqual(cube.validate_position(360,-2),(0,-2))
        for ra,dec in ((float('nan'),1),(5,91),(-3,0)):
            with self.assertRaises(ValueError):cube.validate_position(ra,dec)
        with self.assertRaises(ValueError):cube.tile_url(12*32*32)

    def test_cube_extract_pixel_and_blank_channel_mask(self):
        astro=types.ModuleType('astropy')
        astro.units=types.SimpleNamespace(deg=1)
        sky=types.ModuleType('astropy.coordinates');sky.SkyCoord=lambda *a,**kw:object()
        wcs=types.ModuleType('astropy.wcs')
        class W:
            def __init__(self,header,fobj=None):self.celestial=self
            def world_to_pixel(self,coord):return (6.1,6.9)
        wcs.WCS=W
        with patch.dict(sys.modules,{'astropy':astro,'astropy.coordinates':sky,'astropy.wcs':wcs}):
            r=cube.extract_hdul(FakeHDUS(),12,-2,pix=445,url='https://example.com/cube.fits')
        self.assertEqual(r['total_channels'],102)
        self.assertEqual(r['valid_channels'],99)
        self.assertIsNone(r['points'][50]['brightness'])
        self.assertIsNone(r['points'][51]['brightness'])
        self.assertIsNone(r['points'][60]['brightness'])
        self.assertEqual(r['points'][0]['band'],1)
        self.assertEqual(r['points'][101]['band'],6)
        self.assertEqual(r['points'][22]['flags'],128)
        self.assertAlmostEqual(r['points'][22]['brightness'],22/3,places=4)
        self.assertEqual(r['unit'],'MJy/sr')
        self.assertEqual(r['kind'],'mosaic')

    def test_wcs_numpy_array_scalar_coordinates(self):
        """Regression: Astropy may return ndarray([x]), which round() rejects."""
        astro = types.ModuleType('astropy')
        astro.units = types.SimpleNamespace(deg=1)
        sky = types.ModuleType('astropy.coordinates')
        sky.SkyCoord = lambda *args, **kwargs: object()
        wcs = types.ModuleType('astropy.wcs')
        class W:
            def __init__(self, header, fobj=None): self.celestial = self
            def world_to_pixel(self, coord): return np.array([6.1]), np.array([[6.9]])
        wcs.WCS = W
        with patch.dict(sys.modules, {'astropy': astro, 'astropy.coordinates': sky, 'astropy.wcs': wcs}):
            result = cube.extract_hdul(FakeHDUS(), 12, -2, pix=445)
        self.assertEqual(result['valid_channels'], 99)
        self.assertAlmostEqual(result['points'][3]['brightness'], 1.0, places=4)

    def test_rejects_multiple_wcs_positions(self):
        with self.assertRaisesRegex(cube.CubeUnavailable, 'expected one'):
            cube._scalar_pixel(np.array([4., 5.]), 'X')
        with self.assertRaisesRegex(cube.CubeUnavailable, 'Non-finite'):
            cube._scalar_pixel(np.array([np.nan]), 'Y')

    def test_disk_cache_reused_without_second_remote_call(self):
        with tempfile.TemporaryDirectory() as folder:
            calls=[]
            fake={'status':'ok','total_channels':102,'valid_channels':100,
                  'points':[{'channel':i+1,'wavelength_um':1.,'brightness':1.} for i in range(102)]}
            def remote(url,ra,dec,pix):
                calls.append(url);return fake.copy()
            with patch.object(cube,'healpix_tile',return_value=445),patch.object(cube,'_load_remote',side_effect=remote):
                first=cube.extract_cube(10,20,folder)
                second=cube.extract_cube(10,20,folder)
                another=cube.extract_cube(11,20,folder)
            self.assertEqual(len(calls),2)
            self.assertFalse(first['cached'])
            self.assertTrue(second['cached'])
            self.assertEqual(len(list((Path(folder)/'cube102').glob('*.json'))),2)
            self.assertEqual(len(another['points']),102)

    def test_remote_failure_is_explicit_not_fake_data(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(cube,'healpix_tile',return_value=445),patch.object(cube,'_load_remote',side_effect=OSError('502')):
                with self.assertRaises(cube.CubeUnavailable):cube.extract_cube(10,20,folder)
            self.assertEqual(len(list((Path(folder)/'cube102').glob('*.json'))),0)


    def test_irsa_error_tries_public_s3_without_fake_data(self):
        with tempfile.TemporaryDirectory() as folder:
            calls = []
            def remote(url, ra, dec, pix):
                calls.append(url)
                if len(calls) == 1:
                    raise OSError("502 Proxy Error")
                return {"status": "ok", "total_channels": 102,
                        "points": [{"channel": i + 1, "brightness": 2.5} for i in range(102)],
                        "valid_channels": 102}
            with patch.object(cube, 'healpix_tile', return_value=445), \
                 patch.object(cube, '_load_remote', side_effect=remote):
                result = cube.extract_cube(60, 51, folder)
            self.assertEqual(len(calls), 2)
            self.assertIn('/ibe/data/spherex/dr1/', calls[0])
            self.assertIn('nasa-irsa-spherex.s3.', calls[1])
            self.assertEqual(result['access_source'], 'S3')
            self.assertEqual(result['total_channels'], 102)

    def test_outage_explained_and_never_cached_as_spectrum(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(cube,'healpix_tile',return_value=445), \
                 patch.object(cube,'_load_remote',side_effect=OSError('502 Proxy Error')):
                with self.assertRaises(cube.CubeUnavailable) as exc:
                    cube.extract_cube(10,20,folder)
            self.assertEqual(exc.exception.code, 'remote_service_error')
            self.assertIn('not responding', str(exc.exception))
            self.assertEqual(list((Path(folder)/'cube102').glob('*.json')), [])

    def test_missing_dependency_has_actionable_error(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch.object(cube,'healpix_tile',side_effect=ModuleNotFoundError('hpgeom')):
                with self.assertRaises(cube.CubeUnavailable) as exc:
                    cube.extract_cube(10,20,folder)
            self.assertEqual(exc.exception.code, 'missing_dependency')
            self.assertIn('requirements.txt', str(exc.exception))

if __name__=='__main__':unittest.main()
