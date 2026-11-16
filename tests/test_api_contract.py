"""AST-level API contract checks without Flask or a network connection."""
import ast
from pathlib import Path
import unittest

SOURCE = Path(__file__).resolve().parents[1] / "main.py"
TREE = ast.parse(SOURCE.read_text(encoding="utf-8"))


class ApiContractTests(unittest.TestCase):
    def test_expected_endpoints_exist(self):
        endpoints = set()
        for node in TREE.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                for decorator in node.decorator_list:
                    if isinstance(decorator, ast.Call) and decorator.args:
                        first = decorator.args[0]
                        if isinstance(first, ast.Constant) and isinstance(first.value, str):
                            endpoints.add(first.value)
        self.assertTrue({"/", "/health", "/api/resolve", "/api/search",
                         "/api/preview", "/api/spectrum/point"}.issubset(endpoints))

    def test_single_application_entrypoint(self):
        project = SOURCE.parent
        self.assertFalse((project / "app.py").exists())
        self.assertIn('if __name__ == "__main__":', SOURCE.read_text(encoding="utf-8"))
        self.assertIn("main:app", (project / "render.yaml").read_text(encoding="utf-8"))

    def test_service_uses_standard_flask_layout(self):
        code = SOURCE.read_text(encoding="utf-8")
        self.assertIn('static_folder="static"', code)
        self.assertIn('template_folder="templates"', code)
        self.assertIn('advanced_enabled=ALLOW_ADVANCED', code)


if __name__ == "__main__":
    unittest.main()
