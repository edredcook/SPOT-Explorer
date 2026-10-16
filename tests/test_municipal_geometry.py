"""Synthetic polygons only: no released or third-party vectors in fixtures."""
from __future__ import annotations

from io import BytesIO
from contextlib import closing
import json
import math
from pathlib import Path
import sqlite3
import struct
import sys
import tempfile
import unittest
from unittest.mock import patch

from PIL import Image
from shapely import to_wkb
from shapely.geometry import MultiPolygon, Polygon, box
from shapely.geometry.base import BaseGeometry

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from municipal_geometry import (GeoStore, MISSING_COLOUR, ZERO_COLOUR, colour,
                                 circular_bounds, paint_tolerance, palette_for,
                                 project, project_ring)
from scripts.prepare_municipal_geometry import (cache_path, copy_ready, digest_file,
                                               prepare, validated_ready)


class MunicipalGeometry(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.base = Path(self.temporary.name)
        self.source = self.base / 'synthetic.gpkg'
        self.output = self.base / 'private'
        self.registry = {}
        polygons = [
            ('TST.1_1', 'TST', 'West', box(-10, -5, 0, 5)),
            ('TST.2_1', 'TST', 'East', box(0, -5, 10, 5)),
            ('TST.3_1', 'TST', 'West', box(-10, 10, 0, 20)),
            ('TST.4_1', 'TST', 'East', box(0, 10, 10, 20)),
            ('TST.5_1', 'TST', 'South', Polygon([(-10,-20),(10,-20),(10,-10),(-10,-10),(-10,-20)],
                                              [[(-2,-18),(-2,-12),(2,-12),(2,-18),(-2,-18)]])),
            ('DAT.1_1', 'DAT', 'Islands', Polygon([(179,-5),(-179,-5),(-179,5),(179,5),(179,-5)])),
        ]
        with closing(sqlite3.connect(self.source)) as connection:
            connection.execute('CREATE TABLE gpkg_geometry_columns(table_name TEXT,column_name TEXT,geometry_type_name TEXT,srs_id INTEGER,z INTEGER,m INTEGER)')
            connection.execute("INSERT INTO gpkg_geometry_columns VALUES('synthetic','geom','POLYGON',4326,0,0)")
            connection.execute('CREATE TABLE synthetic(Unique_ID TEXT,geom BLOB)')
            for native_id, country, area, geometry in polygons:
                self.registry[native_id] = {'id': native_id, 'country_id': country, 'country': 'Synthetic ' + country, 'name_1': area}
                header = b'GP\x00\x01' + struct.pack('<i', 4326)
                connection.execute('INSERT INTO synthetic VALUES(?,?)', (native_id, header + to_wkb(geometry)))
            connection.commit()
        prepare(self.source, self.registry, self.output, tolerance=0, verify_release=False)
        self.store = GeoStore(self.output)

    def test_projection_matches_d3_mercator_coordinates_and_clips_poles(self):
        x, y = project(0, 0, 100, 200, 200)
        self.assertAlmostEqual(x, 200)
        self.assertAlmostEqual(y, 200)
        x, y = project(90, 45, 100, 200, 200)
        self.assertAlmostEqual(x, 200 + 50 * math.pi)
        self.assertAlmostEqual(y, 200 - 100 * math.log(math.tan(3 * math.pi / 8)))
        self.assertEqual(project(0, 90, 1, 0, 0), project(0, 85.0511287798066, 1, 0, 0))

    def test_native_id_hits_holes_and_exact_area_membership(self):
        self.assertEqual(self.store.inspect('TST', -5, 0), 'TST.1_1')
        self.assertEqual(self.store.inspect('TST', 5, 15), 'TST.4_1')
        self.assertIsNone(self.store.inspect('TST', -5, 0, 'East'))
        self.assertIsNone(self.store.inspect('TST', 0, -15))
        self.assertIsNone(self.store.inspect('TST', 80, 0))
        self.assertEqual(self.store.metadata('TST')['count'], 5)
        self.assertEqual({row['id']: row['count'] for row in self.store.metadata('TST')['areas']}, {'West': 2, 'East': 2, 'South': 1})

    def test_png_preserves_missing_zero_negative_and_positive_colours(self):
        values = {'TST.1_1': 0, 'TST.2_1': None, 'TST.3_1': -1e-14, 'TST.4_1': 10, 'TST.5_1': {'value': 5}}
        image = Image.open(BytesIO(self.store.render_png('TST', values, None, 400, 400, 400, 200, 200, 10)))
        def pixel(lon, lat):
            x, y = project(lon, lat, 400, 200, 200)
            return image.getpixel((round(x), round(y)))
        self.assertEqual(pixel(-5, 0), ZERO_COLOUR)
        self.assertEqual(pixel(5, 0), MISSING_COLOUR)
        self.assertEqual(pixel(-5, 15), colour(-1e-14, 10))
        self.assertNotEqual(pixel(-5, 15), ZERO_COLOUR)
        self.assertEqual(pixel(5, 15), colour(10, 10))
        self.assertEqual(pixel(0, -15)[3], 0)
        self.assertEqual(colour(float('nan'), 10), MISSING_COLOUR)
        filtered = Image.open(BytesIO(self.store.render_png('TST', values, 'East', 400, 400, 400, 200, 200, 10)))
        x, y = project(-5, 0, 400, 200, 200)
        self.assertEqual(filtered.getpixel((round(x), round(y)))[3], 0)
        self.assertEqual(values['TST.3_1'], -1e-14)

    def test_antimeridian_bounds_rendering_and_hit_detection(self):
        bounds = self.store.metadata('DAT')['bounds']
        self.assertEqual(bounds, [179, -5, -179, 5])
        self.assertEqual(self.store.inspect('DAT', 179.5, 0), 'DAT.1_1')
        self.assertEqual(self.store.inspect('DAT', -179.5, 0), 'DAT.1_1')
        self.assertIsNone(self.store.inspect('DAT', 0, 0))
        image = Image.open(BytesIO(self.store.render_png('DAT', {'DAT.1_1': 1}, None, 400, 200, 1000, 200 - 1000 * math.pi, 100, 1)))
        self.assertNotEqual(image.getpixel((200, 100))[3], 0)
        self.assertEqual(circular_bounds([(-10,-5,10,5)]), [-10,-5,10,5])

    def test_missing_corrupt_and_mismatched_assets_fail_closed(self):
        missing = GeoStore(self.base / 'absent')
        self.assertFalse(missing.metadata()['available'])
        with self.assertRaises(FileNotFoundError):
            missing.inspect('TST', 0, 0)
        with (self.output / 'geometry.sqlite').open('ab') as stream:
            stream.write(b'corruption')
        corrupted = GeoStore(self.output)
        self.assertFalse(corrupted.metadata('TST')['available'])
        with self.assertRaises(FileNotFoundError):
            corrupted.render_png('TST', {}, None, 100, 100, 1, 0, 0, 1)
        self.assertFalse(self.store.metadata('XXX')['available'])
        with self.assertRaises(ValueError):
            self.store.render_png('TST', {}, None, 2001, 100, 1, 0, 0, 1)

    def test_registry_mismatch_does_not_publish_ready_manifest(self):
        registry = dict(self.registry)
        registry['unmatched-native-id'] = {'id':'unmatched-native-id','country_id':'TST'}
        target = self.base / 'unpublished'
        with self.assertRaisesRegex(RuntimeError, 'Exact native-ID geometry join failed'):
            prepare(self.source, registry, target, verify_release=False)
        self.assertFalse((target / 'manifest.json').exists())

    def test_invalid_simplification_preserves_the_valid_native_shape(self):
        invalid = MultiPolygon([box(0, 0, 10, 10), box(2, 2, 4, 4)])
        self.assertFalse(invalid.is_valid)
        with patch.object(BaseGeometry, 'simplify', return_value=invalid):
            manifest = prepare(self.source, self.registry, self.output, verify_release=False)
        self.assertEqual(set(manifest['simplification']['kept_unsimplified_native_ids']), set(self.registry))
        self.assertEqual(GeoStore(self.output).inspect('TST', -5, 0), 'TST.1_1')

    def test_prepared_cache_validates_hash_native_ids_and_exact_area_membership(self):
        with patch('scripts.prepare_municipal_geometry.SOURCE_SHA256', digest_file(self.source)):
            prepare(self.source, self.registry, self.output, verify_release=False)
            cached = cache_path(self.base / 'cache', self.registry, .001)
            copy_ready(self.output, cached)
            self.assertIsNotNone(validated_ready(cached, self.registry, .001))
            restored = self.base / 'restored'
            copy_ready(cached, restored)
            self.assertEqual(GeoStore(restored).inspect('DAT', -179.5, 0), 'DAT.1_1')
            changed = {key: dict(row) for key, row in self.registry.items()}
            changed['TST.1_1']['name_1'] = 'Wrong area'
            self.assertIsNone(validated_ready(cached, changed, .001))
            self.assertNotEqual(cache_path(self.base / 'cache', changed, .001), cached)
            self.assertIsNone(validated_ready(cached, self.registry, .002))
            with (cached / 'geometry.sqlite').open('ab') as stream:
                stream.write(b'corruption')
            self.assertIsNone(validated_ready(cached, self.registry, .001))

    def test_adaptive_paint_keeps_one_lod_and_area_without_changing_lookup(self):
        self.assertEqual(paint_tolerance(1, 100, 200), .064)
        self.assertEqual(paint_tolerance(1e8, 100, 200), .001)
        values = {key: 1 for key in self.registry}
        self.store.render_png('TST', values, None, 400, 400, 100, 200, 200, 1)
        data = self.store._country('TST')
        finest = data.features[0][2]
        first = data.paint_features
        self.assertEqual(len(first), 5)
        self.store.render_png('TST', values, None, 400, 400, 100, 210, 200, 1)
        self.assertIs(data.paint_features, first)
        self.store.render_png('TST', values, 'East', 400, 400, 1e8, 200, 200, 1)
        self.assertEqual(data.paint_key, ('East', .001))
        self.assertEqual({row[0] for row in data.paint_features}, {'TST.2_1', 'TST.4_1'})
        self.assertIs(data.features[0][2], finest)
        self.assertEqual(self.store.inspect('TST', -5, 0), 'TST.1_1')
        self.assertIn('adaptive_paint', self.store.metadata()['simplification'])

    def test_vector_projection_and_palette_match_scalar_reference(self):
        import numpy as np
        coordinates = [(0, 0), (-179.9, -90), (190, 90), (32, 45), (14, -61)]
        expected = [project(x, y, 1, 0, 0) for x, y in coordinates]
        np.testing.assert_allclose(project_ring(coordinates), expected, atol=1e-14, rtol=1e-14)
        self.assertFalse(project_ring(coordinates).flags.writeable)
        samples = [None, False, math.nan, math.inf, -1e-14, 0, {'value': 3}, {'value': None}]
        samples += [math.expm1(t * math.log(101)) / 100 * 1000 for t in np.linspace(0, 1, 1001)]
        ids = [str(index) for index in range(len(samples))]
        values = dict(zip(ids, samples))
        actual = palette_for(ids, values, 1000)
        self.assertEqual(tuple(actual[0]), (0, 0, 0, 0))
        self.assertEqual([tuple(row) for row in actual[1:]], [colour(value, 1000) for value in samples])

    def test_raster_reuses_geometry_across_values_but_invalidates_viewport(self):
        values = {key: 1 for key in self.registry}
        first = self.store.render_png('TST', values, None, 400, 400, 400, 200, 200, 1)
        data = self.store._country('TST')
        raster = data.raster
        self.assertFalse(raster[0].flags.writeable)
        self.assertLessEqual(raster[0].nbytes, 400 * 400 * 4)
        values['TST.1_1'] = None
        changed = self.store.render_png('TST', values, None, 400, 400, 400, 200, 200, 1)
        self.assertIs(data.raster, raster)
        self.assertNotEqual(first, changed)
        image = Image.open(BytesIO(changed))
        x, y = project(-5, 0, 400, 200, 200)
        self.assertEqual(image.getpixel((round(x), round(y))), MISSING_COLOUR)
        self.store.render_png('TST', values, None, 400, 400, 400, 210, 200, 1)
        self.assertIsNot(data.raster, raster)
        self.store.render_png('TST', values, 'East', 400, 400, 400, 210, 200, 1)
        self.assertEqual(set(data.raster[1]), {'TST.2_1', 'TST.4_1'})
        self.store.render_png('DAT', values, None, 400, 400, 400, 210, 200, 1)
        self.assertEqual(list(self.store.cache), ['DAT'])

    def test_label_raster_preserves_underlying_units_in_holes_and_overlap_order(self):
        # Synthetic overlap: a lower unit stays visible inside a later unit's
        # hole, while the later outer fill replaces it everywhere else.
        native_id = 'TST.0_1'
        lower = box(-8, -18, 8, -12)
        self.registry[native_id] = {'id': native_id, 'country_id': 'TST', 'country': 'Synthetic TST', 'name_1': 'South'}
        with closing(sqlite3.connect(self.source)) as connection:
            header = b'GP\x00\x01' + struct.pack('<i', 4326)
            connection.execute('INSERT INTO synthetic VALUES(?,?)', (native_id, header + to_wkb(lower)))
            connection.commit()
        prepare(self.source, self.registry, self.output, tolerance=0, verify_release=False)
        store = GeoStore(self.output)
        values = {native_id: 10, 'TST.5_1': 5}
        image = Image.open(BytesIO(store.render_png('TST', values, 'South', 400, 400, 400, 200, 200, 10)))
        def pixel(lon, lat):
            x, y = project(lon, lat, 400, 200, 200)
            return image.getpixel((round(x), round(y)))
        self.assertEqual(pixel(0, -15), colour(10, 10))
        self.assertEqual(pixel(-5, -15), colour(5, 10))
        self.assertEqual(pixel(0, -5)[3], 0)


if __name__ == '__main__':
    unittest.main()
