"""Private, version-bound projected map shapes. Never serve these files.

Build-time GIS work is stored as plain typed arrays. Runtime accepts only the
exact finest-source identity and native assignments, and uses source geometry
when the optional cache is absent, stale or fails validation.
"""
from __future__ import annotations

from hashlib import sha256
import inspect
import json
import logging
import math
import os
from pathlib import Path
import shutil
import struct
import time
import uuid
import zipfile
import zlib

import numpy as np

SCHEMA = 'spot-private-projected-paint/v1'
LODS = (.001, .002, .004, .008, .016, .032, .064)
MAX_RAW_BYTES = 128 * 1024 * 1024
FIELDS = {'coordinates', 'bounds', 'ring_offsets', 'polygon_offsets',
          'feature_offsets', 'native_ids', 'area_names', 'area_indices'}
LOGGER = logging.getLogger(__name__)
CACHE_ERRORS = (OSError, ValueError, KeyError, TypeError, IndexError, OverflowError,
                zipfile.BadZipFile, EOFError, struct.error, zlib.error, RuntimeError)


def digest(path):
    result = sha256()
    with Path(path).open('rb') as source:
        for block in iter(lambda: source.read(1024 * 1024), b''):
            result.update(block)
    return result.hexdigest()


def identity(manifest):
    import shapely
    import municipal_geometry as geometry
    functions = (geometry.projected_feature, geometry.project_ring,
                 geometry.paint_tolerance, geometry.polygon_parts)
    implementation = ''.join(inspect.getsource(function) for function in functions)
    return {'schema': SCHEMA, 'finest_database_sha256': manifest['database']['sha256'],
            'finest_preparation': manifest.get('preparation'),
            'projection_source_sha256': sha256(implementation.encode()).hexdigest(),
            'maximum_latitude': geometry.MAX_LATITUDE, 'numpy_version': np.__version__,
            'shapely_version': shapely.__version__, 'geos_version': shapely.geos_version_string}


def assignments(data):
    return [(native_id, area) for native_id, area, _ in data.features]


def assignment_digest(rows):
    return sha256(json.dumps(rows, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def pack(paint, native_assignments):
    areas = dict(native_assignments)
    coordinates, bounds = [], []
    ring_offsets, polygon_offsets, feature_offsets = [0], [0], [0]
    native_ids, area_names, area_indices = [], [], []
    for native_id, polygons in paint:
        native_ids.append(native_id)
        area = areas[native_id]
        if area not in area_names:
            area_names.append(area)
        area_indices.append(area_names.index(area))
        for rings, polygon_bounds in polygons:
            for ring in rings:
                coordinates.append(ring)
                ring_offsets.append(ring_offsets[-1] + len(ring))
            polygon_offsets.append(len(ring_offsets) - 1)
            bounds.append(polygon_bounds)
        feature_offsets.append(len(polygon_offsets) - 1)
    return {'coordinates': np.concatenate(coordinates).astype('<f8', copy=False),
            'bounds': np.asarray(bounds, dtype='<f8'),
            'ring_offsets': np.asarray(ring_offsets, dtype='<u8'),
            'polygon_offsets': np.asarray(polygon_offsets, dtype='<u8'),
            'feature_offsets': np.asarray(feature_offsets, dtype='<u8'),
            'native_ids': np.asarray(native_ids, dtype='U'),
            'area_names': np.asarray(area_names, dtype='U'),
            'area_indices': np.asarray(area_indices, dtype='<u4')}


def preflight(path, entry):
    """Reject excessive NPY allocation claims before NumPy allocates arrays."""
    expected_bytes = entry['bytes']
    raw_bytes = entry['raw_array_bytes']
    if (type(expected_bytes) is not int or type(raw_bytes) is not int or
            not 0 < expected_bytes <= MAX_RAW_BYTES or not 0 < raw_bytes <= MAX_RAW_BYTES or
            path.stat().st_size != expected_bytes or digest(path) != entry['sha256']):
        raise ValueError('Projected cache checksum or size mismatch.')
    total = 0
    with zipfile.ZipFile(path) as archive:
        if len(archive.infolist()) != len(FIELDS) or set(archive.namelist()) != {field + '.npy' for field in FIELDS}:
            raise ValueError('Unexpected projected cache fields.')
        for item in archive.infolist():
            if item.file_size > MAX_RAW_BYTES + 10000 or item.compress_type not in (0, 8):
                raise ValueError('Excessive projected cache member size.')
            with archive.open(item) as source:
                version = np.lib.format.read_magic(source)
                if version == (1, 0):
                    shape, fortran, dtype = np.lib.format.read_array_header_1_0(source, max_header_size=10000)
                elif version == (2, 0):
                    shape, fortran, dtype = np.lib.format.read_array_header_2_0(source, max_header_size=10000)
                else:
                    raise ValueError('Unsupported projected array format.')
                size = math.prod(shape) * dtype.itemsize
                if (dtype.hasobject or fortran or len(shape) not in (1, 2) or
                        any(type(dimension) is not int or dimension < 0 for dimension in shape) or
                        size > MAX_RAW_BYTES or source.tell() + size != item.file_size):
                    raise ValueError('Invalid projected array allocation claim.')
                total += size
        if total != raw_bytes:
            raise ValueError('Projected raw-array size mismatch.')


def load_arrays(path, entry, expected_assignments):
    preflight(path, entry)
    with np.load(path, allow_pickle=False, max_header_size=10000) as bundle:
        arrays = {name: bundle[name] for name in FIELDS}
    xy, bounds = arrays['coordinates'], arrays['bounds']
    rings, polygons, features = (arrays[name] for name in ('ring_offsets', 'polygon_offsets', 'feature_offsets'))
    ids, names, areas = (arrays[name] for name in ('native_ids', 'area_names', 'area_indices'))
    if (xy.dtype != np.dtype('<f8') or xy.ndim != 2 or xy.shape[1] != 2 or not np.isfinite(xy).all() or
            bounds.dtype != np.dtype('<f8') or bounds.ndim != 2 or bounds.shape != (len(polygons)-1, 4) or not np.isfinite(bounds).all() or
            ids.dtype.kind != 'U' or ids.ndim != 1 or names.dtype.kind != 'U' or names.ndim != 1 or
            areas.dtype != np.dtype('<u4') or areas.ndim != 1 or len(ids) != len(features)-1 or
            len(ids) != len(areas) or not len(names) or (len(areas) and areas.max() >= len(names))):
        raise ValueError('Invalid projected typed-array schema.')
    for offsets, end in ((rings, len(xy)), (polygons, len(rings)-1), (features, len(polygons)-1)):
        if (offsets.dtype != np.dtype('<u8') or offsets.ndim != 1 or not len(offsets) or
                offsets[0] != 0 or offsets[-1] != end or not np.all(offsets[1:] > offsets[:-1])):
            raise ValueError('Invalid projected array offsets.')
    if np.any(np.diff(rings) < 4):
        raise ValueError('A projected polygon ring is incomplete.')
    starts = rings[:-1].astype(np.intp)
    ends = (rings[1:] - 1).astype(np.intp)
    if not np.array_equal(xy[starts], xy[ends]):
        raise ValueError('A projected polygon ring is not closed.')
    ring_low = np.minimum.reduceat(xy, starts, axis=0)
    ring_high = np.maximum.reduceat(xy, starts, axis=0)
    exterior = polygons[:-1].astype(np.intp)
    expected_bounds = np.column_stack((ring_low[exterior], ring_high[exterior]))
    if not np.array_equal(bounds, expected_bounds):
        raise ValueError('Projected polygon bounds do not match exterior coordinates.')
    actual = [(str(key), str(names[index])) for key, index in zip(ids, areas)]
    if actual != expected_assignments or assignment_digest(actual) != entry['assignment_sha256']:
        raise ValueError('Projected native IDs or exact area assignments differ.')
    if len(ids) != entry['units'] or len(xy) != entry['points'] or len(bounds) != entry['polygons']:
        raise ValueError('Projected cache counts differ.')
    for array in arrays.values():
        array.flags.writeable = False
    return arrays


def unpack(arrays, area):
    xy, bounds = arrays['coordinates'], arrays['bounds']
    r, p, f = (arrays[name] for name in ('ring_offsets', 'polygon_offsets', 'feature_offsets'))
    names, areas = arrays['area_names'], arrays['area_indices']
    output = []
    for i, native_id in enumerate(arrays['native_ids']):
        if area is not None and names[areas[i]] != area:
            continue
        polygons = []
        for j in range(int(f[i]), int(f[i+1])):
            rings = [xy[int(r[k]):int(r[k+1])] for k in range(int(p[j]), int(p[j+1]))]
            polygons.append((rings, tuple(bounds[j])))
        output.append((str(native_id), polygons))
    return output


def safe_filename(entry):
    checksum = entry['sha256']
    if not isinstance(checksum, str) or len(checksum) != 64 or any(c not in '0123456789abcdef' for c in checksum):
        raise ValueError('Invalid projected checksum.')
    filename = checksum + '.npz'
    if entry['file'] != filename:
        raise ValueError('Invalid projected file path.')
    return filename


class PaintStore:
    """No decoded cache here: GeoStore retains one country/area/LOD only."""
    def __init__(self, root, geometry_manifest):
        self.root, self.manifest = Path(root), None
        self.status, self.bad_keys = 'missing', set()
        try:
            self.expected_identity = identity(geometry_manifest)
            manifest = json.loads((self.root / 'manifest.json').read_text(encoding='utf-8'))
            if manifest.get('identity') != self.expected_identity:
                self.status = 'stale'
                LOGGER.warning('Private projected map cache is stale or invalid; using verified source geometry.')
                return
            expected_keys = {f'{country}:{lod:.3f}' for country in geometry_manifest['countries'] for lod in LODS}
            if set(manifest['files']) != expected_keys or manifest.get('complete') is not True:
                raise ValueError('Incomplete projected cache index.')
            self.manifest, self.status = manifest, 'ready'
        except FileNotFoundError:
            pass
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            self.status = 'invalid'
        if self.status in ('stale', 'invalid'):
            LOGGER.warning('Private projected map cache is stale or invalid; using verified source geometry.')

    def load(self, country, tolerance, native_assignments, area):
        key = f'{country}:{tolerance:.3f}'
        if self.manifest is None or key in self.bad_keys:
            return None
        try:
            entry = self.manifest['files'][key]
            arrays = load_arrays(self.root / safe_filename(entry), entry, native_assignments)
            return unpack(arrays, area)
        except CACHE_ERRORS:
            self.bad_keys.add(key)
            self.status = 'degraded'
            LOGGER.warning('Private projected map cache failed validation; using verified source geometry.')
            return None


def atomic_replace(source, target):
    """Brief scanner/sync locks must not discard a completed private build."""
    for attempt in range(5):
        try:
            os.replace(source, target)
            return
        except PermissionError:
            if attempt == 4:
                raise
            time.sleep(.05 * 2 ** attempt)


def atomic_json(path, data):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    try:
        temporary.write_text(json.dumps(data, ensure_ascii=False, separators=(',', ':'), allow_nan=False), encoding='utf-8')
        atomic_replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def build(geometry_root, output):
    """Resume valid per-LOD files, publish only a complete global manifest."""
    from municipal_geometry import GeoStore, projected_feature
    geometry = GeoStore(geometry_root)
    if geometry.manifest is None:
        raise FileNotFoundError('Prepare verified finest municipal geometry first.')
    output = Path(output)
    output.mkdir(parents=True, exist_ok=True)
    source_identity = identity(geometry.manifest)
    manifest = {'identity': source_identity, 'files': {}, 'complete': False}
    for candidate in (output / 'progress.json', output / 'manifest.json'):
        try:
            previous = json.loads(candidate.read_text(encoding='utf-8'))
            if previous.get('identity') == source_identity:
                manifest['files'].update(previous['files'])
        except (OSError, ValueError, KeyError, TypeError):
            pass
    expected_keys, started, reused = set(), time.monotonic(), 0
    for country in geometry.manifest['countries']:
        data = geometry._country(country)
        native_assignments = assignments(data)
        for tolerance in LODS:
            key = f'{country}:{tolerance:.3f}'
            expected_keys.add(key)
            previous = manifest['files'].get(key)
            if previous:
                try:
                    load_arrays(output / safe_filename(previous), previous, native_assignments)
                    reused += 1
                    continue
                except CACHE_ERRORS:
                    pass
            tick = time.monotonic()
            paint = [(native_id, projected_feature(shape, tolerance)) for native_id, _, shape in data.features]
            arrays = pack(paint, native_assignments)
            raw_bytes = sum(array.nbytes for array in arrays.values())
            if not 0 < raw_bytes <= MAX_RAW_BYTES:
                raise ValueError('Projected country exceeds the bounded typed-array limit.')
            temporary = output / ('.paint-' + uuid.uuid4().hex + '.npz')
            try:
                np.savez_compressed(temporary, **arrays)
                checksum = digest(temporary)
                entry = {'file': checksum + '.npz', 'sha256': checksum, 'bytes': temporary.stat().st_size,
                         'raw_array_bytes': raw_bytes, 'assignment_sha256': assignment_digest(native_assignments),
                         'units': len(paint), 'points': len(arrays['coordinates']), 'polygons': len(arrays['bounds'])}
                load_arrays(temporary, entry, native_assignments)
                atomic_replace(temporary, output / entry['file'])
            finally:
                temporary.unlink(missing_ok=True)
            manifest['files'][key] = entry
            atomic_json(output / 'progress.json', manifest)
            del paint, arrays
            print(f'Projected private map {key}; {time.monotonic()-tick:.1f}s; {time.monotonic()-started:.0f}s total', flush=True)
        del data, native_assignments
    manifest['files'] = {key: manifest['files'][key] for key in sorted(expected_keys)}
    manifest['complete'] = True
    atomic_json(output / 'manifest.json', manifest)
    print(f'Private projected maps ready: {len(expected_keys)} LODs; {reused} reused; '
          f'{sum(row["bytes"] for row in manifest["files"].values()):,} bytes; '
          f'{time.monotonic()-started:.1f}s', flush=True)
    return manifest


def copy_ready(source, destination, manifest):
    source, destination = Path(source).resolve(), Path(destination).resolve()
    if source == destination:
        return
    destination.mkdir(parents=True, exist_ok=True)
    for entry in manifest['files'].values():
        filename = safe_filename(entry)
        target = destination / filename
        if target.is_file() and target.stat().st_size == entry['bytes'] and digest(target) == entry['sha256']:
            continue
        temporary = destination / ('.copy-' + uuid.uuid4().hex + '.npz')
        try:
            shutil.copyfile(source / filename, temporary)
            if temporary.stat().st_size != entry['bytes'] or digest(temporary) != entry['sha256']:
                raise ValueError('Copied projected cache checksum failed.')
            atomic_replace(temporary, target)
        finally:
            temporary.unlink(missing_ok=True)
    atomic_json(destination / 'manifest.json', manifest)


def prepare_paint(geometry_root, cache_root=None):
    from municipal_geometry import GeoStore
    geometry_root = Path(geometry_root)
    source = GeoStore(geometry_root)
    if source.manifest is None:
        raise FileNotFoundError('Verified finest geometry is unavailable.')
    key = sha256(json.dumps(identity(source.manifest), sort_keys=True, separators=(',', ':')).encode()).hexdigest()
    output, work = geometry_root / 'paint', geometry_root / 'paint'
    if cache_root:
        candidate = Path(cache_root) / ('projected-' + key)
        try:
            candidate.mkdir(parents=True, exist_ok=True)
            probe = candidate / ('.write-probe-' + uuid.uuid4().hex)
            probe.write_bytes(b'')
            probe.unlink()
            work = candidate
        except OSError:
            LOGGER.warning('Private build cache is not writable; preparing projected maps in the runtime folder.')
    manifest = build(geometry_root, work)
    copy_ready(work, output, manifest)
    return manifest
