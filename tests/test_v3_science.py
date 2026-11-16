"""Offline synthetic science tests. Run with `python -m pytest -q` after installing requirements."""
from pathlib import Path
import io
import numpy as np
from unittest import SkipTest

try:
    from astropy.wcs import WCS
    from astropy.io import fits
    import scipy
    import detector_stack as stack
except ImportError as exc:
    raise SkipTest('Synthetic stacking tests require Astropy and SciPy.') from exc


def make_frame(value, ra=10, dec=20, flags=0):
    wcs=WCS(naxis=2)
    wcs.wcs.crpix=[33,33]
    wcs.wcs.cdelt=[-0.08/64,0.08/64]
    wcs.wcs.crval=[ra,dec]
    wcs.wcs.ctype=['RA---TAN','DEC--TAN']
    h=fits.ImageHDU(np.full((64,64), value, dtype=np.float32),header=wcs.to_header(),name='IMAGE')
    h.header['BUNIT']='MJy/sr'
    var=fits.ImageHDU(np.ones((64,64),dtype=np.float32),name='VARIANCE')
    flags_h=fits.ImageHDU(np.full((64,64),flags,dtype=np.int32),name='FLAGS')
    hdus=fits.HDUList([fits.PrimaryHDU(),h,var,flags_h]); buf=io.BytesIO();hdus.writeto(buf)
    return buf.getvalue()


def test_reproject_on_shared_wcs_grid():
    sky=stack.common_grid(10,20)
    with fits.open(io.BytesIO(make_frame(4))) as hdus:
        val,weight,good=stack.reproject_frame(hdus,sky)
    assert good[48,48]
    assert np.isclose(val[48,48],4,atol=1e-3)
    assert weight[48,48]>0


def test_wcs_aligned_stack_all_frames_and_quality_mask(tmp_path):
    images={'a':make_frame(4),'b':make_frame(6,ra=10.0005),'flag':make_frame(100,flags=1)}
    output=tmp_path/'coadd.png'
    info=stack.build_stack(10,20,list(images),lambda url,*_:images[url],output)
    assert output.is_file()
    assert info['total']==3
    assert info['included']==2
    assert info['failed']==1
    assert info['center_pixel_contributors']==2


def test_corrupt_frame_skipped_but_progress_complete(tmp_path):
    images={'a':make_frame(4),'bad':b'not a FITS'}
    reports=[]
    info=stack.build_stack(10,20,list(images),lambda url,*_:images[url],tmp_path/'result.png',
                           on_progress=lambda *args:reports.append(args))
    assert info['included']==1
    assert info['failed']==1
    assert reports[-1][0] == 2
