"""Boundary coverage, geographic integrity and provenance invariants."""
import gzip
import hashlib
import json
import math
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "web" / "assets"
GEOMETRY = json.loads((ASSETS / "world_boundaries.geojson").read_text(encoding="utf-8"))
CROSSWALK = json.loads((ASSETS / "map_crosswalk.json").read_text(encoding="utf-8"))
MANIFEST = json.loads((ASSETS / "map_manifest.json").read_text(encoding="utf-8"))
RESULTS = json.loads((ROOT / "data" / "results.json").read_text(encoding="utf-8"))


class MapGeometryChecks(unittest.TestCase):
    def test_all_source_reporting_entities_have_explicit_coverage(self):
        source_ids = {entity["id"] for entity in RESULTS["entities"]}
        crosswalk_ids = {entity["spot_id"] for entity in CROSSWALK["entities"]}
        self.assertEqual(source_ids, crosswalk_ids)
        self.assertEqual(len(crosswalk_ids), 246)
        self.assertEqual(CROSSWALK["unmatched"], [])
        self.assertEqual(CROSSWALK["summary"]["matched_entities"], 246)
        self.assertEqual(len(GEOMETRY["features"]), 270)
        self.assertEqual(len({f["id"] for f in GEOMETRY["features"]}), 270)
        actual = {}
        for feature in GEOMETRY["features"]:
            key = feature["properties"]["spot_id"]
            if key is not None:
                self.assertIn(key, source_ids)
                actual.setdefault(key, set()).add(feature["id"])
        for row in CROSSWALK["entities"]:
            self.assertEqual(row["status"], "mapped")
            self.assertEqual(set(row["feature_ids"]), actual[row["spot_id"]])

    def test_custom_keys_and_overseas_regions_keep_their_meaning(self):
        features = {f["properties"]["gu_a3"]: f["properties"] for f in GEOMETRY["features"]}
        expected = {"KOS": "XKO", "CYN": "XNC", "WSB": "XAD", "ESB": "XAD", "PFA": "XPI",
                    "NJM": "SJM", "NSV": "SJM", "SOL": "SOM", "SOM": "SOM", "FXX": "FRA",
                    "GLP": "GLP", "GUF": "GUF", "MYT": "MYT", "REU": "REU", "MTQ": "MTQ",
                    "GAZ": "PSE", "WEB": "PSE", "GIB": "GIB"}
        for gu, spot in expected.items():
            self.assertEqual(features[gu]["spot_id"], spot, gu)
        for gu in ["WSB", "ESB", "PFA", "GIB", "CYP", "CYN", "CNM"]:
            self.assertEqual(features[gu]["source_scale"], "10m")
        self.assertIsNone(features["CNM"]["spot_id"])

    def test_geometry_has_finite_closed_rings_and_d3_winding(self):
        def area(ring):
            return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2
        for feature in GEOMETRY["features"]:
            geometry = feature["geometry"]
            self.assertIn(geometry["type"], ["Polygon", "MultiPolygon"])
            polygons = [geometry["coordinates"]] if geometry["type"] == "Polygon" else geometry["coordinates"]
            self.assertTrue(polygons)
            for polygon in polygons:
                self.assertTrue(polygon)
                self.assertLess(area(polygon[0]), 0, feature["id"])
                for hole in polygon[1:]:
                    self.assertGreater(area(hole), 0, feature["id"])
                for ring in polygon:
                    self.assertGreaterEqual(len(ring), 4)
                    self.assertEqual(ring[0], ring[-1])
                    for x, y in ring:
                        self.assertTrue(math.isfinite(x) and math.isfinite(y))
                        self.assertTrue(-180.000001 <= x <= 180.000001 and -90.000001 <= y <= 90.000001)

    def test_manifest_hashes_and_unchanged_statistics(self):
        for filename, metadata in MANIFEST["outputs"].items():
            blob = (ASSETS / filename).read_bytes()
            self.assertEqual(len(blob), metadata["bytes"])
            self.assertEqual(hashlib.sha256(blob).hexdigest(), metadata["sha256"])
        self.assertEqual(gzip.decompress((ASSETS / "world_boundaries.geojson.gz").read_bytes()),
                         (ASSETS / "world_boundaries.geojson").read_bytes())
        self.assertEqual(hashlib.sha256((ROOT / "data" / "results.json").read_bytes()).hexdigest(),
                         MANIFEST["statistical_results_sha256"])
        self.assertFalse(MANIFEST["statistical_results_modified"])
        self.assertEqual(CROSSWALK["source"]["license"], "Public domain")
        self.assertEqual({s["version"] for s in CROSSWALK["source"]["sources"]}, {"5.1.1"})


if __name__ == "__main__":
    unittest.main()
