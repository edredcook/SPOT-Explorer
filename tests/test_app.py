"""Release and public API contracts, using the packaged published baseline.

No R model is run. The source-workbook hashes and a few independent audited
values anchor this release; the wider checks cover semantics and exports.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app import create_app  # noqa: E402


def reject_nonfinite(value):
    raise AssertionError(f"JSON contains non-finite numeric token: {value}")


BUNDLE_BYTES = (ROOT / "data" / "results.json").read_bytes()
BUNDLE = json.loads(BUNDLE_BYTES, parse_constant=reject_nonfinite)
MANIFEST = json.loads((ROOT / "data" / "manifest.json").read_text(encoding="utf-8"))
FAMILIES = ("processes", "coefficients", "outputs")
QUANTILES = ("5th percentile", "Lower quartile", "Median", "Upper quartile", "95th percentile")


class ReleaseDataTests(unittest.TestCase):
    def test_published_release_identity_and_audited_workbook_hashes(self):
        self.assertEqual(BUNDLE["release"]["version"], "V1.4.1-G-0426")
        self.assertEqual(BUNDLE["release"]["model_year"], 2020)
        self.assertEqual(BUNDLE["release"]["iterations"], 2000)
        self.assertEqual(BUNDLE["release"]["status"], "published")
        self.assertEqual(MANIFEST["sources"]["national"]["sha256"],
                         "37c49dce4cf7564db41fa7835836131b8274de7bcc660a6530534a86780f0e8d")
        self.assertEqual(MANIFEST["sources"]["aggregated"]["sha256"],
                         "faa6dfb2d4057ac02e25b81ed47c61ff3aeb69c462f8f0a5746c0eaf939be2a1")

    def test_derived_file_matches_manifest(self):
        self.assertEqual(hashlib.sha256(BUNDLE_BYTES).hexdigest(), MANIFEST["output"]["sha256"])
        self.assertEqual(len(BUNDLE_BYTES), MANIFEST["output"]["bytes"])

    def test_release_inventory_has_unique_geographies_and_metric_keys(self):
        national_ids = [row["id"] for row in BUNDLE["entities"]]
        group_ids = [row["id"] for row in BUNDLE["groups"]]
        self.assertEqual(len(national_ids), 246)
        self.assertEqual(len(group_ids), 54)
        self.assertEqual(len(set(national_ids + group_ids)), 300)
        self.assertEqual(set(national_ids), set(BUNDLE["national"]))
        self.assertEqual(set(group_ids), set(BUNDLE["aggregated"]))
        metric_keys = [(row["family"], row["id"]) for row in BUNDLE["metrics"]]
        self.assertEqual(len(metric_keys), len(set(metric_keys)))
        self.assertEqual({f: sum(x[0] == f for x in metric_keys) for f in FAMILIES},
                         {"processes": 93, "coefficients": 42, "outputs": 68})
        self.assertEqual(set(BUNDLE["statistics"]), {"Mean", *QUANTILES})

    def test_all_values_are_finite_or_missing_and_quantiles_keep_their_order(self):
        metric_ids = {f: {x["id"] for x in BUNDLE["metrics"] if x["family"] == f} for f in FAMILIES}
        missing = zeros = 0
        for level in ("national", "aggregated"):
            for entity_id, results in BUNDLE[level].items():
                for family in FAMILIES:
                    self.assertEqual(set(results[family]), metric_ids[family], (entity_id, family))
                    for metric_id, stats in results[family].items():
                        self.assertEqual(set(stats), set(BUNDLE["statistics"]))
                        for value in stats.values():
                            if value is None:
                                missing += 1
                            else:
                                self.assertNotIsInstance(value, bool)
                                self.assertIsInstance(value, (int, float))
                                self.assertTrue(math.isfinite(value), (entity_id, family, metric_id))
                                zeros += value == 0
                        quantiles = [stats[q] for q in QUANTILES if stats[q] is not None]
                        self.assertEqual(quantiles, sorted(quantiles), (entity_id, family, metric_id))
        self.assertGreater(missing, 0, "Undefined coefficients must remain missing")
        self.assertGreater(zeros, 0, "Known zero values must remain explicit")

    def test_emission_components_and_per_capita_identity(self):
        geographies = {x["id"]: x for x in BUNDLE["entities"] + BUNDLE["groups"]}
        for level in ("national", "aggregated"):
            for entity_id, results in BUNDLE[level].items():
                outputs = results["outputs"]
                mean = lambda name: outputs[name]["Mean"]
                self.assertTrue(math.isclose(mean("plas_em"), mean("plas_debris_em") + mean("plas_burn_em"),
                                             rel_tol=1e-10, abs_tol=1e-7), entity_id)
                self.assertTrue(math.isclose(mean("plas_debris_em"), mean("rigid_plas_deb_em") + mean("flex_plas_deb_em"),
                                             rel_tol=1e-10, abs_tol=1e-7), entity_id)
                self.assertTrue(math.isclose(mean("plas_burn_em"), mean("rigid_plas_ob_em") + mean("flex_plas_ob_em"),
                                             rel_tol=1e-10, abs_tol=1e-7), entity_id)
                population = geographies[entity_id]["population"]
                self.assertTrue(math.isclose(mean("plas_em_per_cap"), mean("plas_em") * 1000 / population,
                                             rel_tol=1e-10, abs_tol=1e-7), entity_id)


class PublicApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.application = create_app()
        cls.application.config.update(TESTING=True)
        cls.client = cls.application.test_client()

    def get_json(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True)[:500])
        self.assertEqual(response.mimetype, "application/json")
        return response.get_json()

    def csv_rows(self, path):
        response = self.client.get(path)
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True)[:500])
        self.assertEqual(response.mimetype, "text/csv")
        self.assertIn("attachment;", response.headers["Content-Disposition"])
        return list(csv.DictReader(io.StringIO(response.data.decode("utf-8-sig"))))

    def test_readiness_and_metadata(self):
        self.assertEqual(self.get_json("/healthz")["status"], "ok")
        metadata = self.get_json("/api/meta")
        self.assertEqual(metadata["release"], BUNDLE["release"])
        self.assertEqual(len(metadata["entities"]), 246)
        self.assertEqual(len(metadata["groups"]), 54)
        self.assertEqual(len(metadata["metrics"]), 203)
        for metric in metadata["metrics"]:
            self.assertTrue(metric["name"])
            self.assertTrue(metric.get("display_unit") or metric.get("unit"), metric["id"])

    def test_profile_defaults_to_india_and_snapshot_preserves_results(self):
        profile = self.get_json("/api/profile")
        self.assertEqual(profile["entity"]["id"], "IND")
        self.assertEqual(profile["outputs"]["plas_em"]["Mean"], 9415457.11332653)
        self.assertEqual(profile["processes"]["P1"]["Mean"], 285102464.885643)
        snapshot_response = self.client.get("/api/snapshot?entity=GBR")
        self.assertEqual(snapshot_response.status_code, 200)
        self.assertIn("attachment;", snapshot_response.headers["Content-Disposition"])
        snapshot = snapshot_response.get_json()
        self.assertEqual(snapshot["entity"]["id"], "GBR")
        self.assertEqual(snapshot["outputs"], BUNDLE["national"]["GBR"]["outputs"])
        self.assertEqual(snapshot["provenance"], MANIFEST)

    def test_compare_preserves_request_order_and_released_interval(self):
        result = self.get_json("/api/compare?entities=IND,GBR&metric=plas_em&family=outputs&statistic=Mean")
        self.assertEqual([row["id"] for row in result["rows"]], ["IND", "GBR"])
        self.assertEqual(result["rows"][0], {
            "id": "IND", "name": "India", "value": 9415457.11332653,
            "low": 6621534.05738687, "median": 9137082.49465935, "high": 13072935.4562438})
        self.assertEqual(result["rows"][1]["value"], 4589.51625525451)
        fifth = self.get_json("/api/compare?entities=IND&statistic=5th%20percentile")
        self.assertEqual(fifth["rows"][0]["value"], 6621534.05738687)

    def test_compare_and_download_default_selectors_agree(self):
        comparison = self.get_json("/api/compare")
        exported = self.csv_rows("/api/download")
        self.assertEqual([row["id"] for row in comparison["rows"]], ["IND", "CHN", "USA"])
        self.assertEqual([row["entity_id"] for row in exported], ["IND", "CHN", "USA"])
        for api_row, csv_row in zip(comparison["rows"], exported):
            self.assertEqual(float(csv_row["value"]), api_row["value"])
            self.assertEqual(csv_row["family"], "outputs")
            self.assertEqual(csv_row["metric_id"], "plas_em")
            self.assertEqual(csv_row["statistic"], "Mean")
            self.assertEqual(csv_row["release"], "V1.4.1-G-0426")
            self.assertEqual(csv_row["model_year"], "2020")
            self.assertTrue(csv_row["unit"])

    def test_missing_and_zero_remain_distinct_in_json_and_csv(self):
        missing = self.get_json("/api/compare?entities=ABW&family=coefficients&metric=C8")
        self.assertIsNone(missing["rows"][0]["value"])
        missing_csv = self.csv_rows("/api/download?entities=ABW&family=coefficients&metric=C8")
        self.assertEqual(missing_csv[0]["value"], "")
        zero = self.get_json("/api/compare?entities=ABW&family=processes&metric=tP4i&statistic=5th%20percentile")
        self.assertEqual(zero["rows"][0]["value"], 0)
        zero_csv = self.csv_rows("/api/download?entities=ABW&family=processes&metric=tP4i&statistic=5th%20percentile")
        self.assertEqual(float(zero_csv[0]["value"]), 0)
        self.assertNotEqual(zero_csv[0]["value"], "")

    def test_full_country_csv_has_every_statistic_without_recalculation(self):
        rows = self.csv_rows("/api/download?entities=IND&family=all&metric=all&statistic=all")
        self.assertEqual(len(rows), 203 * 6)
        self.assertEqual(set(rows[0]), {"release", "model_year", "entity_id", "entity_name", "family", "metric_id", "metric_name", "statistic", "value", "unit"})
        keys = set()
        for row in rows:
            key = (row["family"], row["metric_id"], row["statistic"])
            self.assertNotIn(key, keys)
            keys.add(key)
            source_value = BUNDLE["national"]["IND"][row["family"]][row["metric_id"]][row["statistic"]]
            self.assertEqual(row["entity_id"], "IND")
            self.assertEqual(None if row["value"] == "" else float(row["value"]), source_value)

    def test_released_world_group_is_served_directly(self):
        profile = self.get_json("/api/profile?entity=world:world")
        self.assertEqual(profile["entity"]["id"], "world:world")
        self.assertEqual(profile["outputs"], BUNDLE["aggregated"]["world:world"]["outputs"])

    def test_invalid_selectors_repeated_arguments_and_unknown_keys_return_400(self):
        thirteen = ",".join(x["id"] for x in BUNDLE["entities"][:13])
        invalid = [
            "/healthz?unknown=1", "/api/meta?entity=IND", "/api/provenance?unknown=1",
            "/api/profile?entity=ZZZ", "/api/profile?entity=", "/api/profile?entity=IND&entity=GBR",
            "/api/profile?entity=IND&metric=plas_em", "/api/snapshot?entity=ZZZ",
            "/api/snapshot?entity=IND&entity=IND", "/api/snapshot?x=1",
            "/api/compare?entities=", "/api/compare?entities=IND,ZZZ", "/api/compare?entities=IND,IND",
            "/api/compare?entities=IND,", "/api/compare?entities=IND&entities=GBR",
            "/api/compare?entities=" + thirteen, "/api/compare?family=invalid",
            "/api/compare?family=processes&metric=plas_em", "/api/compare?metric=unknown",
            "/api/compare?statistic=unknown", "/api/compare?metric=plas_em&metric=P1",
            "/api/compare?family=outputs&family=processes", "/api/compare?statistic=Mean&statistic=Median",
            "/api/compare?format=json", "/api/compare?family=all&metric=all",
            "/api/download?entities=IND,IND", "/api/download?entities=ZZZ",
            "/api/download?entities=IND&entities=GBR", "/api/download?unknown=1",
            "/api/download?family=all&metric=plas_em", "/api/download?statistic=unknown",
            "/api/download?family=unknown&metric=all", "/api/download?metric=unknown",
        ]
        for path in invalid:
            with self.subTest(path=path):
                response = self.client.get(path)
                self.assertEqual(response.status_code, 400, response.get_data(as_text=True)[:300])
                self.assertEqual(response.get_json()["error"]["code"], "invalid_query")
                self.assertTrue(response.get_json()["error"]["message"])

    def test_provenance_and_public_responses_do_not_expose_local_paths(self):
        self.assertEqual(self.get_json("/api/provenance"), MANIFEST)
        for path in ("/api/meta", "/api/provenance", "/api/snapshot?entity=IND"):
            body = self.client.get(path).get_data(as_text=True)
            for private_fragment in ("C:\\Users\\", "C:/Users/", "Dropbox/Edward", ".codex/", "review_20261015"):
                self.assertNotIn(private_fragment, body)

    def test_api_is_read_only_and_has_browser_response_headers(self):
        for path in ("/api/profile", "/api/compare", "/api/download", "/api/snapshot", "/api/provenance"):
            with self.subTest(path=path):
                self.assertEqual(self.client.post(path, json={"entity": "IND"}).status_code, 405)
                response = self.client.get(path)
                self.assertEqual(response.headers["X-Content-Type-Options"], "nosniff")
                self.assertIn("frame-ancestors 'none'", response.headers["Content-Security-Policy"])
        for path in ("/api/run", "/api/upload", "/.env", "/app.py"):
            self.assertEqual(self.client.get(path).status_code, 404)


if __name__ == "__main__":
    unittest.main()
