"""Network-free regression tests for optional Drive tooling."""

import gzip
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE_PATH = Path(__file__).resolve().parents[1] / "tools" / "drive_uploader.py"
spec = importlib.util.spec_from_file_location("artemisos_drive_uploader", MODULE_PATH)
uploader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(uploader)


class DriveUploaderTests(unittest.TestCase):
    def test_official_irsa_url_validation(self):
        good = "https://irsa.ipac.caltech.edu/ibe/data/spherex/survey/image.fits"
        self.assertTrue(uploader.valid_irsa_url(good))
        self.assertFalse(uploader.valid_irsa_url("https://irsa.ipac.caltech.edu.evil.test/ibe/data/spherex/a.fits"))
        self.assertFalse(uploader.valid_irsa_url("http://irsa.ipac.caltech.edu/ibe/data/spherex/a.fits"))
        self.assertFalse(uploader.valid_irsa_url("https://irsa.ipac.caltech.edu/anything-else/a.fits"))

    def test_fits_and_gzip_signature(self):
        with tempfile.TemporaryDirectory() as tmp:
            a = Path(tmp) / "a.fits"
            a.write_bytes(b"SIMPLE  =" + b" " * 2871)
            self.assertEqual(uploader.inspect_fits(a), 2880)
            b = Path(tmp) / "a.fits.gz"
            with gzip.open(b, "wb") as stream:
                stream.write(b"SIMPLE  =" + b" " * 2871)
            self.assertGreater(uploader.inspect_fits(b), 0)
            c = Path(tmp) / "bad.fits"
            c.write_bytes(b"<html>" + b" " * 90)
            with self.assertRaises(ValueError):
                uploader.inspect_fits(c)

    def test_manifest_upsert_and_replace(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "manifest.json"
            entry = {"irsa_access_url": "https://irsa.ipac.caltech.edu/ibe/data/spherex/x.fits",
                     "obs_id": "O1", "band": 1, "drive_file_id": "some-file"}
            uploader.upsert_manifest(path, entry)
            second = dict(entry, drive_file_id="new-file")
            uploader.upsert_manifest(path, second)
            data = json.loads(path.read_text(encoding="utf-8"))
            self.assertEqual(data["schema_version"], 1)
            self.assertEqual(len(data["observations"]), 1)
            self.assertEqual(data["observations"][0]["drive_file_id"], "new-file")


if __name__ == "__main__":
    unittest.main()
