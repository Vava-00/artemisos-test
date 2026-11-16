"""Isolated IRSA catalog tests: no Flask dependency or NASA network access.

Run: python -m unittest discover -s tests -p 'test_*.py' -v
"""
import ast
import csv
import io
from http.server import BaseHTTPRequestHandler, HTTPServer
import logging
import math
from pathlib import Path
import requests
import threading
import time
import unittest
from types import SimpleNamespace
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

src = Path(__file__).resolve().parents[1] / 'main.py'
tree = ast.parse(src.read_text(encoding='utf-8'))
names = {'_query_sia_csv', '_get_metadata', 'search_spherex', 'classify_band'}
nodes = []
for node in tree.body:
    if isinstance(node, ast.FunctionDef) and node.name in names:
        node.decorator_list = []
        nodes.append(node)
    if isinstance(node, ast.ClassDef) and node.name == 'CatalogUnavailable':
        nodes.append(node)

ROOT = 'https://irsa.ipac.caltech.edu/ibe/data/spherex/dr1/'
HEADER = 'access_url,em_min,t_min,obs_id,s_ra,s_dec\n'
def row(name, mjd='60500'):
    return f'{ROOT}{name}.fits,0.000001, {mjd},obs-{name},10,20\n'

class FakeResponse:
    def __init__(self, text='', status=200):
        self.text = text
        self.status_code = status
    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f'{self.status_code} error', response=self)

class FakeSession:
    def __init__(self, scripted):
        self.responses = list(scripted)
        self.calls = []
    def get(self, url, params=None, timeout=None):
        self.calls.append(([v for k, v in params if k == 'COLLECTION'], timeout))
        outcome = self.responses.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

class RecoveryTests(unittest.TestCase):
    def setUp(self):
        self.ns = {
            'requests': requests, 'csv': csv, 'io': io, 'math': math,
            'SIA_URL': 'https://irsa.ipac.caltech.edu/SIA',
            'COLLECTIONS': ('spherex_dr1','spherex_qr3'),
            'IRSA_UNAVAILABLE_MESSAGE': 'NASA/IPAC (IRSA) is temporarily unavailable.',
            'app': SimpleNamespace(logger=logging.getLogger('recovery-tests')),
            'is_trusted_irsa_url': lambda url: url.startswith(ROOT),
            'mjd_to_date': lambda mjd: ('2025-07-01 UTC', float(mjd)),
            'metadata_lock': threading.Lock(),
            'metadata_cache': {}, 'METADATA_TTL': 15 * 60,
            'time': time, 'jsonify': lambda data: data,
            'request': SimpleNamespace(args={'ra':'10','dec':'20','radius':'0.02'}),
        }
        exec(compile(ast.fix_missing_locations(ast.Module(body=nodes, type_ignores=[])), str(src), 'exec'), self.ns)

    def set_script(self, outcomes):
        self.ns['session'] = FakeSession(outcomes)
        return self.ns['session']

    def test_real_http_adapter_retries_502_then_recovers(self):
        # Local network-free test: the server fails twice, then succeeds.
        # Read the actual retry configuration from main.py.
        assignment = next(n for n in tree.body if isinstance(n, ast.Assign)
                          and any(isinstance(t, ast.Name) and t.id == 'retry' for t in n.targets))
        policy = eval(compile(ast.Expression(assignment.value), str(src), 'eval'),
                      {'Retry': Retry, 'frozenset': frozenset})
        self.assertEqual(policy.total, 2)
        self.assertGreater(policy.backoff_factor, 0)
        self.assertIn(502, policy.status_forcelist)
        self.assertTrue(policy.respect_retry_after_header)
        self.assertFalse(policy.raise_on_status)
        class Handler(BaseHTTPRequestHandler):
            calls = 0
            def do_GET(self):
                Handler.calls += 1
                self.send_response(502 if Handler.calls < 3 else 200)
                self.end_headers()
                self.wfile.write(b'fail' if Handler.calls < 3 else b'ok')
            def log_message(self, *_):
                pass
        server = HTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with requests.Session() as client:
                client.mount('http://', HTTPAdapter(max_retries=policy))
                response = client.get(f'http://127.0.0.1:{server.server_port}/', timeout=8)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(Handler.calls, 3)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_joint_success_does_not_split_query(self):
        sess = self.set_script([FakeResponse(HEADER + row('a') + row('b'))])
        result = self.ns['_get_metadata'](10, 20, .02)
        self.assertEqual(len(sess.calls), 1)
        self.assertEqual(sess.calls[0][0], ['spherex_dr1','spherex_qr3'])
        self.assertEqual(result['total_found'], 2)
        self.assertFalse(result['fallback'])
        self.assertFalse(result['partial'])
        self.assertEqual(sess.calls[0][1], (8, 30))

    def test_joint_502_recovers_both_collections(self):
        sess = self.set_script([FakeResponse('upstream failure',502),
            FakeResponse(HEADER + row('a')), FakeResponse(HEADER + row('b') + row('a'))])
        result = self.ns['_get_metadata'](10, 20, .02)
        self.assertEqual([c[0] for c in sess.calls],
                         [['spherex_dr1','spherex_qr3'], ['spherex_dr1'], ['spherex_qr3']])
        self.assertEqual(result['total_found'], 2, 'duplicate FITS must be removed')
        self.assertTrue(result['fallback'])
        self.assertFalse(result['partial'])
        self.assertIn('separately', result['notice'])

    def test_one_collection_failed_returns_partial_warning(self):
        self.set_script([FakeResponse(status=502), FakeResponse(HEADER + row('a')),
                         requests.Timeout('QR3 timed out')])
        result = self.ns['_get_metadata'](10,20,.02)
        self.assertTrue(result['partial'])
        self.assertEqual(result['collections'], ['spherex_dr1'])
        self.assertIn('QR3', result['notice'])
        self.assertIn('partial', result['notice'])
        self.assertEqual(result['total_found'], 1)

    def test_invalid_html_joint_response_causes_fallback(self):
        self.set_script([FakeResponse('<html>bad gateway</html>'), FakeResponse(HEADER),
                         FakeResponse(HEADER + row('b'))])
        result = self.ns['_get_metadata'](10,20,.02)
        self.assertTrue(result['fallback'])
        self.assertFalse(result['partial'])
        self.assertEqual(result['total_found'], 1)

    def test_both_collections_fail_returns_friendly_message_without_raw_exception(self):
        self.set_script([FakeResponse(status=502), requests.Timeout('internal-stack-ABC'),
                         FakeResponse(status=503)])
        answer, http_status = self.ns['search_spherex']()
        self.assertEqual(http_status, 503)
        self.assertEqual(answer['status'], 'error')
        self.assertTrue(answer['retryable'])
        self.assertIn('NASA/IPAC', answer['message'])
        self.assertNotIn('internal-stack-ABC', answer['message'])
        self.assertNotIn('HTTPSConnectionPool', answer['message'])

    def test_partial_result_is_not_cached_as_complete(self):
        self.set_script([FakeResponse(status=502), FakeResponse(HEADER + row('a')),
                         FakeResponse(status=503)])
        answer = self.ns['search_spherex']()
        self.assertTrue(answer['partial'])
        self.assertEqual(self.ns['metadata_cache'], {}, 'Do not cache incomplete catalog')

    def test_complete_fallback_uses_existing_memory_cache(self):
        sess = self.set_script([FakeResponse(status=502), FakeResponse(HEADER + row('a')),
                                FakeResponse(HEADER + row('b'))])
        first = self.ns['search_spherex']()
        second = self.ns['search_spherex']()
        self.assertEqual(first, second)
        self.assertEqual(len(sess.calls), 3, 'existing cache still works for complete results')

if __name__ == '__main__':
    unittest.main()
