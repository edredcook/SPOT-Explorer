"""Read-only explorer for the published SPOT national results.

Numerical model execution is deliberately outside this service. All analytical
values come from the prepared, source-hashed release bundle.
"""
from __future__ import annotations

import csv
import io
import json
from pathlib import Path

from flask import Flask, jsonify, request, send_from_directory, Response
from spot_auth import register_auth

BASE = Path(__file__).resolve().parent
FAMILIES = ('processes', 'coefficients', 'outputs')


def create_app(data_path: str | Path | None = None) -> Flask:
    app = Flask(__name__, static_folder=str(BASE / 'web'), static_url_path='/static')
    bundle_path = Path(data_path) if data_path else BASE / 'data' / 'results.json'
    bundle = json.loads(bundle_path.read_text(encoding='utf-8'))
    entities = {row['id']: row for row in bundle['entities']}
    groups = {row['id']: row for row in bundle.get('groups', [])}
    geography = {**entities, **groups}
    metrics = {(row['family'], row['id']): row for row in bundle['metrics']}
    statistics = bundle['statistics']
    manifest_path = bundle_path.with_name('manifest.json')
    manifest = json.loads(manifest_path.read_text(encoding='utf-8')) if manifest_path.exists() else bundle['release']

    class InvalidQuery(ValueError):
        pass

    @app.errorhandler(InvalidQuery)
    def invalid_query(exc):
        return jsonify(error={'code': 'invalid_query', 'message': str(exc)}), 400

    def args(allowed):
        for key in request.args:
            if key not in allowed:
                raise InvalidQuery(f'Unsupported query parameter: {key}')
            if len(request.args.getlist(key)) != 1:
                raise InvalidQuery(f'Use {key} once.')

    def entity_id():
        value = request.args.get('entity', 'IND')
        if value not in geography:
            raise InvalidQuery('Select a recognised country, territory or reporting group.')
        return value

    def values_for(key):
        return bundle['national'][key] if key in entities else bundle['aggregated'][key]

    def selectors(allow_all=False):
        args({'entities', 'family', 'metric', 'statistic'})
        selected = request.args.get('entities', 'IND,CHN,USA').split(',')
        if not selected or len(selected) > (300 if allow_all else 12):
            raise InvalidQuery('Select between one and twelve geographies for comparison.')
        if len(selected) != len(set(selected)) or any(x not in geography for x in selected):
            raise InvalidQuery('Every selected geography must be recognised and appear once.')
        family = request.args.get('family', 'outputs')
        metric = request.args.get('metric', 'plas_em')
        statistic = request.args.get('statistic', 'Mean')
        if allow_all and family == 'all':
            if metric != 'all':
                raise InvalidQuery('Choose all metrics when selecting all metric families.')
        elif family not in FAMILIES:
            raise InvalidQuery('Select a recognised metric family.')
        if not (allow_all and metric == 'all') and (family, metric) not in metrics:
            raise InvalidQuery('Select a metric from the chosen family.')
        if statistic not in statistics and not (allow_all and statistic == 'all'):
            raise InvalidQuery('Select a recognised summary statistic.')
        return selected, family, metric, statistic

    @app.after_request
    def response_headers(response):
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
        if response.status_code == 200 and request.path.startswith('/api/') and not request.path.startswith('/api/auth/'):
            response.headers['Cache-Control'] = 'public, max-age=300'
        return response

    @app.get('/')
    def index():
        return send_from_directory(BASE / 'web', 'index.html')

    @app.get('/healthz')
    def health():
        args(set())
        return jsonify(status='ok', release=bundle['release'])

    @app.get('/api/meta')
    def metadata():
        args(set())
        return jsonify({key: bundle[key] for key in ('release', 'statistics', 'entities', 'groups', 'metrics', 'flow_nodes', 'flow_links') if key in bundle})

    def profile_value(key):
        return {'entity': geography[key], 'release': bundle['release'],
                'statistics': statistics, **values_for(key)}

    @app.get('/api/profile')
    def profile():
        args({'entity'})
        return jsonify(profile_value(entity_id()))

    def summary_rows(selected, family, metric, statistic):
        rows = []
        for key in selected:
            values = values_for(key)[family][metric]
            rows.append({'id': key, 'name': geography[key]['name'],
                         'value': values.get(statistic), 'low': values.get('5th percentile'),
                         'median': values.get('Median'), 'high': values.get('95th percentile')})
        return rows

    @app.get('/api/compare')
    def compare():
        selected, family, metric, statistic = selectors()
        return jsonify(metric=metrics[(family, metric)], statistic=statistic,
                       release=bundle['release'], rows=summary_rows(selected, family, metric, statistic))

    @app.get('/api/map')
    def map_values():
        args({'basis', 'statistic'})
        basis = request.args.get('basis', 'total')
        statistic = request.args.get('statistic', 'Mean')
        metric_by_basis = {'total': 'plas_em', 'per_capita': 'plas_em_per_cap'}
        if basis not in metric_by_basis:
            raise InvalidQuery('Select total or per_capita for the map basis.')
        if statistic not in ('Mean', 'Median'):
            raise InvalidQuery('Select Mean or Median for the map summary.')
        metric = metric_by_basis[basis]
        return jsonify(basis=basis, metric=metrics[('outputs', metric)], statistic=statistic,
                       release=bundle['release'], rows=summary_rows(entities, 'outputs', metric, statistic))

    @app.get('/api/atlas')
    def atlas_values():
        """Released national outputs for linked maps and cross-country charts.

        The selected central statistic and interval bounds are copied from the
        release. Mean is also explicit so additive composition charts can use
        mean masses even when another view displays medians. No national or
        regional value is derived from displayed polygons or percentages here.
        """
        args({'statistic'})
        statistic = request.args.get('statistic', 'Mean')
        if statistic not in ('Mean', 'Median'):
            raise InvalidQuery('Select Mean or Median for the atlas summary.')
        output_metrics = [definition for (family, _), definition in metrics.items()
                          if family == 'outputs']
        rows = []
        for key, entity in entities.items():
            released = bundle['national'][key]['outputs']
            values = {}
            for definition in output_metrics:
                metric_id = definition['id']
                source = released[metric_id]
                values[metric_id] = {
                    'value': source.get(statistic), 'low': source.get('5th percentile'),
                    'median': source.get('Median'), 'high': source.get('95th percentile'),
                    'mean': source.get('Mean'),
                }
            rows.append({**entity, 'values': values})
        return jsonify(release=bundle['release'], model_year=bundle['release'].get('model_year', 2020),
                       statistic=statistic, statistics=statistics, metrics=output_metrics, rows=rows)

    @app.get('/api/download')
    def download():
        selected, family, metric, statistic = selectors(allow_all=True)
        stream = io.StringIO(newline='')
        writer = csv.writer(stream, lineterminator='\r\n')
        writer.writerow(['release', 'model_year', 'entity_id', 'entity_name', 'family',
                         'metric_id', 'metric_name', 'statistic', 'value', 'unit'])
        for key in selected:
            results = values_for(key)
            for fam in FAMILIES if family == 'all' else (family,):
                for mid in results[fam] if metric == 'all' else (metric,):
                    definition = metrics[(fam, mid)]
                    for stat in statistics if statistic == 'all' else (statistic,):
                        value = results[fam][mid].get(stat)
                        writer.writerow([bundle['release'].get('model_version', bundle['release'].get('version', 'V1.4.1-G-0426')),
                                         bundle['release'].get('model_year', 2020), key, geography[key]['name'], fam,
                                         mid, definition.get('name', mid), stat,
                                         '' if value is None else value,
                                         definition.get('display_unit') or definition.get('unit', '')])
        return Response('\ufeff' + stream.getvalue(), content_type='text/csv; charset=utf-8',
                        headers={'Content-Disposition': 'attachment; filename="SPOT_2020_selected_results.csv"'})

    @app.get('/api/snapshot')
    def snapshot():
        args({'entity'})
        key = entity_id()
        response = jsonify({**profile_value(key), 'metrics': bundle['metrics'], 'provenance': manifest})
        response.headers['Content-Disposition'] = 'attachment; filename="SPOT_2020_snapshot.json"'
        return response

    @app.get('/api/provenance')
    def provenance():
        args(set())
        return jsonify(manifest)

    register_auth(app)
    return app


app = create_app()

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8050, debug=False)
