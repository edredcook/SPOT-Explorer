"""HTTP scoping, compression and bounded image request contracts."""
import gzip
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import create_app


@unittest.skipUnless((ROOT / 'data/municipal/manifest.json').exists(), 'Prepared municipal release required')
class MunicipalAPITests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.app = create_app()
        cls.client = cls.app.test_client()

    def test_country_scope_and_native_per_person_values(self):
        response = self.client.get('/api/municipal/values?country=ABW&metric=plas_em_per_cap&statistic=Median')
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        native = self.app.extensions['municipal_store'].profile('ABW', 'Median')['row']['values']['plas_em_per_cap']
        self.assertEqual(payload['country']['id'], 'ABW')
        self.assertEqual(payload['count'], 1)
        self.assertEqual(payload['rows'][0]['values'], {'plas_em_per_cap': native})
        self.assertEqual(payload['metric']['display_unit'], 'kg/person/year')
        source_definition = next(m for m in self.app.extensions['municipal_store'].metadata()['metrics']
                                 if m['id'] == 'plas_em_per_cap')
        self.assertEqual(payload['metric'], source_definition)
        self.assertEqual(payload['legend']['maximum'], native['value'])
        self.assertIn('public', response.headers['Cache-Control'])

    def test_compressed_response_preserves_null_and_zero(self):
        response = self.client.get('/api/municipal/values?country=ARG&metric=plas_em', headers={'Accept-Encoding': 'gzip'})
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers['Content-Encoding'], 'gzip')
        payload = json.loads(gzip.decompress(response.data))
        missing = next(row for row in payload['rows'] if row['id'] == 'ARG.8.9_1')
        self.assertIsNone(missing['values']['plas_em']['value'])
        self.assertEqual(missing['status'], 'no_modelled_population')
        self.assertIn('Accept-Encoding', response.headers['Vary'])

    def test_unknown_and_repeated_scope_selectors_fail(self):
        for query in ('country=XYZ', 'country=IND&country=ABW', 'metric=../x',
                      'statistic=Maximum', 'area=', 'area=Not%20a%20source%20area', 'level=municipal'):
            self.assertEqual(self.client.get('/api/municipal/values?' + query).status_code, 400, query)

    def test_metadata_retains_all_countries_and_native_areas(self):
        response = self.client.get('/api/municipal/meta')
        self.assertEqual(response.status_code, 200)
        payload = response.get_json()
        self.assertEqual(payload['unit_count'], 50702)
        self.assertEqual(payload['no_modelled_population_unit_count'], 126)
        self.assertEqual(len(payload['source_statistics']), 6)
        self.assertEqual(len(payload['prepared_statistics']), 4)
        self.assertIsInstance(payload['geometry']['available'], bool)
        self.assertEqual(len(payload['countries']), 246)
        self.assertEqual(sum(row['count'] for row in payload['countries']), 50702)
        for country in payload['countries']:
            self.assertEqual(sum(area['count'] for area in country['areas']), country['count'])
            self.assertIsInstance(country['geometry_ready'], bool)

    def test_png_rejects_nonfinite_and_oversized_viewports(self):
        base = '/api/municipal/map.png?country=ABW&width=800&height=500&scale=150&tx=400&ty=250'
        for query in (base + '&width=900', base.replace('width=800', 'width=2001'),
                      base.replace('scale=150', 'scale=nan'), base.replace('ty=250', 'ty=inf'),
                      base.replace('width=800&height=500', 'width=2000&height=1400')):
            self.assertEqual(self.client.get(query).status_code, 400, query)

    def test_image_and_inspection_share_selected_native_scope(self):
        geometry = self.app.extensions['municipal_geometry']
        with patch.object(geometry, 'render_png', return_value=b'png-test') as render:
            response = self.client.get('/api/municipal/map.png?country=ABW&metric=plas_em&width=800&height=500&scale=150&tx=400&ty=250')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.mimetype, 'image/png')
            self.assertEqual(set(render.call_args.args[1]), {'ABW'})
        with patch.object(geometry, 'inspect', return_value='ABW'):
            response = self.client.get('/api/municipal/inspect?country=ABW&metric=plas_em&lon=-70&lat=12')
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()['row']['id'], 'ABW')
        self.assertEqual(self.client.get('/static/.runtime/municipal/geometry.sqlite').status_code, 404)
        self.assertEqual(self.client.get('/api/municipal/inspect?lon=181&lat=0').status_code, 400)

    def test_different_municipal_release_cannot_be_mixed_with_national(self):
        store = self.app.extensions['municipal_store']
        payload = store.country('ABW', ['plas_em'])
        payload['release'] = {**payload['release'], 'version': 'different-release'}
        with patch.object(store, 'country', return_value=payload):
            response = self.client.get('/api/municipal/values?country=ABW')
            self.assertEqual(response.status_code, 503)
            self.assertNotIn('rows', response.get_json())


if __name__ == '__main__':
    unittest.main()
