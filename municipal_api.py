"""Country-scoped municipal results and server-rendered map images.

The source geometries stay outside public assets and downloads. The browser
receives one metric's released summaries and a bounded-size image, rather than
the full workbook or a global vector layer.
"""
from __future__ import annotations

from collections import OrderedDict
import gzip
from hashlib import sha256
import math
from pathlib import Path
import threading

from flask import Response, jsonify, request

from municipal_data import MunicipalDataError, MunicipalStore


def register_municipal(app, bundle, *, data_root=None, geometry_root=None):
    from municipal_geometry import GeoStore

    base = Path(__file__).resolve().parent
    store = MunicipalStore(data_root)
    geometry = GeoStore(geometry_root or base / '.runtime' / 'municipal')
    definitions = {m['id']: m for m in bundle['metrics'] if m['family'] == 'outputs'}
    countries = {row['id']: row for row in bundle['entities']}
    app.extensions['municipal_store'] = store
    app.extensions['municipal_geometry'] = geometry
    # Published responses are immutable for this worker. Retain a small number
    # of compressed bodies without keeping several countries' decoded rows.
    compressed_bodies = OrderedDict()
    compressed_bytes = 0
    compression_lock = threading.Lock()
    compression_limit = 3 * 1024 * 1024

    def gzip_body(raw):
        nonlocal compressed_bytes
        key = sha256(raw).digest()
        with compression_lock:
            if key in compressed_bodies:
                compressed_bodies.move_to_end(key)
                return compressed_bodies[key]
        # A faster compression level trades a little bandwidth for less work on
        # the shared CPU. The decompressed JSON bytes remain exactly the same.
        body = gzip.compress(raw, compresslevel=1, mtime=0)
        with compression_lock:
            if key in compressed_bodies:
                return compressed_bodies[key]
            if len(body) <= compression_limit:
                while compressed_bodies and (len(compressed_bodies) >= 12 or
                                               compressed_bytes + len(body) > compression_limit):
                    _, expired = compressed_bodies.popitem(last=False)
                    compressed_bytes -= len(expired)
                compressed_bodies[key] = body
                compressed_bytes += len(body)
        return body

    def error(message, status=400):
        return jsonify(error={'code': 'municipal_unavailable' if status == 503 else 'invalid_query',
                              'message': message}), status

    def selectors(extra=()):
        allowed = {'country', 'metric', 'statistic', 'area', *extra}
        for key in request.args:
            if key not in allowed or len(request.args.getlist(key)) != 1:
                raise ValueError('Use each recognised municipal selector once.')
        country = request.args.get('country', 'IND')
        metric = request.args.get('metric', 'plas_em')
        statistic = request.args.get('statistic', 'Mean')
        area = request.args.get('area')
        if country not in countries:
            raise ValueError('Select a recognised country or territory.')
        if metric not in definitions:
            raise ValueError('Select a recognised municipal output metric.')
        if statistic not in ('Mean', 'Median'):
            raise ValueError('Select Mean or Median for municipal results.')
        if area is not None and (not area or len(area) > 250):
            raise ValueError('Select a native area from the chosen country.')
        return country, metric, statistic, area

    def compressed_json(payload):
        response = jsonify(payload)
        response.vary.add('Accept-Encoding')
        if request.accept_encodings['gzip'] > 0 and len(response.get_data()) > 1024:
            response.set_data(gzip_body(response.get_data()))
            response.headers['Content-Encoding'] = 'gzip'
        return response

    def geometry_metadata(country=None):
        # Geometry readiness is explicit; numeric tables remain usable if the
        # optional build asset is absent. The full vector data is never returned.
        return geometry.metadata(country)

    def matching_release(released):
        expected = bundle['release']
        version = lambda item: item.get('version') or item.get('model_version') or item.get('id')
        if version(released) != version(expected) or released.get('model_year') != expected.get('model_year'):
            raise MunicipalDataError('Municipal and national release identities differ.')

    def country_values(country, metric, statistic, area):
        payload = store.country(country, [metric], statistic, area)
        matching_release(payload['release'])
        spatial = geometry_metadata(country)
        payload['country'] = {**countries[country], **payload['country']}
        payload.update(metric=payload['metrics'][0], count=payload['unit_count'], level='municipal')
        payload['geometry_ready'] = bool(spatial.get('available', spatial.get('geometry_ready', False)))
        if spatial.get('bounds'):
            payload['bounds'] = spatial['bounds']
            if area is not None:
                native_area = next((a for a in spatial.get('areas', []) if a['id'] == area), None)
                if native_area and native_area.get('bounds'):
                    payload['bounds'] = native_area['bounds']
        values = [row['values'][metric]['value'] for row in payload['rows']
                  if row['values'][metric]['value'] is not None]
        payload['legend'] = {'minimum': min(values, default=None),
                             'maximum': max(values, default=None), 'scale': 'log1p'}
        return payload

    def numeric(name, low, high, *, integer=False):
        try:
            raw = request.args[name]
            value = int(raw) if integer else float(raw)
        except (KeyError, TypeError, ValueError):
            raise ValueError('Use a valid map viewport.') from None
        if not math.isfinite(value) or not low <= value <= high:
            raise ValueError('The map viewport is outside the supported range.')
        return value

    def handled(fn):
        def invoke(*args, **kwargs):
            try:
                return fn(*args, **kwargs)
            except (KeyError, ValueError) as exc:
                return error(str(exc).strip("'"))
            except (FileNotFoundError, MunicipalDataError):
                return error('Municipal detail is unavailable. National and regional maps remain available.', 503)
        invoke.__name__ = fn.__name__
        return invoke

    @app.get('/api/municipal/meta')
    @handled
    def municipal_metadata():
        if request.args:
            raise ValueError('Municipal metadata does not accept query parameters.')
        payload = store.metadata()
        if payload.get('available'):
            matching_release(payload['release'])
            if {country['id'] for country in payload['countries']} != set(countries):
                raise MunicipalDataError('Municipal and national country registries differ.')
        spatial_manifest = geometry_metadata()
        payload['geometry'] = {key: spatial_manifest[key] for key in ('available', 'count', 'source', 'simplification')
                               if key in spatial_manifest}
        rows = []
        for item in payload.get('countries', []):
            spatial = geometry_metadata(item['id'])
            row = {**countries[item['id']], **item, 'count': item['units'],
                   'geometry_ready': bool(spatial.get('available', spatial.get('geometry_ready', False)))}
            if spatial.get('bounds'):
                row['bounds'] = spatial['bounds']
            spatial_areas = {a['id']: a for a in spatial.get('areas', [])}
            row['areas'] = [{**area, **({'bounds': spatial_areas[area['id']]['bounds']}
                                      if spatial_areas.get(area['id'], {}).get('bounds') else {})}
                            for area in item['areas']]
            rows.append(row)
        payload['countries'] = rows
        return compressed_json(payload)

    @app.get('/api/municipal/values')
    @handled
    def municipal_values():
        return compressed_json(country_values(*selectors()))

    @app.get('/api/municipal/map.png')
    @handled
    def municipal_image():
        country, metric, statistic, area = selectors(('width', 'height', 'scale', 'tx', 'ty'))
        width = numeric('width', 100, 2000, integer=True)
        height = numeric('height', 100, 1400, integer=True)
        if width * height > 2_000_000:
            raise ValueError('Use a map viewport of at most two million pixels.')
        scale = numeric('scale', 1, 100_000_000)
        tx, ty = numeric('tx', -1e9, 1e9), numeric('ty', -1e9, 1e9)
        payload = country_values(country, metric, statistic, area)
        values = {r['id']: r['values'][metric]['value'] for r in payload['rows']}
        image = geometry.render_png(country, values, area, width, height, scale, tx, ty,
                                    payload['legend']['maximum'])
        return Response(image, mimetype='image/png')

    @app.get('/api/municipal/inspect')
    @handled
    def municipal_inspect():
        country, metric, statistic, area = selectors(('lon', 'lat'))
        lon, lat = numeric('lon', -180, 180), numeric('lat', -90, 90)
        payload = country_values(country, metric, statistic, area)
        identifier = geometry.inspect(country, lon, lat, area)
        row = next((row for row in payload['rows'] if row['id'] == identifier), None)
        return compressed_json({'country_id': country, 'metric': payload['metric'],
                                'statistic': statistic, 'area': area, 'release': bundle['release'], 'row': row})
