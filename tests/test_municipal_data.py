"""Lazy municipal access, native identifiers, missingness and package integrity."""
from __future__ import annotations

import gzip
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from municipal_data import EMPTY_AREA_ID, MunicipalDataError, MunicipalStore


class MunicipalStoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.rows = [
            {'id': 'AAA.1.1_1', 'name': 'Repeated name', 'population': 12.5, 'admin_names': ['North', 'One', None, None],
             'rural_share': .3, 'urban_class_1': '2', 'urban_class_2': '23', 'status': 'modelled',
             'values': [[0.0, 0.0, 0.0, 0.0], [-1e-25, 1.0, None, 3.0]]},
            {'id': 'AAA.2.1_1', 'name': 'Repeated name', 'population': 0.0, 'admin_names': [None, None, None, None],
             'rural_share': None, 'urban_class_1': None, 'urban_class_2': None, 'status': 'no_modelled_population',
             'values': [[None, None, None, None], [None, None, None, None]]},
        ]
        self.metrics = [{'id': 'plas_em', 'unit': 't/year'}, {'id': 'plas_recy_em', 'unit': 't/year'}]
        entries = []
        for country_id, rows in [('AAA', self.rows), ('BBB', [{**self.rows[0], 'id': 'BBB.1_1'}])]:
            value = {'schema': 'spot-municipal/v1', 'country_id': country_id,
                     'metric_ids': ['plas_em', 'plas_recy_em'],
                     'statistics': ['Mean', 'Median', '5th percentile', '95th percentile'], 'rows': rows}
            raw = json.dumps(value, separators=(',', ':')).encode()
            blob = gzip.compress(raw, mtime=0)
            filename = country_id + '.json.gz'
            (self.root / filename).write_bytes(blob)
            areas = [{'id': 'North', 'name': 'North', 'count': 1}]
            if country_id == 'AAA':
                areas.append({'id': EMPTY_AREA_ID, 'name': None, 'count': 1})
            entries.append({'id': country_id, 'name': country_id, 'units': len(rows), 'areas': areas,
                            'file': filename, 'bytes': len(blob), 'json_bytes': len(raw),
                            'sha256': hashlib.sha256(blob).hexdigest()})
        manifest = {'schema': 'spot-municipal/v1', 'release': {'model_year': 2020},
                    'metric_ids': ['plas_em', 'plas_recy_em'], 'metrics': self.metrics,
                    'statistics': ['Mean', 'Median', '5th percentile', '95th percentile'],
                    'countries': entries, 'unit_count': 3, 'no_modelled_population_unit_count': 1, 'sources': []}
        (self.root / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
        self.store = MunicipalStore(self.root)

    def tearDown(self):
        self.temp.cleanup()

    def test_unknown_or_unprepared_store_is_explicit(self):
        absent = MunicipalStore(self.root / 'missing')
        self.assertFalse(absent.available)
        self.assertFalse(absent.metadata()['available'])
        with self.assertRaises(FileNotFoundError): absent.country('AAA')
        with self.assertRaises(KeyError): self.store.country('XXX')

    def test_exact_values_statistics_native_ids_and_null_zero_difference(self):
        response = self.store.country('AAA', ['plas_em', 'plas_recy_em'], 'Median')
        first, missing = response['rows']
        self.assertEqual(first['id'], 'AAA.1.1_1')
        self.assertEqual(first['values']['plas_em']['value'], 0)
        self.assertEqual(first['values']['plas_recy_em'], {'value': 1, 'mean': -1e-25, 'median': 1, 'low': None, 'high': 3})
        self.assertIsNone(missing['values']['plas_em']['value'])
        self.assertEqual(missing['status'], 'no_modelled_population')
        self.assertEqual(response['unit_count'], 2)

    def test_native_area_membership_uses_ids_and_source_fields(self):
        response = self.store.country('AAA', 'plas_em', area='North')
        self.assertEqual([row['id'] for row in response['rows']], ['AAA.1.1_1'])
        self.assertEqual(self.store.members('AAA', EMPTY_AREA_ID), frozenset({'AAA.2.1_1'}))
        self.assertEqual(self.store.members('AAA'), frozenset(row['id'] for row in self.rows))
        with self.assertRaises(ValueError): self.store.country('AAA', 'plas_em', area='One')

    def test_unsupported_statistics_metrics_duplicates_and_profiles(self):
        for statistic in ['Mean,Median', '5th percentile', 'sum', 'mean']:
            with self.assertRaises(ValueError): self.store.country('AAA', 'plas_em', statistic)
        with self.assertRaises(KeyError): self.store.country('AAA', ['not_a_metric'])
        with self.assertRaises(ValueError): self.store.country('AAA', ['plas_em', 'plas_em'])
        with self.assertRaises(ValueError): self.store.country('AAA', [])
        profile = self.store.profile('AAA.1.1_1')
        self.assertEqual(set(profile['row']['values']), {'plas_em', 'plas_recy_em'})
        with self.assertRaises(KeyError): self.store.profile('AAA.unknown')

    def test_single_country_cache_and_defensive_admin_names(self):
        response = self.store.country('AAA', 'plas_em')
        response['rows'][0]['admin_names'][0] = 'Changed'
        self.assertEqual(self.store.country('AAA', 'plas_em')['rows'][0]['admin_names'][0], 'North')
        self.store.country('BBB', 'plas_em')
        self.assertEqual(self.store._country_id, 'BBB')
        self.assertEqual(len(self.store._country['rows']), 1)
        with self.assertRaises(ValueError): MunicipalStore(self.root, cache_countries=2)

    def test_corrupted_country_checksum_fails_closed(self):
        path = self.root / 'AAA.json.gz'
        path.write_bytes(path.read_bytes() + b'corrupt')
        with self.assertRaises(MunicipalDataError): self.store.country('AAA', 'plas_em')


@unittest.skipUnless((ROOT / 'data/municipal/manifest.json').is_file(), 'Prepared municipal package not yet available')
class PublishedMunicipalPackage(unittest.TestCase):
    def test_independently_recorded_municipal_source_cells(self):
        # Original municipal Outputs cells, independently extracted into the
        # 15 October workbook inventory before this preparation code existed.
        # Mean: AN2/AS2/AT2/BH2. Median: AN5/AS5/AT5. 5th: AN3/AS3/AT3.
        row = MunicipalStore().country('ABW', ['plas_em', 'plas_em_per_cap', 'plas_em_pct_pwg', 'plas_disp_em'])['rows'][0]
        self.assertEqual(row['population'], 106476.813464819)  # K2
        self.assertEqual(row['values']['plas_em']['mean'], 68.030790567554405)
        self.assertEqual(row['values']['plas_em']['median'], 13.244420055528)
        self.assertEqual(row['values']['plas_em']['low'], 3.5267089250511701)
        self.assertEqual(row['values']['plas_em_per_cap']['mean'], 0.63892586896425496)
        self.assertEqual(row['values']['plas_em_per_cap']['median'], 0.124387832660902)
        self.assertEqual(row['values']['plas_em_per_cap']['low'], 0.033121848882305502)
        self.assertEqual(row['values']['plas_em_pct_pwg']['mean'], 0.77670463823332103)
        self.assertEqual(row['values']['plas_em_pct_pwg']['median'], 0.15518089852075201)
        self.assertEqual(row['values']['plas_disp_em']['mean'], 0.0)

    def test_source_zero_population_unit_stays_unavailable(self):
        # Monte Carlo MFA Inputs!A1003:I1003 identifies ARG.8.9_1, Isla,
        # Population_2020=0. The source model writes unavailable results.
        row = MunicipalStore().profile('ARG.8.9_1')['row']
        self.assertEqual(row['name'], 'Isla')
        self.assertEqual(row['population'], 0)
        self.assertEqual(row['status'], 'no_modelled_population')
        self.assertEqual(len(row['values']), 68)
        self.assertTrue(all(value is None for metric in row['values'].values() for value in metric.values()))

    def test_all_country_chunk_hashes_and_native_counts(self):
        root = ROOT / 'data/municipal'
        manifest = json.loads((root / 'manifest.json').read_bytes())
        national = json.loads((ROOT / 'data/results.json').read_bytes())
        self.assertEqual(manifest['unit_count'], 50702)
        self.assertEqual(manifest['no_modelled_population_unit_count'], 126)
        self.assertEqual(len(manifest['metric_ids']), 68)
        self.assertEqual({row['id'] for row in manifest['countries']}, {row['id'] for row in national['entities']})
        self.assertEqual(sum(row['units'] for row in manifest['countries']), 50702)
        for row in manifest['countries']:
            with self.subTest(country=row['id']):
                blob = (root / row['file']).read_bytes()
                self.assertEqual(len(blob), row['bytes'])
                self.assertEqual(hashlib.sha256(blob).hexdigest(), row['sha256'])
                self.assertEqual(sum(area['count'] for area in row['areas']), row['units'])

    def test_single_unit_aruba_values_match_released_national_source(self):
        store = MunicipalStore()
        row = store.country('ABW', ['plas_em'], 'Mean')['rows'][0]
        native = json.loads((ROOT / 'data/results.json').read_bytes())['national']['ABW']['outputs']['plas_em']
        self.assertEqual(row['id'], 'ABW')
        self.assertEqual(row['values']['plas_em'], {'value': native['Mean'], 'mean': native['Mean'],
                                                  'median': native['Median'], 'low': native['5th percentile'], 'high': native['95th percentile']})


if __name__ == '__main__':
    unittest.main()
