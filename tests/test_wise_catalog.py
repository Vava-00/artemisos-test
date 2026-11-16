"""Offline WISE metadata tests; exercise production code without Flask or Astropy."""

import ast
import math
import unittest
from pathlib import Path
from types import SimpleNamespace


SOURCE = Path(__file__).resolve().parents[1] / "wise_routes.py"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))
FACTORY = next(
    node for node in TREE.body
    if isinstance(node, ast.FunctionDef) and node.name == "create_wise_blueprint"
)
# Extract the real nested implementations. This avoids importing optional
# packages or sending live requests during a quick regression test.
FUNCTIONS = [
    node for node in FACTORY.body
    if isinstance(node, ast.FunctionDef)
    and node.name in {"_wise_band", "_get_wise_metadata"}
]


class FakeSkyCoord:
    """Minimal angular-distance stand-in for this small synthetic sky field."""

    def __init__(self, ra, dec, **_):
        self.ra = float(ra)
        self.dec = float(dec)

    def separation(self, other):
        return SimpleNamespace(deg=math.hypot(self.ra - other.ra, self.dec - other.dec))


class WiseCatalogTests(unittest.TestCase):
    def setUp(self):
        self.rows = []
        self.ns = {
            "math": math,
            "SkyCoord": FakeSkyCoord,
            "WISE_BANDS": ((1, 2.5, 4), (2, 4, 8), (3, 8, 17), (4, 17, 40)),
            "WISE_LABELS": {1: "3.4 µm", 2: "4.6 µm", 3: "12 µm", 4: "22 µm"},
            "WISE_SKIP_PARTS": ("-unc-", "-cov-", "-msk", "-std-", "-mask"),
            "is_trusted_wise_url": lambda url: url.startswith(
                "https://irsa.ipac.caltech.edu/ibe/data/wise/"
            ),
            "_query_sia_csv": lambda collections, ra, dec, radius: self.rows,
            "WISE_COLLECTION": "wise_allwise",
        }
        module = ast.fix_missing_locations(ast.Module(body=FUNCTIONS, type_ignores=[]))
        exec(compile(module, str(SOURCE), "exec"), self.ns)

    def row(self, identifier, wavelength, ra=10.0, dec=20.0, **more):
        return {
            "access_url": (
                f"https://irsa.ipac.caltech.edu/ibe/data/wise/{identifier}.fits"
            ),
            "obs_id": identifier,
            "em_min": wavelength - 0.1,
            "em_max": wavelength + 0.1,
            "s_ra": str(ra),
            "s_dec": str(dec),
            "dataproduct_subtype": "science",
            **more,
        }

    def test_six_science_rows_select_one_nearest_tile_per_wise_band(self):
        self.rows = [
            self.row("w1-far", 3.4, ra=11),
            self.row("w1-near", 3.4, ra=10.05),
            self.row("w2", 4.6),
            self.row("w3", 12),
            self.row("w4", 22),
            self.row("w3-cov-mask", 12),
            self.row("w2-calibration", 4.6, dataproduct_subtype="calibration"),
        ]
        # This invokes the same code as the WISE /search endpoint, and catches
        # undefined variables or accidental response-format changes.
        result = self.ns["_get_wise_metadata"](10, 20, 0.02)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["total"], 4)
        self.assertEqual(set(result["bands"]), {"1", "2", "3", "4"})
        self.assertEqual(result["bands"]["1"]["obs_id"], "w1-near")
        self.assertEqual(result["bands"]["4"]["label"], "22 µm")

    def test_empty_or_unusable_catalog_returns_no_wise_tiles(self):
        self.rows = [self.row("w1", 3.4, access_url="https://untrusted.test/w1.fits")]
        result = self.ns["_get_wise_metadata"](10, 20, 0.02)
        self.assertEqual(result, {"status": "ok", "bands": {}, "total": 0})

    def test_wavelength_metadata_accepts_meters(self):
        self.rows = [self.row("w1", 3.4e-6, em_min=3.3e-6, em_max=3.5e-6)]
        result = self.ns["_get_wise_metadata"](10, 20, 0.02)
        self.assertEqual(result["bands"]["1"]["obs_id"], "w1")


if __name__ == "__main__":
    unittest.main()
