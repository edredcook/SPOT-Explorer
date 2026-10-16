"""Prepare a private, optional metric index from verified municipal chunks.

The source JSON numbers and nulls are re-encoded without arithmetic. Each
country/metric blob has its own checksum, so requests need not read the whole
index. The source manifest hash binds the index to the exact prepared release.
"""
from __future__ import annotations

import argparse
from contextlib import closing
import gzip
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from municipal_data import DEFAULT_INDEX, INDEX_SCHEMA, MunicipalStore


def _complete(connection, manifest, manifest_hash):
    """Build-time checks can scan the index; requests only verify their blobs."""
    identity = connection.execute('SELECT schema, source_manifest_sha256, complete FROM index_info').fetchall()
    if identity != [(INDEX_SCHEMA, manifest_hash, 1)]:
        return False
    if connection.execute('PRAGMA quick_check').fetchall() != [('ok',)]:
        return False
    expected_countries = {entry['id'] for entry in manifest['countries']}
    countries = connection.execute('SELECT country_id FROM countries').fetchall()
    if len(countries) != len(expected_countries) or {row[0] for row in countries} != expected_countries:
        return False
    expected_metrics = {(country, metric) for country in expected_countries for metric in manifest['metric_ids']}
    metrics = connection.execute('SELECT country_id,metric_id FROM metric_values').fetchall()
    return len(metrics) == len(expected_metrics) and set(metrics) == expected_metrics


def prepare(data_root=None, output=None):
    data_root = Path(data_root) if data_root is not None else ROOT / 'data' / 'municipal'
    output = Path(output) if output is not None else DEFAULT_INDEX
    started = time.perf_counter()
    manifest = json.loads((data_root / 'manifest.json').read_bytes())
    manifest_hash = hashlib.sha256((data_root / 'manifest.json').read_bytes()).hexdigest()
    if output.is_file():
        try:
            with closing(sqlite3.connect(output.resolve().as_uri() + '?mode=ro', uri=True)) as cached:
                reusable = _complete(cached, manifest, manifest_hash)
            if reusable:
                return {'reused': True, 'schema': INDEX_SCHEMA, 'bytes': output.stat().st_size,
                        'source_manifest_sha256': manifest_hash, 'seconds': time.perf_counter() - started}
        except sqlite3.Error:
            pass
    output.parent.mkdir(parents=True, exist_ok=True)
    # Separate temporary files let concurrent builders finish independently;
    # neither builder may remove the other's in-progress database.
    with tempfile.NamedTemporaryFile(prefix=output.name + '.', suffix='.building', dir=output.parent, delete=False) as handle:
        temporary = Path(handle.name)
    store = MunicipalStore(data_root, index_path=output.with_name('.no-index-during-preparation'))
    connection = sqlite3.connect(temporary)
    try:
        connection.executescript('''
            PRAGMA journal_mode=OFF;
            CREATE TABLE index_info(schema TEXT, source_manifest_sha256 TEXT, complete INTEGER);
            CREATE TABLE countries(country_id TEXT PRIMARY KEY, payload BLOB NOT NULL, sha256 TEXT NOT NULL, json_bytes INTEGER NOT NULL) WITHOUT ROWID;
            CREATE TABLE metric_values(country_id TEXT, metric_id TEXT, payload BLOB NOT NULL, sha256 TEXT NOT NULL, json_bytes INTEGER NOT NULL, PRIMARY KEY(country_id,metric_id)) WITHOUT ROWID;
        ''')
        connection.execute('INSERT INTO index_info VALUES (?,?,0)', (INDEX_SCHEMA, manifest_hash))

        def encoded(value):
            raw = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf8')
            blob = gzip.compress(raw, compresslevel=1, mtime=0)
            return blob, hashlib.sha256(blob).hexdigest(), len(raw)

        for entry in manifest['countries']:
            data, _ = store._load(entry['id'])
            rows = data['rows']
            metadata = [{key: value for key, value in row.items() if key != 'values'} for row in rows]
            connection.execute('INSERT INTO countries VALUES (?,?,?,?)', (entry['id'], *encoded(metadata)))
            for position, metric in enumerate(manifest['metric_ids']):
                values = [row['values'][position] for row in rows]
                if any(not isinstance(value, list) or len(value) != 4 for value in values):
                    raise ValueError('Source municipal summary dimensions differ.')
                connection.execute('INSERT INTO metric_values VALUES (?,?,?,?,?)', (entry['id'], metric, *encoded(values)))
            connection.commit()
        connection.execute('UPDATE index_info SET complete=1')
        connection.commit()
        if not _complete(connection, manifest, manifest_hash):
            raise ValueError('Prepared municipal metric index integrity check failed.')
    except Exception:
        connection.close()
        temporary.unlink(missing_ok=True)
        raise
    connection.close()
    temporary.replace(output)
    return {'reused': False, 'schema': INDEX_SCHEMA, 'countries': len(manifest['countries']),
            'units': manifest['unit_count'], 'metrics': len(manifest['metric_ids']),
            'bytes': output.stat().st_size, 'source_manifest_sha256': manifest_hash,
            'seconds': time.perf_counter() - started}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', type=Path)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    print(json.dumps(prepare(args.data_root, args.output), indent=2))
