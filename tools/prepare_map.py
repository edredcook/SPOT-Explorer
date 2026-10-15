"""Prepare Natural Earth display boundaries and the explicit SPOT crosswalk.

Only Python's standard library is required. Downloads are pinned by SHA256 and
cached outside the served/tracked assets, under ignored qa-artifacts/map-source.
The SPOT results bundle is read but never rewritten. Run: python tools/prepare_map.py
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import math
import struct
import urllib.request
import zipfile
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "web" / "assets"
CACHE = ROOT / "qa-artifacts" / "map-source"
RETRIEVED = "2026-10-15"
VERSION = "5.1.1"
TERMS_URL = "https://www.naturalearthdata.com/about/terms-of-use/"
SOURCES = {
    "50m": {"url": "https://naciscdn.org/naturalearth/50m/cultural/ne_50m_admin_0_map_units.zip",
            "sha256": "f449ec126985e5aab30aea4b439c2d9eb0c5d40bd722fc1036ad3b6477e25cdd",
            "page": "https://www.naturalearthdata.com/downloads/50m-cultural-vectors/50m-admin-0-details/"},
    "10m": {"url": "https://naciscdn.org/naturalearth/10m/cultural/ne_10m_admin_0_map_units.zip",
            "sha256": "45bebe2aaf8bf42b9daf4428594925bcb11eabd32fe9dc6e0acf681438053eb5",
            "page": "https://www.naturalearthdata.com/downloads/10m-cultural-vectors/10m-admin-0-details/"},
}

# Overrides are semantic matches to named SPOT reporting units, never a merge by
# sovereignty or a transfer of statistical values between SPOT entities.
OVERRIDES = {
    "KOS": ("XKO", "Natural Earth Kosovo matches the release's Kosovo key XKO."),
    "CYN": ("XNC", "Natural Earth Northern Cyprus matches the release's Northern Cyprus key XNC."),
    "ESB": ("XAD", "Dhekelia is one component of the release's combined Akrotiri and Dhekelia reporting entity."),
    "WSB": ("XAD", "Akrotiri is one component of the release's combined Akrotiri and Dhekelia reporting entity."),
    "PFA": ("XPI", "Natural Earth Paracel Islands matches the separately reported release key XPI; its parent ADMIN code is not used."),
    "NJM": ("SJM", "Jan Mayen belongs to the release's combined Svalbard and Jan Mayen reporting entity, not its Norway result."),
    "SOL": ("SOM", "The release's Somalia municipalities include Hargeysa, Boorama, Berbera and Burao. Both Natural Earth Somalia and Somaliland display the same Somalia aggregate."),
}
TEN_M_GU = {"GIB", "WSB", "ESB", "PFA", "CYP", "CYN", "CNM"}
REPLACED_50M_GU = {"CYP", "CYN"}


def digest(blob):
    return hashlib.sha256(blob).hexdigest()


def download(scale, cache):
    source = SOURCES[scale]
    path = cache / source["url"].rsplit("/", 1)[-1]
    if not path.exists():
        request = urllib.request.Request(source["url"], headers={"User-Agent": "SPOT-explorer-map-preparation/1"})
        with urllib.request.urlopen(request, timeout=60) as response:
            blob = response.read()
        if digest(blob) != source["sha256"]:
            raise ValueError(f"Unrecognised {scale} source archive. Review a new version before changing the pinned hash.")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(blob)
    blob = path.read_bytes()
    if digest(blob) != source["sha256"]:
        raise ValueError(f"Cached source checksum differs: {path}")
    return blob


def dbf_rows(blob):
    """Read fixed-width DBF records without a GIS runtime dependency."""
    count, header_length, record_length = struct.unpack_from("<IHH", blob, 4)
    fields, position = [], 32
    while blob[position] != 13:
        field = blob[position:position + 32]
        fields.append((field[:11].split(b"\0")[0].decode("ascii"), field[16]))
        position += 32
    rows = []
    for index in range(count):
        record = blob[header_length + index * record_length:header_length + (index + 1) * record_length]
        if record[0:1] == b"*":
            raise ValueError("Unexpected deleted DBF record")
        offset, row = 1, {}
        for name, width in fields:
            row[name] = record[offset:offset + width].decode("utf-8").rstrip("\0 ")
            offset += width
        rows.append(row)
    return rows


def signed_area(ring):
    return sum(a[0] * b[1] - b[0] * a[1] for a, b in zip(ring, ring[1:])) / 2


def inside(point, ring):
    x, y = point
    result = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y):
            cross_x = (b[0] - a[0]) * (y - a[1]) / (b[1] - a[1]) + a[0]
            if x < cross_x:
                result = not result
    return result


def polygon_geometry(rings):
    """Preserve shapefile clockwise exteriors, as required by D3 spherical paths."""
    outer, holes = [], []
    for ring in rings:
        if ring[0] != ring[-1] or len(ring) < 4:
            raise ValueError("Unclosed or short source ring")
        rounded = [[round(x, 6), round(y, 6)] for x, y in ring]
        if signed_area(rounded) == 0:
            rounded = [[round(x, 9), round(y, 9)] for x, y in ring]
        area = signed_area(rounded)
        if area < 0:
            outer.append([rounded])
        elif area > 0:
            holes.append(rounded)
        else:
            raise ValueError("Zero-area source ring")
    for ring in holes:
        parents = [polygon for polygon in outer if inside(ring[0], polygon[0])]
        if not parents:
            raise ValueError("Source hole is outside all exterior rings")
        min(parents, key=lambda polygon: abs(signed_area(polygon[0]))).append(ring)
    if not outer:
        raise ValueError("Source shape has no exterior")
    return {"type": "Polygon", "coordinates": outer[0]} if len(outer) == 1 else {"type": "MultiPolygon", "coordinates": outer}


def shp_geometries(blob):
    if struct.unpack_from(">I", blob, 0)[0] != 9994 or struct.unpack_from("<I", blob, 32)[0] != 5:
        raise ValueError("Expected a Polygon shapefile")
    geometries, offset = [], 100
    while offset < len(blob):
        length = struct.unpack_from(">I", blob, offset + 4)[0] * 2
        record = blob[offset + 8:offset + 8 + length]
        if struct.unpack_from("<I", record, 0)[0] != 5:
            raise ValueError("Unexpected non-Polygon shape record")
        parts_count, point_count = struct.unpack_from("<II", record, 36)
        parts = list(struct.unpack_from(f"<{parts_count}I", record, 44)) + [point_count]
        start = 44 + parts_count * 4
        points = list(struct.iter_unpack("<dd", record[start:start + point_count * 16]))
        for x, y in points:
            if not math.isfinite(x) or not math.isfinite(y) or not (-180.000001 <= x <= 180.000001 and -90.000001 <= y <= 90.000001):
                raise ValueError("Coordinate outside geographic bounds")
        geometries.append(polygon_geometry([points[a:b] for a, b in zip(parts, parts[1:])]))
        offset += 8 + length
    return geometries


def read_source(scale, cache):
    blob = download(scale, cache)
    prefix = f"ne_{scale}_admin_0_map_units"
    with zipfile.ZipFile(__import__("io").BytesIO(blob)) as archive:
        version = archive.read(prefix + ".VERSION.txt").decode().strip()
        if version != VERSION:
            raise ValueError(f"Unexpected source version: {version}")
        rows = dbf_rows(archive.read(prefix + ".dbf"))
        geometries = shp_geometries(archive.read(prefix + ".shp"))
        if len(rows) != len(geometries):
            raise ValueError("DBF/geometry count differs")
        member_hashes = {name: digest(archive.read(name)) for name in sorted(archive.namelist())}
    return list(zip(rows, geometries)), {"scale": scale, "version": version, "url": SOURCES[scale]["url"],
             "page": SOURCES[scale]["page"], "sha256": digest(blob), "bytes": len(blob),
             "source_feature_count": len(rows), "member_sha256": member_hashes}


def match(row, ids):
    gu = row["GU_A3"]
    if gu in OVERRIDES:
        spot_id, note = OVERRIDES[gu]
        if spot_id not in ids:
            raise ValueError(f"Explicit SPOT key absent: {spot_id}")
        return spot_id, "explicit_named_unit_crosswalk", note
    for field in ["ISO_A3", "ISO_A3_EH"]:
        if row[field] in ids:
            return row[field], f"Natural Earth {field}", None
    return None, "unmapped_geometry", "No corresponding reporting entity in the supplied SPOT release."


def json_bytes(payload, pretty=False):
    return (json.dumps(payload, ensure_ascii=False, allow_nan=False, indent=2 if pretty else None,
                       separators=None if pretty else (",", ":")) + "\n").encode("utf-8")


def build(cache=CACHE, output=ASSETS):
    statistical_path = ROOT / "data" / "results.json"
    results_blob = statistical_path.read_bytes()
    results = json.loads(results_blob)
    entities = {entity["id"]: entity for entity in results["entities"]}
    rows50, provenance50 = read_source("50m", cache)
    rows10, provenance10 = read_source("10m", cache)
    selected = [(row, geometry, "50m") for row, geometry in rows50 if row["GU_A3"] not in REPLACED_50M_GU]
    selected += [(row, geometry, "10m") for row, geometry in rows10 if row["GU_A3"] in TEN_M_GU]
    if {row["GU_A3"] for row, _, scale in selected if scale == "10m"} != TEN_M_GU:
        raise ValueError("A required supplementary/replacement map unit is absent")
    features, mapping = [], {key: [] for key in entities}
    for row, geometry, scale in selected:
        spot_id, method, note = match(row, entities)
        feature_id = row["NE_ID"]
        properties = {"spot_id": spot_id, "name": row["GEOUNIT"], "ne_id": feature_id,
                      "gu_a3": row["GU_A3"], "adm0_a3": row["ADM0_A3"],
                      "iso_a3": row["ISO_A3"], "iso_a3_eh": row["ISO_A3_EH"],
                      "match_method": method, "source_scale": scale, "match_note": note}
        features.append({"type": "Feature", "id": feature_id, "properties": properties, "geometry": geometry})
        if spot_id:
            mapping[spot_id].append({"feature_id": feature_id, "name": row["GEOUNIT"], "gu_a3": row["GU_A3"],
                                     "source_scale": scale, "match_method": method, "note": note})
    features.sort(key=lambda feature: int(feature["id"]))
    if len({feature["id"] for feature in features}) != len(features):
        raise ValueError("Duplicate Natural Earth feature IDs")
    mapped = sum(bool(rows) for rows in mapping.values())
    unmatched = [{"spot_id": key, "name": entity["name"], "reason": "No named/code-matched Natural Earth display unit."}
                 for key, entity in entities.items() if not mapping[key]]
    source = {"name": "Natural Earth Admin 0 map units", "version": VERSION,
              "year": "year not stated", "retrieved_on": RETRIEVED,
              "license": "Public domain", "license_url": TERMS_URL,
              "attribution": "Made with Natural Earth. Public-domain display boundaries.",
              "primary_scale": "1:50,000,000", "supplementary_scale": "1:10,000,000",
              "sources": [provenance50, provenance10]}
    summary = {"total_entities": len(entities), "matched_entities": mapped, "unmatched_entities": len(unmatched),
               "total_features": len(features), "mapped_features": sum(f["properties"]["spot_id"] is not None for f in features),
               "unmapped_features": sum(f["properties"]["spot_id"] is None for f in features),
               "features_by_scale": dict(Counter(f["properties"]["source_scale"] for f in features))}
    notes = [
        "Display boundaries are Natural Earth, not the model's original GADM geometry. These are approximate visual matches, not a new spatial allocation or an exact reconstruction of municipal/model boundaries.",
        "Map units keep separately reported overseas territories apart from their parent state. ISO_A3 is preferred; ISO_A3_EH is used when ISO_A3 is absent. Seven named-unit overrides are explicit in the preparation script and crosswalk.",
        "One SPOT aggregate can colour several map units; its national value is repeated for display and must not be summed across polygons.",
        "50m map units are the base. 10m adds Gibraltar, Akrotiri, Dhekelia and Paracel Islands. Cyprus and Northern Cyprus are replaced with matching 10m units, and the 10m UN buffer zone is retained as neutral background.",
        "Jan Mayen is assigned to SPOT SJM with Svalbard. Natural Earth's Kosovo, Northern Cyprus, Akrotiri/Dhekelia and Paracel units use the corresponding native SPOT X keys.",
        "Somaliland and Somalia both display the SPOT SOM aggregate: source municipality records include Hargeysa (SOM.18.3_1), Boorama, Berbera and Burao. No separate Somaliland result exists in this release.",
        "Natural Earth uses de facto display boundaries. Names and outlines do not imply a position on sovereignty or agreement on territorial status.",
        "Tiny islands can remain difficult to see at world scale; all reporting entities remain available in search and the data table.",
        "Null geometry joins are neutral background, never zero estimates. Statistical zeros and unavailable values continue to come from the unchanged SPOT API.",
    ]
    crosswalk = {"schema_version": 1, "source": source, "summary": summary,
                 "entities": [{"spot_id": key, "name": entity["name"], "status": "mapped" if mapping[key] else "unmapped",
                               "feature_ids": [r["feature_id"] for r in mapping[key]], "map_units": mapping[key],
                               "match_method": sorted({r["match_method"] for r in mapping[key]}),
                               "note": "Same reporting value on each matched unit; not separate statistical observations." if len(mapping[key]) > 1 else None}
                              for key, entity in entities.items()],
                 "unmatched": unmatched,
                 "unmapped_geometry": [{"feature_id": f["id"], "name": f["properties"]["name"], "gu_a3": f["properties"]["gu_a3"]}
                                       for f in features if f["properties"]["spot_id"] is None],
                 "notes": notes}
    geo = {"type": "FeatureCollection", "name": "SPOT national display boundaries", "features": features}
    output.mkdir(parents=True, exist_ok=True)
    geometry_blob = json_bytes(geo)
    (output / "world_boundaries.geojson").write_bytes(geometry_blob)
    (output / "world_boundaries.geojson.gz").write_bytes(gzip.compress(geometry_blob, mtime=0))
    crosswalk_blob = json_bytes(crosswalk, pretty=True)
    (output / "map_crosswalk.json").write_bytes(crosswalk_blob)
    manifest = {"schema_version": 1, "source": source, "summary": summary, "notes": notes,
                "statistical_results_sha256": digest(results_blob), "statistical_results_modified": False,
                "preparation": {"script": "tools/prepare_map.py", "dependencies": "Python standard library only",
                                "coordinate_precision_decimals": 6, "degenerate_rounding_fallback_decimals": 9,
                                "simplification": "None; source vertices retained, coordinates rounded only.",
                                "ring_winding": "Clockwise exterior and counterclockwise holes, matching shapefile and D3 spherical geometry convention. This deliberately differs from RFC 7946's preferred exterior orientation."},
                "outputs": {"world_boundaries.geojson": {"sha256": digest(geometry_blob), "bytes": len(geometry_blob)},
                            "world_boundaries.geojson.gz": {"sha256": digest((output / 'world_boundaries.geojson.gz').read_bytes()), "bytes": (output / 'world_boundaries.geojson.gz').stat().st_size},
                            "map_crosswalk.json": {"sha256": digest(crosswalk_blob), "bytes": len(crosswalk_blob)}}}
    (output / "map_manifest.json").write_bytes(json_bytes(manifest, pretty=True))
    if digest(statistical_path.read_bytes()) != digest(results_blob):
        raise RuntimeError("The statistical source changed during map preparation")
    return manifest


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cache", type=Path, default=CACHE)
    parser.add_argument("--output", type=Path, default=ASSETS)
    args = parser.parse_args()
    manifest = build(args.cache, args.output)
    print(json.dumps({"summary": manifest["summary"], "outputs": manifest["outputs"]}, indent=2))
