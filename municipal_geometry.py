"""Private municipal geometry and bounded raster maps.

Only this module reads prepared vectors. Public routes should return its PNG
bytes, metadata, or an identified native model ID, never its private database.
All projection coordinates follow d3.geoMercator's radians/scale/translate.
"""
from __future__ import annotations

from collections import OrderedDict
from contextlib import closing
from dataclasses import dataclass
from hashlib import sha256
from io import BytesIO
import json
import math
from pathlib import Path
import sqlite3
import threading

MAX_LATITUDE = 85.0511287798066
MISSING_COLOUR = (205, 206, 205, 255)
ZERO_COLOUR = (242, 241, 232, 255)
RAMP = ((229, 240, 232), (164, 215, 203), (75, 175, 169), (35, 125, 125), (27, 59, 57))
SELECTION_ORANGE = (233, 137, 54, 255)
SELECTION_FILL = (233, 137, 54, 38)
PAINT_POLICY = {'target_pixels_at_view_centre': 0.35, 'finest_tolerance_degrees': 0.001,
                'maximum_tolerance_degrees': 0.064, 'quantization': 'powers of two',
                'cache': 'One projected zoom level and exact native area for the current country',
                'raster_cache': 'One metric-independent viewport label raster, at most two million pixels',
                'lookup': 'Finest prepared geometry retained for native-ID point identification',
                'fallback': 'Keep valid finest geometry if display simplification becomes empty or invalid'}


def project(lon, lat, scale, tx, ty):
    latitude = math.radians(max(-MAX_LATITUDE, min(MAX_LATITUDE, lat)))
    return scale * math.radians(lon) + tx, ty - scale * math.log(math.tan(math.pi / 4 + latitude / 2))


def project_ring(coordinates):
    """Project a whole ring in compiled arrays, with no Python point tuples."""
    import numpy as np
    coordinates = np.asarray(coordinates, dtype=float)
    projected = np.empty((len(coordinates), 2), dtype=float)
    projected[:, 0] = np.deg2rad(coordinates[:, 0])
    latitude = np.deg2rad(np.clip(coordinates[:, 1], -MAX_LATITUDE, MAX_LATITUDE))
    projected[:, 1] = -np.log(np.tan(math.pi / 4 + latitude / 2))
    projected.flags.writeable = False
    return projected


def paint_tolerance(scale, ty, height):
    """Quantized display LOD, approximately 0.35 px at the view centre.

    Mercator stretches latitudes differently, so this is a display target,
    not a geometric accuracy claim. Point lookup always uses finer shapes.
    """
    centre_y = max(-math.pi, min(math.pi, (ty - height / 2) / scale))
    centre_latitude = math.atan(math.sinh(centre_y))
    degrees = 0.35 * math.cos(centre_latitude) * 180 / (math.pi * scale)
    if degrees <= 0.001:
        return 0.001
    return min(0.064, 0.001 * 2 ** math.floor(math.log2(degrees / 0.001)))


def validate_viewport(width, height, scale, tx, ty):
    if (not isinstance(width, int) or not isinstance(height, int) or not 1 <= width <= 2000 or
            not 1 <= height <= 1400 or width * height > 2_000_000 or
            any(not math.isfinite(v) for v in (scale, tx, ty)) or not 0 < scale <= 1e8):
        raise ValueError('Use a bounded map viewport.')


def projected_feature(finest, tolerance):
    """Project one exact native feature without changing any shared cache."""
    geometry = finest
    if tolerance > 0.001:
        from shapely.geometry import MultiPolygon
        parts = [part.simplify(tolerance, preserve_topology=True) for part in polygon_parts(finest)]
        candidate = parts[0] if len(parts) == 1 else MultiPolygon(parts)
        if not candidate.is_empty and candidate.is_valid and polygon_parts(candidate):
            geometry = candidate
    polygons = []
    for polygon in polygon_parts(geometry):
        rings = [project_ring(ring.coords) for ring in [polygon.exterior, *polygon.interiors]]
        low, high = rings[0].min(axis=0), rings[0].max(axis=0)
        polygons.append((rings, (low[0], low[1], high[0], high[1])))
    return polygons


def colour(value, maximum):
    """Match the existing d3.interpolateRgbBasis sequential log1p legend.

    Source values are not rewritten. Zero and negative residuals use the first
    palette colour; exact zero has its own cream and missing is grey.
    """
    if isinstance(value, dict):
        value = value.get('value')
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        return MISSING_COLOUR
    if value == 0:
        return ZERO_COLOUR
    fraction = math.log1p(max(value, 0) / maximum * 100) / math.log(101) if maximum and maximum > 0 else 0
    t = max(0.0, min(1.0, fraction)) * (len(RAMP) - 1)
    index = min(len(RAMP) - 2, int(t))
    t -= index
    v1, v2 = RAMP[index], RAMP[index + 1]
    v0 = RAMP[index - 1] if index else tuple(2 * a - b for a, b in zip(v1, v2))
    v3 = RAMP[index + 2] if index < len(RAMP) - 2 else tuple(2 * b - a for a, b in zip(v1, v2))
    weights = ((1 - 3 * t + 3 * t * t - t ** 3), (4 - 6 * t * t + 3 * t ** 3),
               (1 + 3 * t + 3 * t * t - 3 * t ** 3), t ** 3)
    channels = [max(0, min(255, round(sum(w * v[c] for w, v in zip(weights, (v0, v1, v2, v3))) / 6))) for c in range(3)]
    return (*channels, 255)


def polygon_parts(geometry):
    if geometry.geom_type == 'Polygon':
        return [geometry]
    if geometry.geom_type in ('MultiPolygon', 'GeometryCollection'):
        return [part for child in geometry.geoms for part in polygon_parts(child)]
    return []


def unwrap_geometry(geometry):
    """Unwrap dateline rings while retaining each native feature's identity."""
    from shapely.geometry import MultiPolygon, Polygon

    west, _, east, _ = geometry.bounds
    if -180 <= west <= east <= 180 and east - west < 180:
        # Ordinary local units cannot cross the dateline. Keep GEOS's compact
        # coordinates instead of rebuilding millions of Python point tuples.
        return geometry

    def ring(coordinates, centre=None):
        output, previous = [], None
        for coordinate in coordinates:
            lon, lat = coordinate[:2]
            if previous is not None:
                lon += 360 * round((previous - lon) / 360)
            output.append((float(lon), float(lat)))
            previous = lon
        middle = (min(x for x, _ in output) + max(x for x, _ in output)) / 2
        shift = 360 * round(((centre if centre is not None else 0) - middle) / 360)
        return [(x + shift, y) for x, y in output]

    parts = []
    for polygon in polygon_parts(geometry):
        exterior = ring(polygon.exterior.coords)
        centre = (min(x for x, _ in exterior) + max(x for x, _ in exterior)) / 2
        holes = [ring(interior.coords, centre) for interior in polygon.interiors]
        parts.append(Polygon(exterior, holes))
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def circular_bounds(bounds):
    """Smallest longitude interval covering polygon-part intervals.

    A west value greater than east explicitly denotes an antimeridian crossing.
    """
    bounds = list(bounds)
    if not bounds:
        return None
    intervals = []
    for west, _, east, _ in bounds:
        span = east - west
        if span >= 359.999999:
            return [-180.0, min(b[1] for b in bounds), 180.0, max(b[3] for b in bounds)]
        start = (west + 180) % 360
        end = start + span
        intervals.extend([(start, min(360, end))] + ([(0, end - 360)] if end > 360 else []))
    merged = []
    for start, end in sorted(intervals):
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    gaps = [(merged[(i + 1) % len(merged)][0] + (360 if i == len(merged) - 1 else 0) - end,
             merged[(i + 1) % len(merged)][0], end) for i, (_, end) in enumerate(merged)]
    gap, start, end = max(gaps)
    if gap <= 1e-9:
        west, east = -180.0, 180.0
    else:
        west, east = start - 180, end - 180
    return [west, min(b[1] for b in bounds), east, max(b[3] for b in bounds)]


@dataclass
class _Country:
    features: list
    tree: object
    paint_key: object = None
    paint_features: object = None
    raster_key: object = None
    raster: object = None


def palette_for(native_ids, values, maximum):
    """Exact source values determine a small colour table, not polygon work.

    NumPy is already a Shapely dependency. Its compiled array operations keep
    recolouring thousands of reporting units off the Python drawing loop.
    Index zero is transparent exterior; missing and exact zero stay distinct.
    """
    import numpy as np
    source = []
    for native_id in native_ids:
        value = values.get(native_id)
        value = value.get('value') if isinstance(value, dict) else value
        source.append(value if isinstance(value, (int, float)) and not isinstance(value, bool) else math.nan)
    numeric = np.asarray(source, dtype=float)
    palette = np.zeros((len(native_ids) + 1, 4), dtype=np.uint8)
    palette[1:] = MISSING_COLOUR
    valid = np.isfinite(numeric)
    zero = valid & (numeric == 0)
    palette[1:][zero] = ZERO_COLOUR
    selected = np.flatnonzero(valid & ~zero)
    if not len(selected):
        return palette
    fraction = np.log1p(np.maximum(numeric[selected], 0) / maximum * 100) / math.log(101) if maximum and maximum > 0 else np.zeros(len(selected))
    position = np.clip(fraction, 0, 1) * (len(RAMP) - 1)
    index = np.minimum(len(RAMP) - 2, position.astype(int))
    t = (position - index)[:, None]
    ramp = np.asarray(RAMP, dtype=float)
    extended = np.vstack((2 * ramp[0] - ramp[1], ramp, 2 * ramp[-1] - ramp[-2]))
    v0, v1, v2, v3 = (extended[index + offset] for offset in range(4))
    channels = ((1 - 3*t + 3*t*t - t**3)*v0 + (4 - 6*t*t + 3*t**3)*v1 +
                (1 + 3*t + 3*t*t - 3*t**3)*v2 + t**3*v3) / 6
    palette[selected + 1, :3] = np.clip(np.rint(channels), 0, 255).astype(np.uint8)
    palette[selected + 1, 3] = 255
    # Resolve rare floating-point half-way values with the scalar reference.
    # This preserves its rounding at channel boundaries across math libraries.
    ties = np.any(np.abs(channels - np.floor(channels) - .5) < 1e-10, axis=1)
    for offset in np.flatnonzero(ties):
        position = selected[offset]
        palette[position + 1] = colour(source[position], maximum)
    return palette


class GeoStore:
    """One-country LRU keeps geometry memory bounded on the small web service."""
    def __init__(self, root):
        self.root = Path(root).resolve()
        self.lock = threading.RLock()
        self.cache = OrderedDict()
        self.selection_key = None
        self.selection_png = None
        self.manifest = None
        try:
            manifest = json.loads((self.root / 'manifest.json').read_text(encoding='utf-8'))
            database = self.root / 'geometry.sqlite'
            if manifest.get('schema') != 1 or not isinstance(manifest.get('countries'), dict):
                return
            if database.stat().st_size != manifest['database']['bytes']:
                return
            digest = sha256()
            with database.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''):
                    digest.update(block)
            if digest.hexdigest() != manifest['database']['sha256']:
                return
            self.manifest = manifest
        except (OSError, ValueError, KeyError, TypeError):
            pass

    def metadata(self, country=None):
        if self.manifest is None:
            return {'available': False}
        if country is None:
            return {'available': True, 'count': self.manifest['count'],
                    'countries': [{'id': key, **value} for key, value in self.manifest['countries'].items()],
                    'source': self.manifest.get('source', {}),
                    'simplification': {**self.manifest.get('simplification', {}), 'adaptive_paint': PAINT_POLICY}}
        value = self.manifest['countries'].get(country)
        return {'available': True, 'id': country, **value} if value else {'available': False}

    def _country(self, country):
        if not self.metadata(country).get('available'):
            raise FileNotFoundError('Municipal geometry is unavailable.')
        from shapely import from_wkb
        from shapely.strtree import STRtree
        with self.lock:
            if country in self.cache:
                self.cache.move_to_end(country)
                return self.cache[country]
            # Drop the previous country's arrays before loading the next one.
            self.cache.clear()
            try:
                with closing(sqlite3.connect((self.root / 'geometry.sqlite').as_uri() + '?mode=ro', uri=True)) as connection:
                    rows = connection.execute('SELECT native_id, area, geom FROM features WHERE country=? ORDER BY native_id', (country,)).fetchall()
                features = []
                for native_id, area, blob in rows:
                    geometry = from_wkb(blob)
                    features.append((native_id, area, geometry))
                result = _Country(features, STRtree([row[2] for row in features]))
            except Exception as exc:
                raise FileNotFoundError('Municipal geometry is unavailable.') from exc
            self.cache[country] = result
            return result

    def inspect(self, country, lon, lat, area=None):
        with self.lock:
            return self._inspect(country, lon, lat, area)

    def _inspect(self, country, lon, lat, area=None):
        if not math.isfinite(lon) or not math.isfinite(lat):
            raise ValueError('Use finite geographic coordinates.')
        from shapely.geometry import Point
        data = self._country(country)
        hits = []
        for shifted in (lon - 360, lon, lon + 360):
            point = Point(shifted, lat)
            for index in data.tree.query(point):
                native_id, native_area, geometry = data.features[int(index)]
                if (area is None or native_area == area) and geometry.covers(point):
                    hits.append((geometry.area, native_id))
        return min(hits)[1] if hits else None

    def _paint_features(self, data, area, tolerance):
        key = (area, tolerance)
        if data.paint_key == key and data.paint_features is not None:
            return data.paint_features
        # Release the previous projected LOD before constructing its replacement.
        data.paint_key, data.paint_features = None, None
        data.raster_key, data.raster = None, None
        features = []
        for native_id, native_area, finest in data.features:
            if area is not None and native_area != area:
                continue
            features.append((native_id, projected_feature(finest, tolerance)))
        data.paint_key, data.paint_features = key, features
        return features

    def render_png(self, country, metricRowsByID, area, width, height, scale, tx, ty, max_value):
        with self.lock:
            return self._render_png(country, metricRowsByID, area, width, height, scale, tx, ty, max_value)

    def _render_png(self, country, metricRowsByID, area, width, height, scale, tx, ty, max_value):
        from PIL import Image
        validate_viewport(width, height, scale, tx, ty)
        data = self._country(country)
        paint = self._paint_features(data, area, paint_tolerance(scale, ty, height))
        labels, native_ids = self._label_raster(data, paint, width, height, scale, tx, ty)
        palette = palette_for(native_ids, metricRowsByID, max_value)
        image = Image.fromarray(palette[labels])
        output = BytesIO()
        image.save(output, format='PNG', optimize=False, compress_level=5)
        return output.getvalue()

    def _label_raster(self, data, paint, width, height, scale, tx, ty):
        """Cache one bounded viewport, independent of metric/statistic values."""
        import numpy as np
        from PIL import Image, ImageDraw
        key = (data.paint_key, width, height, scale, tx, ty)
        if data.raster_key == key and data.raster is not None:
            return data.raster
        data.raster_key, data.raster = None, None
        labels = Image.new('I', (width, height), 0)
        drawing = ImageDraw.Draw(labels)
        period = 2 * math.pi * scale
        native_ids = []
        for code, (native_id, polygons) in enumerate(paint, 1):
            native_ids.append(native_id)
            for rings, bounds in polygons:
                min_x, min_y, max_x, max_y = bounds
                min_x, max_x = min_x * scale + tx, max_x * scale + tx
                min_y, max_y = min_y * scale + ty, max_y * scale + ty
                x_centre = (min_x + max_x) / 2
                centre_copy = round((width / 2 - x_centre) / period)
                for copy in (centre_copy - 1, centre_copy, centre_copy + 1):
                    shift = copy * period
                    left, right = max(0, math.floor(min_x + shift - 1)), min(width, math.ceil(max_x + shift + 1))
                    top, bottom = max(0, math.floor(min_y - 1)), min(height, math.ceil(max_y + 1))
                    if left >= right or top >= bottom:
                        continue
                    # Most island parts have no holes. Draw these directly to
                    # avoid thousands of small masks, image allocations/pastes.
                    if len(rings) == 1:
                        drawing.polygon((rings[0] * scale + [tx + shift, ty]).ravel().tolist(), fill=code)
                        continue
                    mask = Image.new('L', (right - left, bottom - top))
                    mask_drawing = ImageDraw.Draw(mask)
                    transformed = [(ring * scale + [tx + shift - left, ty - top]).ravel().tolist() for ring in rings]
                    mask_drawing.polygon(transformed[0], fill=255)
                    for hole in transformed[1:]:
                        mask_drawing.polygon(hole, fill=0)
                    # Transparent holes retain earlier native units, matching
                    # the previous renderer's deterministic overlap ordering.
                    labels.paste(code, (left, top, right, bottom), mask)
        array = np.asarray(labels, dtype=np.uint16 if len(native_ids) < 65536 else np.uint32)
        array.flags.writeable = False
        data.raster_key, data.raster = key, (array, tuple(native_ids))
        return data.raster

    def render_selection_png(self, country, native_id, area, width, height, scale, tx, ty):
        """Transparent exact-unit highlight; never rebuild the base map cache."""
        with self.lock:
            validate_viewport(width, height, scale, tx, ty)
            if self.manifest is None:
                raise FileNotFoundError('Municipal geometry is unavailable.')
            if country not in self.manifest['countries']:
                raise KeyError('Unknown municipal reporting unit for this country or area.')
            key = (country, native_id, area, width, height, scale, tx, ty)
            if self.selection_key == key and self.selection_png is not None:
                return self.selection_png
            # Use the current country's projected feature when its LOD matches.
            # An overlay requested before a base map reads only one private WKB
            # row, preserving any other country's base paint/raster cache.
            data = self.cache.get(country)
            feature = next((row for row in data.features if row[0] == native_id), None) if data else None
            if feature is None:
                from shapely import from_wkb
                try:
                    with closing(sqlite3.connect((self.root / 'geometry.sqlite').as_uri() + '?mode=ro', uri=True)) as connection:
                        row = connection.execute('SELECT area,geom FROM features WHERE country=? AND native_id=?',
                                                 (country, native_id)).fetchone()
                    feature = (native_id, row[0], from_wkb(row[1])) if row else None
                except Exception as exc:
                    raise FileNotFoundError('Municipal geometry is unavailable.') from exc
            if feature is None or (area is not None and feature[1] != area):
                raise KeyError('Unknown municipal reporting unit for this country or area.')
            tolerance = paint_tolerance(scale, ty, height)
            polygons = None
            if data and data.paint_key and data.paint_key[1] == tolerance and data.paint_features is not None:
                polygons = next((parts for key_id, parts in data.paint_features if key_id == native_id), None)
            if polygons is None:
                polygons = projected_feature(feature[2], tolerance)
            self.selection_key, self.selection_png = None, None
            image = self._selection_image(polygons, width, height, scale, tx, ty)
            output = BytesIO()
            image.save(output, format='PNG', optimize=False, compress_level=5)
            self.selection_key, self.selection_png = key, output.getvalue()
            return self.selection_png

    @staticmethod
    def _selection_image(polygons, width, height, scale, tx, ty):
        from PIL import Image, ImageDraw
        image = Image.new('RGBA', (width, height))
        drawing = ImageDraw.Draw(image)
        period = 2 * math.pi * scale

        def copies():
            for rings, (west, north, east, south) in polygons:
                west, east = west * scale + tx, east * scale + tx
                north, south = north * scale + ty, south * scale + ty
                centre = round((width / 2 - (west + east) / 2) / period)
                for copy in (centre - 1, centre, centre + 1):
                    shift = copy * period
                    bounds = (max(0, math.floor(west + shift - 5)), max(0, math.floor(north - 5)),
                              min(width, math.ceil(east + shift + 5)), min(height, math.ceil(south + 5)))
                    if bounds[0] < bounds[2] and bounds[1] < bounds[3]:
                        yield rings, shift, bounds

        for rings, shift, (left, top, right, bottom) in copies():
            if len(rings) == 1:
                drawing.polygon((rings[0] * scale + [tx + shift, ty]).ravel().tolist(), fill=SELECTION_FILL)
                continue
            mask = Image.new('L', (right - left, bottom - top))
            mask_drawing = ImageDraw.Draw(mask)
            transformed = [(ring * scale + [tx + shift - left, ty - top]).ravel().tolist() for ring in rings]
            mask_drawing.polygon(transformed[0], fill=255)
            for hole in transformed[1:]:
                mask_drawing.polygon(hole, fill=0)
            image.paste(SELECTION_FILL, (left, top, right, bottom), mask)
        drawing = ImageDraw.Draw(image)
        # Draw all halos before orange strokes, so nearby islands cannot cover
        # another part's orange boundary with a later white halo.
        for stroke, stroke_width in (((255, 255, 255, 255), 7), (SELECTION_ORANGE, 3)):
            for rings, shift, _ in copies():
                for ring in rings:
                    drawing.line((ring * scale + [tx + shift, ty]).ravel().tolist(),
                                 fill=stroke, width=stroke_width)
        return image
