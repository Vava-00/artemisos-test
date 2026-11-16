"""Network-independent structure/regression tests for WISE and accordion markup."""
import ast
import re
import unittest
from pathlib import Path
from html.parser import HTMLParser

ROOT = Path(__file__).resolve().parent.parent


class IdParser(HTMLParser):
    def __init__(self):
        super().__init__()
        self.ids = []
    def handle_starttag(self, tag, attrs):
        self.ids.extend(value for key, value in attrs if key == 'id')


class V4Contracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.html = (ROOT / 'templates' / 'index.html').read_text(encoding='utf-8')
        cls.js = (ROOT / 'static' / 'js' / 'app.js').read_text(encoding='utf-8')
        cls.wise = (ROOT / 'static' / 'js' / 'wise.js').read_text(encoding='utf-8')
        cls.api = (ROOT / 'main.py').read_text(encoding='utf-8')

    def test_unique_ids(self):
        parser = IdParser()
        parser.feed(self.html)
        self.assertEqual(len(parser.ids), len(set(parser.ids)))

    def test_all_sidebar_sections_are_collapsible(self):
        self.assertEqual(self.html.count('class="side-accordion"'), 7)
        self.assertEqual(self.html.count('class="accordion-chevron"'), 7)
        for name in ('Search the sky', 'Playback', 'IR bands', 'Comparison',
                     'WISE comparison', 'Detector stack', 'Spectrum'):
            self.assertIn(name, self.html)

    def test_wise_controls_and_routes(self):
        for id_name in ('wiseSwitch', 'wisePanel', 'wiseOverlayBtn', 'wiseOverlayBar',
                        'wiseOverlayNote', 'wiseOpacity', 'wiseImage', 'wiseLoading'):
            self.assertIn(f'id="{id_name}"', self.html)
        self.assertIn('wise.js', self.html)
        self.assertIn('wise.css', self.html)
        for path in ('/api/wise/search', '/api/wise/preview', '/api/wise/overlay'):
            self.assertIn(path, (ROOT / 'static' / 'js' / 'wise.js').read_text())
        self.assertIn("'spherex:skyresolved'", self.js)
        self.assertIn("'spherex:skyresolved'", self.wise)
        ast.parse(self.api)

    def test_spectrum_controls_live_in_accordion(self):
        """The target picker belongs to Spectrum; the cube has the sole CSV button."""
        import re
        spectrum_section = self.html.split('<section id="spectrumSection"')[1].split('</aside>')[0]
        viewer_section = self.html.split('<section class="viewer">')[1]
        self.assertIn('id="pickTarget"', spectrum_section)
        self.assertIn('id="targetReset"', spectrum_section)
        self.assertIn('id="targetStatus"', spectrum_section)
        self.assertNotIn('id="pickTarget"', viewer_section)
        self.assertNotIn('id="specCsv"', self.html)
        self.assertEqual(len(re.findall(r'id="cubeCsv"', self.html)), 1)
        self.assertLess(spectrum_section.index('id="pickTarget"'), spectrum_section.index('id="cubeHeading"'))

    def test_legacy_scientific_controls_untouched(self):
        for id_name in ('coaddStart', 'spectrum', 'cubeSpectrum', 'specView', 'pickTarget',
                        'slider', 'play', 'searchForm', 'modeSwitch', 'querySwitch'):
            self.assertIn(f'id="{id_name}"', self.html)

if __name__ == '__main__':
    unittest.main()
