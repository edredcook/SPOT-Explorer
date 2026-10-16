"""Lazy access to prepared, unchanged municipal SPOT output summaries.

An optional build-time index reads just the selected metric. It retains one
country's metadata and one metric; the original verified country files remain
the fallback when no index was prepared. No workbook is read at request time.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
from pathlib import Path
import sqlite3
import threading
from contextlib import closing

BASE = Path(__file__).resolve().parent
EMPTY_AREA_ID = '__no_admin_1__'
DISPLAY_STATISTICS = ('Mean', 'Median')
INDEX_SCHEMA = 'spot-municipal-index/v1'
DEFAULT_INDEX = BASE / '.runtime' / 'municipal_values' / 'results.sqlite'


class MunicipalDataError(RuntimeError):
    """Prepared files are incomplete, corrupted or have an unsupported schema."""


class MunicipalStore:
    def __init__(self, root: str | Path | None = None, *, cache_countries=1, index_path=None):
        if cache_countries != 1:
            raise ValueError('This store retains one country to bound memory.')
        self.root = Path(root) if root else BASE / 'data' / 'municipal'
        self._lock = threading.RLock()
        self._manifest = None
        self._country = None
        self._country_id = None
        self.index_path = Path(index_path) if index_path is not None else (DEFAULT_INDEX if root is None else self.root / '.numeric-index.sqlite')
        self._index_checked = False
        self._has_metric_index = False
        self._metric_cache = None

    @property
    def available(self):
        return (self.root / 'manifest.json').is_file()

    def _index(self):
        if self._manifest is None:
            if not self.available:
                raise FileNotFoundError('Municipal data has not been prepared.')
            data = json.loads((self.root / 'manifest.json').read_bytes())
            if data.get('schema') != 'spot-municipal/v1':
                raise MunicipalDataError('Unsupported municipal dataset schema.')
            self._manifest = data
        return self._manifest

    def _index_query(self, sql, parameters=()):
        try:
            with closing(sqlite3.connect(self.index_path.resolve().as_uri() + '?mode=ro', uri=True)) as connection:
                connection.execute('PRAGMA query_only=ON')
                return connection.execute(sql, parameters).fetchone()
        except sqlite3.Error as exc:
            raise MunicipalDataError('Municipal metric index is unreadable.') from exc

    def _indexed(self):
        if not self._index_checked:
            self._index()
            if self.index_path.is_file():
                row = self._index_query('SELECT schema, source_manifest_sha256, complete FROM index_info')
                digest = hashlib.sha256((self.root / 'manifest.json').read_bytes()).hexdigest()
                if row != (INDEX_SCHEMA, digest, 1):
                    raise MunicipalDataError('Municipal metric index does not match the current release.')
                self._has_metric_index = True
            self._index_checked = True
        return self._has_metric_index

    @staticmethod
    def _decode_index_blob(record):
        if record is None:
            raise MunicipalDataError('Municipal metric index is incomplete.')
        blob, digest, expected = record
        if (not isinstance(expected, int) or not 0 < expected <= 128 * 1024 * 1024 or
                hashlib.sha256(blob).hexdigest() != digest):
            raise MunicipalDataError('Municipal metric index checksum failed.')
        try:
            with gzip.GzipFile(fileobj=io.BytesIO(blob)) as stream:
                raw = stream.read(expected + 1)
            if len(raw) != expected:
                raise MunicipalDataError('Municipal metric index length failed.')
            return json.loads(raw)
        except (OSError, EOFError, ValueError) as exc:
            raise MunicipalDataError('Municipal metric index data is invalid.') from exc

    def _indexed_country(self, country_id):
        entry = next(row for row in self._index()['countries'] if row['id'] == country_id)
        if self._country_id != country_id:
            self._country = None
            self._country_id = None
            self._metric_cache = None
            rows = self._decode_index_blob(self._index_query(
                'SELECT payload, sha256, json_bytes FROM countries WHERE country_id=?', (country_id,)))
            if not isinstance(rows, list) or len(rows) != entry['units'] or len({row['id'] for row in rows}) != entry['units']:
                raise MunicipalDataError('Municipal metric index country registry failed.')
            self._country = {'rows': rows}
            self._country_id = country_id
        return self._country, entry

    def _indexed_metric(self, country_id, metric):
        if self._metric_cache is None or self._metric_cache[0] != metric:
            values = self._decode_index_blob(self._index_query(
                'SELECT payload, sha256, json_bytes FROM metric_values WHERE country_id=? AND metric_id=?', (country_id, metric)))
            if not isinstance(values, list) or len(values) != len(self._country['rows']) or any(not isinstance(value, list) or len(value) != 4 for value in values):
                raise MunicipalDataError('Municipal metric index summary dimensions failed.')
            self._metric_cache = (metric, values)
        return self._metric_cache[1]

    def metadata(self):
        with self._lock:
            if not self.available:
                return {'available': False, 'message': 'Municipal data has not been prepared.'}
            source = self._index()
            return {'available': True, 'schema': source['schema'], 'release': source['release'],
                    'statistics': list(DISPLAY_STATISTICS), 'prepared_statistics': source['statistics'],
                    'source_statistics': source.get('source_statistics', source['statistics']),
                    'metrics': source['metrics'], 'countries': source['countries'],
                    'unit_count': source['unit_count'], 'no_modelled_population_unit_count': source['no_modelled_population_unit_count'],
                    'empty_area_id': EMPTY_AREA_ID, 'sources': source['sources'],
                    'notes': source.get('notes', [])}

    def _load(self, country_id):
        index = self._index()
        countries = {row['id']: row for row in index['countries']}
        if country_id not in countries:
            raise KeyError('Select a recognised country or territory.')
        entry = countries[country_id]
        if self._country_id == country_id:
            return self._country, entry
        # Release the previous country's object before allocating its replacement.
        self._country = None
        self._country_id = None
        filename = entry['file']
        if Path(filename).name != filename:
            raise MunicipalDataError('Invalid municipal country filename.')
        blob = (self.root / filename).read_bytes()
        if hashlib.sha256(blob).hexdigest() != entry['sha256']:
            raise MunicipalDataError('Municipal country checksum failed.')
        expected = entry['json_bytes']
        if not isinstance(expected, int) or not 0 < expected <= 128 * 1024 * 1024:
            raise MunicipalDataError('Invalid municipal country size.')
        with gzip.GzipFile(fileobj=io.BytesIO(blob)) as stream:
            raw = stream.read(expected + 1)
        if len(raw) != expected:
            raise MunicipalDataError('Municipal country length failed.')
        data = json.loads(raw)
        if (data.get('schema') != index['schema'] or data.get('country_id') != country_id or
                data.get('metric_ids') != index['metric_ids'] or data.get('statistics') != index['statistics'] or
                len(data.get('rows', [])) != entry['units']):
            raise MunicipalDataError('Municipal country schema failed.')
        self._country, self._country_id = data, country_id
        return data, entry

    def _select(self, country_id, metric_ids, statistic, area):
        if statistic not in DISPLAY_STATISTICS:
            raise ValueError('Select Mean or Median for municipal results.')
        index = self._index()
        entries = {row['id']: row for row in index['countries']}
        if country_id not in entries:
            raise KeyError('Select a recognised country or territory.')
        entry = entries[country_id]
        selected = index['metric_ids'] if metric_ids is None else [metric_ids] if isinstance(metric_ids, str) else list(metric_ids)
        if not selected or len(selected) != len(set(selected)):
            raise ValueError('Select recognised municipal metrics once each.')
        if any(metric not in index['metric_ids'] for metric in selected):
            raise KeyError('Select a recognised municipal output metric.')
        areas = {row['id'] for row in entry['areas']}
        if area is not None and area not in areas:
            raise ValueError('Select a native area from the chosen country.')
        if self._indexed():
            metadata, entry = self._indexed_country(country_id)
            columns = [self._indexed_metric(country_id, metric) for metric in selected]
            data = {'rows': [{**row, 'values': [column[i] for column in columns]}
                             for i, row in enumerate(metadata['rows'])]}
            positions = list(zip(selected, range(len(selected))))
        else:
            data, entry = self._load(country_id)
            positions = [(metric, data['metric_ids'].index(metric)) for metric in selected]
        return data, entry, positions

    @staticmethod
    def _matches(row, area):
        return area is None or (row['admin_names'][0] or EMPTY_AREA_ID) == area

    @staticmethod
    def _expand(row, positions, statistic):
        values = {}
        for metric, position in positions:
            mean, median, low, high = row['values'][position]
            values[metric] = {'value': mean if statistic == 'Mean' else median,
                              'mean': mean, 'median': median, 'low': low, 'high': high}
        return {'id': row['id'], 'name': row['name'], 'population': row['population'],
                'admin_names': list(row['admin_names']), 'rural_share': row['rural_share'],
                'urban_class_1': row['urban_class_1'], 'urban_class_2': row['urban_class_2'],
                'status': row['status'], 'values': values}

    def country(self, country_id, metric_ids=None, statistic='Mean', area=None):
        with self._lock:
            data, entry, positions = self._select(country_id, metric_ids, statistic, area)
            index = self._index()
            selected = {metric for metric, _ in positions}
            rows = [self._expand(row, positions, statistic) for row in data['rows'] if self._matches(row, area)]
            return {'release': index['release'], 'country_id': country_id, 'country': {'id': country_id, 'name': entry['name']},
                    'area': area, 'statistic': statistic, 'metrics': [metric for metric in index['metrics'] if metric['id'] in selected],
                    'unit_count': len(rows), 'total_units': entry['units'], 'rows': rows}

    def members(self, country_id, area=None):
        with self._lock:
            data, entry, _ = self._select(country_id, ['plas_em'], 'Mean', area)
            return frozenset(row['id'] for row in data['rows'] if self._matches(row, area))

    def profile(self, unit_id, statistic='Mean'):
        if not isinstance(unit_id, str) or not unit_id:
            raise KeyError('Select a recognised municipal reporting unit.')
        # The preparation script checks this native prefix against every source
        # country ID. It selects the file; exact membership is checked below.
        country_id = unit_id.split('.', 1)[0]
        with self._lock:
            if statistic not in DISPLAY_STATISTICS:
                raise ValueError('Select Mean or Median for municipal results.')
            if country_id not in {row['id'] for row in self._index()['countries']}:
                raise KeyError('Select a recognised municipal reporting unit.')
            if self._indexed():
                data, _ = self._indexed_country(country_id)
                position = next((i for i, row in enumerate(data['rows']) if row['id'] == unit_id), None)
                if position is None:
                    raise KeyError('Select a recognised municipal reporting unit.')
                metrics = self._index()['metric_ids']
                row = {**data['rows'][position], 'values': [self._indexed_metric(country_id, metric)[position] for metric in metrics]}
                return {'release': self._index()['release'], 'country_id': country_id,
                        'statistic': statistic, 'metrics': self._index()['metrics'],
                        'row': self._expand(row, list(zip(metrics, range(len(metrics)))), statistic)}
            data, entry, positions = self._select(country_id, None, statistic, None)
            row = next((row for row in data['rows'] if row['id'] == unit_id), None)
            if row is None:
                raise KeyError('Select a recognised municipal reporting unit.')
            return {'release': self._index()['release'], 'country_id': country_id,
                    'statistic': statistic, 'metrics': self._index()['metrics'],
                    'row': self._expand(row, positions, statistic)}
