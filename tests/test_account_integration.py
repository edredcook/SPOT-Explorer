"""Account isolation in the actual explorer, including its response middleware."""
import os
import unittest
from unittest.mock import patch

from app import create_app


class AccountIntegrationTests(unittest.TestCase):
    def setUp(self):
        with patch.dict(os.environ, {}, clear=True):
            self.app = create_app()
        self.app.config['TESTING'] = True
        self.client = self.app.test_client()

    def test_account_responses_stay_private_through_explorer_middleware(self):
        for path in ('/account', '/api/auth/config', '/api/auth/session',
                     '/static/account.html', '/static/account.js', '/static/account.css'):
            with self.subTest(path=path):
                with self.client.get(path, base_url='https://spot.example') as response:
                    self.assertEqual(response.status_code, 200)
                    self.assertIn('no-store', response.headers['Cache-Control'])
                    self.assertNotIn('max-age', response.headers['Cache-Control'])
                    self.assertEqual(response.headers['Referrer-Policy'], 'no-referrer')
                    self.assertEqual(response.headers['X-Frame-Options'], 'DENY')
        config = self.client.get('/api/auth/config', base_url='https://spot.example').get_json()
        self.assertFalse(config['configured'])
        self.assertTrue(config['invitation_only'])
        self.assertNotIn('secret_key', config)
        self.assertNotIn('publishable_key', config)

    def test_account_setup_does_not_gate_public_results(self):
        for path in ('/', '/healthz', '/api/meta', '/api/atlas', '/api/provenance'):
            with self.subTest(path=path):
                with self.client.get(path) as response:
                    self.assertEqual(response.status_code, 200)
                    if path.startswith('/api/'):
                        self.assertIn('public, max-age=', response.headers['Cache-Control'])
        self.assertGreaterEqual(self.client.get('/api/auth/viewers').status_code, 400)


if __name__ == '__main__':
    unittest.main()
