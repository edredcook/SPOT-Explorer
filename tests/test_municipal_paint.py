"""Synthetic-only projected cache checks; no released vectors in fixtures."""
from contextlib import redirect_stdout
from io import BytesIO, StringIO
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
import zipfile

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import test_municipal_geometry as fixtures
import municipal_geometry as geometry
import municipal_paint as paint


class ProjectedPaint(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.MunicipalGeometry()
        self.fixture.setUp()
        self.addCleanup(self.fixture.doCleanups)
        self.base, self.output = self.fixture.base, self.fixture.output
        self.paint_root = self.output / 'paint'

    def build(self):
        with redirect_stdout(StringIO()):
            return paint.build(self.output, self.paint_root)

    def test_prepared_pixels_selection_and_finest_lookup_match_with_areas_holes_and_dateline(self):
        manifest = self.build()
        self.assertTrue(manifest['complete'])
        self.assertEqual(len(manifest['files']), 14)
        prepared = geometry.GeoStore(self.output)
        self.assertEqual(prepared.paint_store.status, 'ready')
        values = {'TST.1_1': 0, 'TST.2_1': None, 'TST.3_1': -1e-14, 'TST.4_1': 10, 'TST.5_1': 5, 'DAT.1_1': 2}
        for country, area, size, scale, tx, ty, selected in [
                ('TST', None, (400, 400), 400, 200, 200, 'TST.5_1'),
                ('TST', 'East', (400, 400), 400, 200, 200, 'TST.2_1'),
                ('DAT', 'Islands', (400, 200), 1000, 200-1000*np.pi, 100, 'DAT.1_1')]:
            expected = self.fixture.store.render_png(country, values, area, *size, scale, tx, ty, 10)
            with patch('municipal_geometry.projected_feature', side_effect=AssertionError('Cache should supply display shapes')):
                actual = prepared.render_png(country, values, area, *size, scale, tx, ty, 10)
                overlay = prepared.render_selection_png(country, selected, area, *size, scale, tx, ty)
            self.assertEqual(actual, expected)
            self.assertEqual(overlay, self.fixture.store.render_selection_png(country, selected, area, *size, scale, tx, ty))
        self.assertEqual(prepared.inspect('TST', -5, 0), 'TST.1_1')
        self.assertEqual(prepared.inspect('DAT', -179.5, 0), 'DAT.1_1')
        self.assertIsNone(prepared.inspect('TST', 0, -15))

    def test_absent_stale_or_corrupt_cache_uses_canonical_projection_with_bounded_warning(self):
        self.assertEqual(geometry.GeoStore(self.output).paint_store.status, 'missing')
        manifest = self.build()
        manifest['identity']['maximum_latitude'] = 90
        (self.paint_root / 'manifest.json').write_text(json.dumps(manifest))
        with self.assertLogs('municipal_paint', level='WARNING'):
            stale = geometry.GeoStore(self.output)
        self.assertEqual(stale.paint_store.status, 'stale')
        values = {'TST.1_1': 1}
        self.assertEqual(stale.render_png('TST', values, None, 400, 400, 400, 200, 200, 1),
                         self.fixture.store.render_png('TST', values, None, 400, 400, 400, 200, 200, 1))
        manifest = self.build()
        entry = manifest['files']['TST:0.032']
        with (self.paint_root / entry['file']).open('ab') as target:
            target.write(b'corruption')
        prepared = geometry.GeoStore(self.output)
        data = prepared._country('TST')
        with self.assertLogs('municipal_paint', level='WARNING') as logs:
            for _ in range(2):
                data.paint_key, data.paint_features = None, None
                prepared._paint_features(data, None, .032)
        self.assertEqual(len(logs.output), 1)
        self.assertEqual(prepared.paint_store.status, 'degraded')

    def test_malformed_typed_arrays_and_native_assignments_are_rejected_before_use(self):
        manifest = self.build()
        original = manifest['files']['TST:0.001']
        data = self.fixture.store._country('TST')
        expected = paint.assignments(data)
        valid = paint.load_arrays(self.paint_root / original['file'], original, expected)
        for field, change in [
                ('native_ids', lambda a: a.__setitem__(0, 'Wrong ID')),
                ('ring_offsets', lambda a: a.__setitem__(1, 0)),
                ('coordinates', lambda a: a.__setitem__((0, 0), a[0, 0]+.01)),
                ('bounds', lambda a: a.__setitem__((0, 0), a[0, 0]+.01))]:
            arrays = {name: value.copy() for name, value in valid.items()}
            change(arrays[field])
            target = self.base / (field + '.npz')
            np.savez_compressed(target, **arrays)
            entry = {**original, 'bytes': target.stat().st_size, 'sha256': paint.digest(target)}
            with self.assertRaises(ValueError, msg=field):
                paint.load_arrays(target, entry, expected)
        # A rehashed malicious NPY header cannot trigger an oversized allocation.
        target = self.base / 'oversized.npz'
        header = BytesIO()
        np.lib.format.write_array_header_1_0(header, {'descr': '<f8', 'fortran_order': False, 'shape': (10**9, 2)})
        with zipfile.ZipFile(target, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
            for name, value in valid.items():
                output = BytesIO()
                if name == 'coordinates':
                    output.write(header.getvalue())
                else:
                    np.save(output, value, allow_pickle=False)
                archive.writestr(name + '.npy', output.getvalue())
        entry = {**original, 'bytes': target.stat().st_size, 'sha256': paint.digest(target)}
        with patch('numpy.load', side_effect=AssertionError('Preflight must reject before allocation')):
            with self.assertRaises(ValueError):
                paint.load_arrays(target, entry, expected)

    def test_interrupted_build_resumes_without_publishing_partial_ready_manifest(self):
        real = geometry.projected_feature
        source_identity = paint.identity(self.fixture.store.manifest)
        calls = 0
        def interrupted(*args):
            nonlocal calls
            calls += 1
            if calls == 6:
                raise RuntimeError('Synthetic build interruption')
            return real(*args)
        with patch('municipal_geometry.projected_feature', side_effect=interrupted):
            # Identity is derived from real source before the injected failure.
            with patch('municipal_paint.identity', return_value=source_identity):
                with redirect_stdout(StringIO()), self.assertRaises(RuntimeError):
                    paint.build(self.output, self.paint_root)
        self.assertFalse((self.paint_root / 'manifest.json').exists())
        self.assertTrue((self.paint_root / 'progress.json').exists())
        self.assertEqual(paint.PaintStore(self.paint_root, self.fixture.store.manifest).status, 'missing')
        manifest = self.build()
        self.assertTrue(manifest['complete'])
        self.assertEqual(len(manifest['files']), 14)
        self.assertEqual(geometry.GeoStore(self.output).paint_store.status, 'ready')

    def test_geometry_cli_invokes_paint_on_both_prepared_cache_and_fresh_paths(self):
        from scripts import prepare_municipal_geometry as cli
        class Registry(dict):
            def __len__(self):
                return 50702
        result = {'count': 50702, 'countries': {}, 'database': {}}
        for reuse in (True, False):
            arguments = ['prepare', '--source-gpkg', 'unused.gpkg', '--output', str(self.output)]
            if reuse:
                arguments.extend(['--cache-dir', str(self.base / 'cache')])
            with patch.object(sys, 'argv', arguments), patch.object(cli, 'load_registry', return_value=Registry()), \
                    patch.object(cli, 'cache_path', return_value=self.base / 'cache'), \
                    patch.object(cli, 'validated_ready', return_value=reuse), patch.object(cli, 'copy_ready'), \
                    patch.object(cli, 'prepare', return_value=result), patch.object(cli, 'prepare_paint') as prepare_paint:
                with redirect_stdout(StringIO()):
                    cli.main()
                prepare_paint.assert_called_once()

    def test_atomic_manifest_retries_brief_file_lock_and_preserves_old_file_on_failure(self):
        target = self.base / 'atomic.json'
        target.write_text('{"old":true}')
        real_replace, attempts = os.replace, 0
        def brief_lock(source, destination):
            nonlocal attempts
            attempts += 1
            if attempts < 3:
                raise PermissionError('Synthetic sync lock')
            real_replace(source, destination)
        with patch('municipal_paint.os.replace', side_effect=brief_lock), patch('municipal_paint.time.sleep'):
            paint.atomic_json(target, {'new': True})
        self.assertEqual(attempts, 3)
        self.assertEqual(json.loads(target.read_text()), {'new': True})
        with patch('municipal_paint.os.replace', side_effect=PermissionError('Persistent lock')), patch('municipal_paint.time.sleep'):
            with self.assertRaises(PermissionError):
                paint.atomic_json(target, {'partial': True})
        self.assertEqual(json.loads(target.read_text()), {'new': True})


if __name__ == '__main__':
    unittest.main()
