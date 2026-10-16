"""Published regional values and explicit spatial membership."""
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import create_app


class RegionalTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = create_app().test_client()
        cls.bundle = json.loads((ROOT / 'data/results.json').read_text(encoding='utf-8'))

    def test_all_group_schemes_use_native_statistics(self):
        schemes = {'UN Region', 'UN Subregion', 'UN Intermediate region',
                   'OECD region', 'Income category', 'World'}
        for scheme in schemes:
            for stat in ('Mean', 'Median'):
                response = self.client.get('/api/spatial/groups', query_string={'scheme': scheme, 'statistic': stat})
                self.assertEqual(response.status_code, 200)
                payload = response.get_json()
                self.assertEqual(set(payload['schemes']), schemes)
                members = []
                for row in payload['rows']:
                    members.extend(row['members'])
                    native = self.bundle['aggregated'][row['id']]['outputs']
                    for metric, values in row['values'].items():
                        self.assertEqual(values, {'value': native[metric][stat], 'mean': native[metric]['Mean'],
                                                 'median': native[metric]['Median'], 'low': native[metric]['5th percentile'],
                                                 'high': native[metric]['95th percentile']})
                self.assertEqual(len(members), 246)
                self.assertEqual(len(set(members)), 246)

    def test_income_membership_uses_native_country_category(self):
        rows = self.client.get('/api/spatial/groups?scheme=Income%20category').get_json()['rows']
        expected = {row['id']: row['income'] for row in self.bundle['entities']}
        self.assertEqual({country: row['name'] for row in rows for country in row['members']}, expected)

    def test_unknown_and_repeated_selectors_fail(self):
        for query in ('scheme=continent', 'statistic=Maximum', 'scheme=World&scheme=UN%20Region', 'income=HIC'):
            self.assertEqual(self.client.get('/api/spatial/groups?' + query).status_code, 400)


if __name__ == '__main__':
    unittest.main()
