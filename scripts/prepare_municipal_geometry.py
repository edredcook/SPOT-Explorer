"""Prepare a private, exact-ID municipal raster source from the released GPKG.

Examples:
  python scripts/prepare_municipal_geometry.py --download
  python scripts/prepare_municipal_geometry.py --source-gpkg PATH --registry CSV

No original source or public asset is modified. A completed manifest is
published only after exact-ID coverage, database and source checks pass.
The deployment --download mode also prepares the private per-metric values
index, so the existing service build command installs both runtime assets.
"""
from __future__ import annotations

import argparse
from collections import defaultdict, deque
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import csv
from hashlib import sha256
from io import BytesIO
import json
import os
from pathlib import Path
import shutil
import sqlite3
import struct
import sys
import tempfile
import time
import urllib.request
import uuid
import zipfile
import zlib

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from municipal_geometry import GeoStore, circular_bounds, polygon_parts, unwrap_geometry

SOURCE_URL = 'https://zenodo.org/api/records/22231994/files/MFA_V1.4.1-G-0426.zip/content'
ARCHIVE_BYTES = 1413209305
MEMBER_NAME = 'MFA_V1.4.1-G-0426/05-GISFiles/Municipalities-V1.4.1-G-0426.gpkg'
MEMBER_BYTES, MEMBER_CRC = 985296896, '05ec72c7'
# Filled from the selectively downloaded, CRC-verified released member audit.
SOURCE_SHA256 = '0ea3fbad357266dc3a2598bb1dc5b9f39ace6c5857f468cdee9c3789838aef01'
PREPARATION_VERSION = 1
EMPTY_AREA = '__no_admin_1__'


def digest_file(path):
    digest = sha256()
    with Path(path).open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def remote_range(start, end):
    request = urllib.request.Request(SOURCE_URL, headers={'User-Agent': 'SPOT-Explorer-private-GIS-preparation',
                                    'Accept': '*/*', 'Range': f'bytes={start}-{end}'})
    response = urllib.request.urlopen(request, timeout=90)
    expected = f'bytes {start}-{end}/{ARCHIVE_BYTES}'
    if response.status != 206 or response.headers.get('Content-Range') != expected:
        response.close()
        raise RuntimeError('The release server did not honour the bounded byte range.')
    return response


def download_member(directory):
    """Read only the ZIP directory and the 379 MB compressed municipal member."""
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / Path(MEMBER_NAME).name
    if target.is_file() and target.stat().st_size == MEMBER_BYTES:
        if SOURCE_SHA256 is None or digest_file(target) == SOURCE_SHA256:
            return target
        raise RuntimeError('The existing temporary source checksum does not match the release.')
    tail_start = ARCHIVE_BYTES - 262144
    with remote_range(tail_start, ARCHIVE_BYTES - 1) as response:
        tail = response.read(262145)
    with zipfile.ZipFile(BytesIO(tail)) as archive:
        member = archive.getinfo(MEMBER_NAME)
    if (member.file_size != MEMBER_BYTES or f'{member.CRC:08x}' != MEMBER_CRC or member.compress_type != 8):
        raise RuntimeError('The released municipal member metadata changed.')
    offset = member.header_offset + tail_start
    with remote_range(offset, offset + 29) as response:
        header = response.read(30)
    if header[:4] != b'PK\x03\x04':
        raise RuntimeError('The released member ZIP header could not be verified.')
    name_length, extra_length = struct.unpack_from('<HH', header, 26)
    data_start = offset + 30 + name_length + extra_length
    size = member.compress_size
    cache = directory / 'zip-blocks-22231994'
    cache.mkdir(exist_ok=True)

    def block(position):
        length = min(8 * 1024 * 1024, size - position)
        saved = cache / (str(position) + '.bin')
        if saved.is_file() and saved.stat().st_size == length:
            return saved.read_bytes()
        for attempt in range(5):
            try:
                with remote_range(data_start + position, data_start + position + length - 1) as response:
                    chunks, remaining = [], length
                    while remaining:
                        value = response.read(min(1024 * 1024, remaining))
                        if not value:
                            raise RuntimeError('A released municipal member block is incomplete.')
                        chunks.append(value)
                        remaining -= len(value)
                chunk = b''.join(chunks)
                staging = saved.with_suffix('.part')
                staging.write_bytes(chunk)
                os.replace(staging, saved)
                return chunk
            except Exception:
                if attempt == 4:
                    raise
                print(f'Retrying bounded source block {position} (attempt {attempt + 2}/5)', flush=True)
                time.sleep(min(2 ** attempt, 8))

    partial = target.with_suffix('.gpkg.part')
    received = written = crc = 0
    digest, decoder = sha256(), zlib.decompressobj(-15)
    started = time.monotonic()
    try:
        with partial.open('wb') as output, ThreadPoolExecutor(max_workers=4) as executor:
            pending, next_position = deque(), 0
            for _ in range(4):
                pending.append(executor.submit(block, next_position))
                next_position += 8 * 1024 * 1024
            while pending:
                compressed = pending.popleft().result()
                if next_position < size:
                    pending.append(executor.submit(block, next_position))
                    next_position += 8 * 1024 * 1024
                received += len(compressed)
                raw = decoder.decompress(compressed)
                output.write(raw)
                digest.update(raw)
                written += len(raw)
                crc = zlib.crc32(raw, crc)
                print(f'Municipal source {received / size:.0%}; {time.monotonic() - started:.0f}s', flush=True)
            final = decoder.flush()
            output.write(final)
            digest.update(final)
            crc = zlib.crc32(final, crc)
            written += len(final)
        if written != MEMBER_BYTES or f'{crc & 0xffffffff:08x}' != MEMBER_CRC or not decoder.eof:
            raise RuntimeError('The released source failed its ZIP length/CRC check.')
        if SOURCE_SHA256 is not None and digest.hexdigest() != SOURCE_SHA256:
            raise RuntimeError('The released source SHA-256 check failed.')
        os.replace(partial, target)
        return target
    except BaseException:
        partial.unlink(missing_ok=True)
        raise


def load_registry(path=None, data_root=None):
    if path:
        with Path(path).open(encoding='utf-8-sig', newline='') as stream:
            registry = list(csv.DictReader(stream))
    else:
        from municipal_data import MunicipalStore
        store = MunicipalStore(data_root)
        metadata = store.metadata()
        if not metadata.get('available'):
            raise RuntimeError('Prepare the municipal numeric dataset first or pass --registry CSV.')
        registry = []
        for country in metadata['countries']:
            rows = store.country(country['id'], ['plas_em'], 'Mean')['rows']
            registry.extend({'id': row['id'], 'country_id': country['id'], 'country': country['name'],
                             'name_1': row['admin_names'][0] or ''} for row in rows)
    result = {}
    for row in registry:
        key = row['id']
        if not key or key in result or not row.get('country_id'):
            raise RuntimeError('The native registry contains missing or duplicate IDs.')
        result[key] = row
    return result


def quote(value):
    return '"' + value.replace('"', '""') + '"'


def registry_signature(registry):
    """Bind cached shapes to native IDs and exact country/area membership."""
    rows = [[key, row['country_id'], row.get('name_1') or EMPTY_AREA]
            for key, row in sorted(registry.items())]
    return sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def preparation_identity(registry, tolerance):
    return {'version': PREPARATION_VERSION, 'source_sha256': SOURCE_SHA256,
            'tolerance_degrees': tolerance, 'registry_sha256': registry_signature(registry)}


def cache_path(cache_root, registry, tolerance):
    identity = preparation_identity(registry, tolerance)
    key = sha256(json.dumps(identity, sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    return Path(cache_root).expanduser().resolve() / key


def validated_ready(directory, registry, tolerance):
    """Recheck database bytes and every native assignment before cache reuse."""
    directory = Path(directory).resolve()
    store = GeoStore(directory)
    manifest = store.manifest
    if (not manifest or manifest.get('count') != len(registry) or
            manifest.get('preparation') != preparation_identity(registry, tolerance) or
            manifest.get('source', {}).get('sha256') != SOURCE_SHA256):
        return None
    expected = {key: (row['country_id'], row.get('name_1') or EMPTY_AREA) for key, row in registry.items()}
    try:
        with closing(sqlite3.connect((directory / 'geometry.sqlite').as_uri() + '?mode=ro', uri=True)) as database:
            actual = {key: (country, area) for key, country, area in database.execute('SELECT native_id,country,area FROM features')}
            count = database.execute('SELECT COUNT(*) FROM features').fetchone()[0]
        if count != len(registry) or actual != expected:
            return None
        expected_countries = defaultdict(int)
        expected_areas = defaultdict(int)
        for country, area in expected.values():
            expected_countries[country] += 1
            expected_areas[(country, area)] += 1
        if {key: value['count'] for key, value in manifest['countries'].items()} != dict(expected_countries):
            return None
        actual_areas = {(country, area['id']): area['count'] for country, value in manifest['countries'].items() for area in value['areas']}
        return manifest if actual_areas == dict(expected_areas) else None
    except (OSError, sqlite3.Error, KeyError, TypeError):
        return None


def copy_ready(source, destination):
    """Copy only prepared files; publish the matching manifest last."""
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination:
        return
    destination.mkdir(parents=True, exist_ok=True)
    token = uuid.uuid4().hex
    database = destination / ('.copy-' + token + '.sqlite')
    manifest = destination / ('.copy-' + token + '.json')
    try:
        shutil.copyfile(source / 'geometry.sqlite', database)
        shutil.copyfile(source / 'manifest.json', manifest)
        os.replace(database, destination / 'geometry.sqlite')
        os.replace(manifest, destination / 'manifest.json')
    finally:
        database.unlink(missing_ok=True)
        manifest.unlink(missing_ok=True)


def gpkg_wkb(blob):
    if blob[:2] != b'GP' or len(blob) < 8 or blob[2] != 0:
        raise RuntimeError('Unsupported GeoPackage geometry header.')
    envelope = (blob[3] >> 1) & 7
    lengths = {0: 0, 1: 32, 2: 48, 3: 48, 4: 64}
    if envelope not in lengths:
        raise RuntimeError('Unsupported GeoPackage geometry envelope.')
    return blob[8 + lengths[envelope]:]


def prepare(source, registry, output, *, tolerance=0.001, verify_release=True):
    from shapely import from_wkb, make_valid, to_wkb
    from shapely.geometry import MultiPolygon
    if not 0 <= tolerance <= 0.01:
        raise ValueError('Use a display simplification tolerance between zero and 0.01 degrees.')
    source, output = Path(source).resolve(), Path(output).resolve()
    source_hash = digest_file(source)
    if verify_release and (source.stat().st_size != MEMBER_BYTES or (SOURCE_SHA256 and source_hash != SOURCE_SHA256)):
        raise RuntimeError('The source GeoPackage does not match the pinned released municipal layer.')
    with closing(sqlite3.connect(source.as_uri() + '?mode=ro', uri=True)) as original:
        original.row_factory = sqlite3.Row
        layers = original.execute('SELECT * FROM gpkg_geometry_columns').fetchall()
        if len(layers) != 1 or layers[0]['srs_id'] != 4326:
            raise RuntimeError('Expected one released WGS84 municipal polygon layer.')
        table, geometry_column = layers[0]['table_name'], layers[0]['column_name']
        fields = [row['name'] for row in original.execute('PRAGMA table_info(' + quote(table) + ')')]
        candidates = [field for field in fields if field.lower().replace('_', '') in {'uniqueid', 'uniqueidentifier'}]
        if len(candidates) != 1:
            raise RuntimeError('The native unique-ID geometry field could not be identified unambiguously: ' + repr(fields))
        key_field = candidates[0]
        keys = [row[0] for row in original.execute('SELECT ' + quote(key_field) + ' FROM ' + quote(table))]
        if len(keys) != len(set(keys)) or set(keys) != set(registry):
            missing, extra = sorted(set(registry) - set(keys)), sorted(set(keys) - set(registry))
            raise RuntimeError(f'Exact native-ID geometry join failed: {len(missing)} missing; {len(extra)} extra; {len(keys) - len(set(keys))} duplicate geometries.')
        output.mkdir(parents=True, exist_ok=True)
        temporary = output / ('.prepare-' + uuid.uuid4().hex + '.sqlite')
        countries, area_bounds = {}, defaultdict(list)
        repaired, unsimplified = [], []
        counts = defaultdict(int)
        try:
            with closing(sqlite3.connect(temporary)) as prepared:
                prepared.execute('PRAGMA journal_mode=OFF')
                prepared.execute('PRAGMA synchronous=OFF')
                prepared.execute('PRAGMA cache_size=-8192')
                prepared.execute('CREATE TABLE features(native_id TEXT PRIMARY KEY,country TEXT NOT NULL,area TEXT NOT NULL,geom BLOB NOT NULL)')
                sql = 'SELECT ' + quote(key_field) + ',' + quote(geometry_column) + ' FROM ' + quote(table)
                for index, (native_id, blob) in enumerate(original.execute(sql)):
                    row = registry[native_id]
                    geometry = from_wkb(gpkg_wkb(blob))
                    geometry = unwrap_geometry(geometry)
                    if not geometry.is_valid:
                        repaired.append(native_id)
                        parts = polygon_parts(make_valid(geometry))
                        geometry = parts[0] if len(parts) == 1 else MultiPolygon(parts)
                    simplified = geometry.simplify(tolerance, preserve_topology=True)
                    if simplified.is_empty or not simplified.is_valid or not polygon_parts(simplified):
                        # GEOS can still create nested shells between simplified
                        # multipolygon parts. Preserve this unit's valid shape.
                        unsimplified.append(native_id)
                    else:
                        geometry = simplified
                    if geometry.is_empty or not geometry.is_valid or not polygon_parts(geometry):
                        raise RuntimeError('A municipal geometry could not be prepared: ' + native_id)
                    country, area = row['country_id'], row.get('name_1') or EMPTY_AREA
                    prepared.execute('INSERT INTO features VALUES(?,?,?,?)', (native_id, country, area, to_wkb(geometry)))
                    entry = countries.setdefault(country, {'name': row.get('country') or country, 'count': 0, 'areas': []})
                    entry['count'] += 1
                    for part in polygon_parts(geometry):
                        area_bounds[(country, area)].append(part.bounds)
                    counts[(country, area)] += 1
                    if (index + 1) % 5000 == 0:
                        print(f'Prepared {index + 1:,}/{len(registry):,} native municipal polygons', flush=True)
                prepared.execute('CREATE INDEX feature_country ON features(country)')
                prepared.execute('CREATE INDEX feature_area ON features(country,area)')
                prepared.commit()
                if prepared.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
                    raise RuntimeError('The prepared geometry database failed its integrity check.')
            for (country, area), bounds in area_bounds.items():
                countries[country]['areas'].append({'id': area, 'name': None if area == EMPTY_AREA else area,
                                                   'count': counts[(country, area)], 'bounds': circular_bounds(bounds)})
            for country, entry in countries.items():
                entry['bounds'] = circular_bounds(b for (code, _), values in area_bounds.items() if code == country for b in values)
                entry['wraps_antimeridian'] = entry['bounds'][0] > entry['bounds'][2]
            manifest = {'schema': 1, 'count': len(registry), 'countries': countries,
                        'preparation': preparation_identity(registry, tolerance),
                        'database': {'bytes': temporary.stat().st_size, 'sha256': digest_file(temporary)},
                        'source': {'doi': '10.5281/zenodo.22231994', 'version': 'V1.4.1-G-0426', 'year': 2020,
                                   'model_year': 2020, 'release_publication_date': '2026-09-14',
                                   'url': 'https://zenodo.org/records/22231994',
                                   'archive_member': MEMBER_NAME, 'sha256': source_hash,
                                   'bytes': source.stat().st_size, 'geometry_table': table, 'native_id_field': key_field,
                                   'provenance': 'GADM3.6-derived released SPOT municipal boundaries',
                                   'license_notice': 'Source vectors retained privately; GADM redistribution restrictions apply.'},
                        'simplification': {'tolerance_degrees': tolerance, 'preserve_topology': True,
                                           'repaired_invalid_native_ids': repaired,
                                           'kept_unsimplified_native_ids': unsimplified,
                                           'purpose': 'Raster display and approximate click identification; source geometry is preserved.'}}
            manifest_temp = output / ('.manifest-' + uuid.uuid4().hex + '.json')
            manifest_temp.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
            os.replace(temporary, output / 'geometry.sqlite')
            os.replace(manifest_temp, output / 'manifest.json')
            return manifest
        finally:
            temporary.unlink(missing_ok=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-gpkg', type=Path)
    parser.add_argument('--download', action='store_true', help='Selectively fetch the released municipal GPKG member.')
    parser.add_argument('--registry', type=Path)
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--output', type=Path, default=ROOT / '.runtime' / 'municipal')
    parser.add_argument('--tolerance', type=float, default=0.001)
    parser.add_argument('--cache-dir', type=Path, help='Prepared-only cache; defaults beneath XDG_CACHE_HOME for --download.')
    args = parser.parse_args()
    if args.download and args.registry is None:
        from scripts.prepare_municipal_values import prepare as prepare_values
        print('Preparing the private per-metric municipal values index.', flush=True)
        print(json.dumps(prepare_values(data_root=args.data_root), indent=2), flush=True)
    registry = load_registry(args.registry, args.data_root)
    if len(registry) != 50702:
        parser.error('The released registry must contain exactly 50,702 native IDs.')
    cache_root = args.cache_dir
    if cache_root is None and args.download:
        cache_root = Path(os.environ.get('XDG_CACHE_HOME') or Path.home() / '.cache') / 'spot-explorer' / 'municipal'
    cached = cache_path(cache_root, registry, args.tolerance) if cache_root else None
    if cached and validated_ready(cached, registry, args.tolerance):
        copy_ready(cached, args.output)
        print('Reused verified private municipal geometry cache.', flush=True)
        return
    if args.source_gpkg:
        source = args.source_gpkg
    elif args.download:
        source = download_member(Path(tempfile.gettempdir()) / 'spot_gis_audit_20261016')
    else:
        parser.error('Pass --source-gpkg PATH or --download.')
    result = prepare(source, registry, args.output, tolerance=args.tolerance)
    if cached:
        try:
            copy_ready(args.output, cached)
            if not validated_ready(cached, registry, args.tolerance):
                raise RuntimeError('The copied cache did not pass validation.')
            print('Saved verified prepared-only municipal geometry cache.', flush=True)
        except (OSError, RuntimeError):
            # A build remains valid when the host offers no persistent cache.
            print('Prepared geometry is ready; the optional cache could not be saved.', flush=True)
    print(json.dumps({'count': result['count'], 'countries': len(result['countries']), 'database': result['database']}, indent=2), flush=True)


if __name__ == '__main__':
    main()
