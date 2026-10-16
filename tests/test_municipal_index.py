"""The optional fast index preserves native results and fails closed if stale."""
from __future__ import annotations

import gzip
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from municipal_data import MunicipalDataError, MunicipalStore
from scripts.prepare_municipal_values import prepare
import test_municipal_data as fixtures


class MunicipalIndexTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MunicipalStoreTests()
        self.fixture.setUp()
        self.root = self.fixture.root
        self.path = self.root / 'private' / 'values.sqlite'
        self.preparation = prepare(self.root, self.path)
        self.fast = MunicipalStore(self.root, index_path=self.path)
        self.slow = MunicipalStore(self.root, index_path=self.root / 'absent.sqlite')

    def tearDown(self):
        self.fixture.tearDown()

    def test_equivalent_summaries_profiles_areas_and_all_metrics(self):
        for country in ('AAA', 'BBB'):
            for statistic in ('Mean', 'Median'):
                for metrics in (None, ['plas_em'], ['plas_recy_em'], ['plas_recy_em', 'plas_em']):
                    with self.subTest(country=country, statistic=statistic, metrics=metrics):
                        self.assertEqual(self.fast.country(country, metrics, statistic), self.slow.country(country, metrics, statistic))
        for area in ('North', '__no_admin_1__'):
            self.assertEqual(self.fast.country('AAA', 'plas_em', area=area), self.slow.country('AAA', 'plas_em', area=area))
            self.assertEqual(self.fast.members('AAA', area), self.slow.members('AAA', area))
        for unit_id in ('AAA.1.1_1', 'AAA.2.1_1', 'BBB.1_1'):
            self.assertEqual(self.fast.profile(unit_id, 'Median'), self.slow.profile(unit_id, 'Median'))
        self.assertEqual(self.fast.metadata(), self.slow.metadata())

    def test_index_does_not_load_whole_country_and_retains_only_last_metric(self):
        with patch.object(self.fast, '_load', side_effect=AssertionError('Full country read')):
            self.fast.country('AAA', 'plas_em')
            self.assertEqual(self.fast._metric_cache[0], 'plas_em')
            self.fast.country('AAA', 'plas_recy_em')
            self.assertEqual(self.fast._metric_cache[0], 'plas_recy_em')
            self.assertTrue(all('values' not in row for row in self.fast._country['rows']))
            self.fast.country('BBB', 'plas_em')
            self.assertEqual(self.fast._country_id, 'BBB')
            self.assertEqual(len(self.fast._metric_cache[1]), 1)

    def test_missing_index_uses_verified_original_fallback(self):
        with patch.object(self.slow, '_load', wraps=self.slow._load) as load:
            self.assertEqual(self.slow.country('AAA', 'plas_em'), self.fast.country('AAA', 'plas_em'))
            load.assert_called_once()
        original = self.root / 'BBB.json.gz'
        original.write_bytes(original.read_bytes() + b'bad')
        with self.assertRaises(MunicipalDataError):
            self.slow.country('BBB', 'plas_em')

    def test_changed_source_manifest_rejects_stale_index(self):
        path = self.root / 'manifest.json'
        manifest = json.loads(path.read_bytes())
        manifest['release']['model_year'] = 2021
        path.write_text(json.dumps(manifest), encoding='utf8')
        with self.assertRaisesRegex(MunicipalDataError, 'current release'):
            self.fast.country('AAA', 'plas_em')

    def test_blob_checksum_corruption_is_not_silently_fallback(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE metric_values SET payload=? WHERE country_id='AAA' AND metric_id='plas_em'", (b'corrupt',))
        with patch.object(self.fast, '_load', side_effect=AssertionError('Silent fallback')):
            with self.assertRaisesRegex(MunicipalDataError, 'checksum'):
                self.fast.country('AAA', 'plas_em')

    def test_missing_index_row_or_wrong_summary_dimensions_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("DELETE FROM metric_values WHERE country_id='BBB'")
        with self.assertRaisesRegex(MunicipalDataError, 'incomplete'):
            self.fast.country('BBB', 'plas_em')
        raw = json.dumps([[1, 2, 3]]).encode()
        blob = gzip.compress(raw, mtime=0)
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("UPDATE metric_values SET payload=?,sha256=?,json_bytes=? WHERE country_id='AAA' AND metric_id='plas_em'",
                       (blob, hashlib.sha256(blob).hexdigest(), len(raw)))
        with self.assertRaisesRegex(MunicipalDataError, 'dimensions'):
            self.fast.country('AAA', 'plas_em')

    def test_incomplete_or_unreadable_index_rejected(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute('UPDATE index_info SET complete=0')
        with self.assertRaises(MunicipalDataError):
            self.fast.country('AAA', 'plas_em')
        self.path.write_bytes(b'not a sqlite file')
        with self.assertRaises(MunicipalDataError):
            MunicipalStore(self.root, index_path=self.path).country('AAA', 'plas_em')

    def test_repeat_build_reuses_current_index_and_rebuilds_stale_index(self):
        self.assertFalse(self.preparation['reused'])
        self.assertTrue(prepare(self.root, self.path)['reused'])
        path = self.root / 'manifest.json'
        path.write_bytes(path.read_bytes() + b'\n')
        self.assertFalse(prepare(self.root, self.path)['reused'])
        self.assertEqual(MunicipalStore(self.root, index_path=self.path).country('AAA'), self.slow.country('AAA'))

    def test_build_reuse_checks_missing_rows_and_truncated_database(self):
        with closing(sqlite3.connect(self.path)) as db, db:
            db.execute("DELETE FROM metric_values WHERE country_id='AAA' AND metric_id='plas_em'")
        self.assertFalse(prepare(self.root, self.path)['reused'])
        self.assertEqual(MunicipalStore(self.root, index_path=self.path).country('AAA'), self.slow.country('AAA'))
        self.path.write_bytes(self.path.read_bytes()[:250])
        self.assertFalse(prepare(self.root, self.path)['reused'])
        self.assertTrue(prepare(self.root, self.path)['reused'])

    def test_failed_build_keeps_previous_index_and_removes_only_own_temporary_file(self):
        previous = self.path.read_bytes()
        manifest = self.root / 'manifest.json'
        manifest.write_bytes(manifest.read_bytes() + b'\n')
        other = self.path.with_name('other-builder.building')
        other.write_bytes(b'other builder')
        with patch.object(MunicipalStore, '_load', side_effect=ValueError('fixture source failure')):
            with self.assertRaises(ValueError):
                prepare(self.root, self.path)
        self.assertEqual(self.path.read_bytes(), previous)
        self.assertEqual(other.read_bytes(), b'other builder')
        self.assertEqual(list(self.path.parent.glob(self.path.name + '.*.building')), [])


if __name__ == '__main__':
    unittest.main()
