"""Synthetic WISE-to-SPHEREx reprojection tests without live archive access."""

import ast
import io
import math
import unittest
from pathlib import Path

import numpy as np
from PIL import Image


SOURCE = Path(__file__).resolve().parents[1] / "wise_alignment.py"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))
FUNCTION_NAMES = {"_bilinear_sample", "_resample_to_grid", "_sampled_to_png"}
CONSTANT_NAMES = {"WISE_OVERLAY_MAX_PX", "WISE_OVERLAY_MAX_OVERSAMPLE"}
NODES = [
    node for node in TREE.body
    if (isinstance(node, ast.FunctionDef) and node.name in FUNCTION_NAMES)
    or (
        isinstance(node, ast.Assign)
        and any(
            isinstance(target, ast.Name) and target.id in CONSTANT_NAMES
            for target in node.targets
        )
    )
]


class FakeZScaleInterval:
    """Deterministic replacement for this test's contrast calculation."""

    def get_limits(self, values):
        return float(np.percentile(values, 5)), float(np.percentile(values, 99.5))


class WiseOverlayTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.namespace = {
            "np": np,
            "Image": Image,
            "io": io,
            "ZScaleInterval": FakeZScaleInterval,
        }
        module = ast.fix_missing_locations(ast.Module(body=NODES, type_ignores=[]))
        exec(compile(module, str(SOURCE), "exec"), cls.namespace)

    def setUp(self):
        # Synthetic sky: a point at (+0.004, -0.003) degrees.
        self.source_x, self.source_y = 0.004, -0.003
        self.nx = self.ny = 23
        self.scale_s = 6.15 / 3600  # SPHEREx pixel size in degrees
        self.angle = math.radians(30)  # Rotated SPHEREx image

        def spherex_pix_to_world(x, y):
            dx = (x - (self.nx - 1) / 2) * self.scale_s
            dy = (y - (self.ny - 1) / 2) * self.scale_s
            return (
                dx * math.cos(self.angle) - dy * math.sin(self.angle),
                dx * math.sin(self.angle) + dy * math.cos(self.angle),
            )

        scale_w = 1.375 / 3600  # WISE pixel size in degrees
        wise_size = 200

        def wise_world_to_pix(x, y):
            return x / scale_w + (wise_size - 1) / 2, y / scale_w + (wise_size - 1) / 2

        yy, xx = np.mgrid[0:wise_size, 0:wise_size]
        wx, wy = wise_world_to_pix(self.source_x, self.source_y)
        self.wise_image = np.exp(-((xx - wx) ** 2 + (yy - wy) ** 2) / (2 * 3.0 ** 2))
        self.wise_image += 0.01 * np.random.default_rng(0).normal(size=(wise_size, wise_size))
        self.spherex_pix_to_world = spherex_pix_to_world
        self.wise_world_to_pix = wise_world_to_pix

    def sample(self, wise_to_pix=None):
        return self.namespace["_resample_to_grid"](
            self.nx,
            self.ny,
            self.spherex_pix_to_world,
            wise_to_pix or self.wise_world_to_pix,
            self.wise_image,
        )

    def test_reprojection_preserves_source_location(self):
        sampled, factor = self.sample()
        image_y, image_x = np.unravel_index(np.nanargmax(sampled), sampled.shape)
        found_x = (image_x + 0.5) / factor - 0.5
        found_y = (image_y + 0.5) / factor - 0.5

        dx = self.source_x * math.cos(self.angle) + self.source_y * math.sin(self.angle)
        dy = -self.source_x * math.sin(self.angle) + self.source_y * math.cos(self.angle)
        expected_x = dx / self.scale_s + (self.nx - 1) / 2
        expected_y = dy / self.scale_s + (self.ny - 1) / 2
        self.assertLess(abs(found_x - expected_x), 0.6)
        self.assertLess(abs(found_y - expected_y), 0.6)

    def test_overlay_png_has_oversampled_dimensions(self):
        sampled, factor = self.sample()
        png = self.namespace["_sampled_to_png"](sampled)
        with Image.open(io.BytesIO(png)) as image:
            self.assertEqual(image.size, (self.nx * factor, self.ny * factor))
            self.assertEqual(image.mode, "RGB")

    def test_no_coverage_is_rejected(self):
        sampled, _ = self.sample(lambda x, y: (x * 0 + 9999, y * 0 + 9999))
        self.assertTrue(np.isnan(sampled).all())
        with self.assertRaisesRegex(ValueError, "does not cover"):
            self.namespace["_sampled_to_png"](sampled)


if __name__ == "__main__":
    unittest.main()
