"""The atlas returns released national values, metadata and definitions exactly."""
import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import create_app

BUNDLE = json.loads((ROOT / 'data' / 'results.json').read_text(encoding='utf-8'))
DEFINITIONS = [m for m in BUNDLE['metrics'] if m['family'] == 'outputs']
FIELDS = {'value': None, 'low': '5th percentile', 'median': 'Median', 'high': '95th percentile', 'mean': 'Mean'}


class AtlasApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        cls.app.config.update(TESTING=True)
        cls.client = cls.app.test_client()

    def test_all_national_values_and_metadata_match_for_both_summaries(self):
        expected_metadata = {e['id']: e for e in BUNDLE['entities']}
        expected_metric_ids = {m['id'] for m in DEFINITIONS}
        for statistic in ('Mean', 'Median'):
            with self.subTest(statistic=statistic):
                response = self.client.get('/api/atlas?statistic=' + statistic)
                self.assertEqual(response.status_code, 200)
                data = response.get_json()
                self.assertEqual(data['release'], BUNDLE['release'])
                self.assertEqual(data['model_year'], 2020)
                self.assertEqual(data['statistic'], statistic)
                self.assertEqual(data['statistics'], BUNDLE['statistics'])
                self.assertEqual(data['metrics'], DEFINITIONS)
                self.assertEqual(len(data['metrics']), 68)
                self.assertEqual(len(data['rows']), 246)
                self.assertEqual({r['id'] for r in data['rows']}, set(expected_metadata))
                for row in data['rows']:
                    self.assertEqual({k: v for k, v in row.items() if k != 'values'}, expected_metadata[row['id']])
                    self.assertEqual(set(row['values']), expected_metric_ids)
                    for metric_id, values in row['values'].items():
                        source = BUNDLE['national'][row['id']]['outputs'][metric_id]
                        self.assertEqual(set(values), set(FIELDS))
                        for field, native_statistic in FIELDS.items():
                            self.assertEqual(values[field], source[statistic if field == 'value' else native_statistic],
                                             (row['id'], metric_id, field, statistic))

    def test_default_is_mean_and_legacy_map_stays_compatible(self):
        atlas = self.client.get('/api/atlas').get_json()
        self.assertEqual(atlas['statistic'], 'Mean')
        by_id = {row['id']: row for row in atlas['rows']}
        for basis, metric_id in [('total', 'plas_em'), ('per_capita', 'plas_em_per_cap')]:
            old = self.client.get('/api/map?basis=' + basis).get_json()
            self.assertEqual(old['basis'], basis)
            self.assertEqual(old['statistic'], 'Mean')
            for row in old['rows']:
                self.assertEqual(set(row), {'id', 'name', 'value', 'low', 'median', 'high'})
                values = by_id[row['id']]['values'][metric_id]
                for field in ('value', 'low', 'median', 'high'):
                    self.assertEqual(row[field], values[field])

    def test_mean_component_masses_remain_mean_when_median_is_selected(self):
        data = self.client.get('/api/atlas?statistic=Median').get_json()
        row = next(r for r in data['rows'] if r['id'] == 'IND')
        self.assertNotEqual(row['values']['plas_em']['mean'], row['values']['plas_em']['value'])
        for metric in ('plas_debris_em', 'plas_burn_em', 'plas_em'):
            self.assertEqual(row['values'][metric]['mean'], BUNDLE['national']['IND']['outputs'][metric]['Mean'])

    def test_missing_and_zero_values_remain_distinct_in_an_isolated_fixture(self):
        definition = next(m for m in DEFINITIONS if m['id'] == 'plas_em')
        fixture = {
            'release': BUNDLE['release'], 'statistics': BUNDLE['statistics'], 'metrics': [definition],
            'entities': [{'id': 'ZER', 'name': 'Known zero'}, {'id': 'NUL', 'name': 'Unavailable'}],
            'groups': [], 'aggregated': {},
            'national': {key: {'outputs': {'plas_em': {stat: value for stat in BUNDLE['statistics']}}}
                         for key, value in [('ZER', 0), ('NUL', None)]},
        }
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'results.json'
            path.write_text(json.dumps(fixture), encoding='utf-8')
            client = create_app(path).test_client()
            for statistic in ('Mean', 'Median'):
                rows = {r['id']: r for r in client.get('/api/atlas?statistic=' + statistic).get_json()['rows']}
                for field in FIELDS:
                    self.assertEqual(rows['ZER']['values']['plas_em'][field], 0)
                    self.assertIsNone(rows['NUL']['values']['plas_em'][field])

    def test_rejects_unknown_repeated_and_unsupported_arguments(self):
        invalid = ['statistic=', 'statistic=mean', 'statistic=Median&statistic=Mean',
                   'statistic=Mean&statistic=Mean', 'statistic=5th%20percentile', 'statistic=all',
                   'entity=IND', 'entities=IND,GBR', 'family=outputs', 'metric=plas_em',
                   'basis=total', 'unknown=1']
        for query in invalid:
            with self.subTest(query=query):
                response = self.client.get('/api/atlas?' + query)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.get_json()['error']['code'], 'invalid_query')

    def test_atlas_is_read_only_and_carries_browser_headers(self):
        self.assertEqual(self.client.post('/api/atlas', json={'statistic': 'Mean'}).status_code, 405)
        response = self.client.get('/api/atlas')
        self.assertEqual(response.mimetype, 'application/json')
        self.assertEqual(response.headers['X-Content-Type-Options'], 'nosniff')
        self.assertIn('public, max-age=', response.headers['Cache-Control'])
        self.assertIn("frame-ancestors 'none'", response.headers['Content-Security-Policy'])


if __name__ == '__main__':
    unittest.main()
