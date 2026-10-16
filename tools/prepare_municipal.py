"""Prepare exact country-lazy SPOT municipal summaries from the published XLSX.

Run with the bundled data-preparation Python (lxml required). This reads source
files only, creates deterministic gzip/JSON assets, and never runs the R model.
The full municipal XLSX must stay outside the website repository.
"""
from __future__ import annotations

import argparse
from collections import Counter
import csv
import gzip
import hashlib
import io
import json
import math
from pathlib import Path
import time
import zipfile

from lxml import etree as ET

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = 'spot-municipal/v1'
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
STATISTICS = ['Mean', 'Median', '5th percentile', '95th percentile']
SOURCE_STATISTICS = ['Mean', '5th percentile', 'Lower quartile', 'Median', 'Upper quartile', '95th percentile']
EMPTY_AREA_ID = '__no_admin_1__'


def checksum(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def shared_strings(archive):
    result = []
    with archive.open('xl/sharedStrings.xml') as stream:
        for _, item in ET.iterparse(stream, events=('end',), tag=NS + 'si'):
            result.append(''.join(child.text or '' for child in item.iter(NS + 't')))
            item.clear()
            while item.getprevious() is not None:
                del item.getparent()[0]
    return result


def sheet_rows(archive, part, strings, columns=None):
    with archive.open(part) as stream:
        for _, row in ET.iterparse(stream, events=('end',), tag=NS + 'row'):
            values = {}
            for cell in row:
                col = cell.attrib.get('r', '').rstrip('0123456789')
                if columns is not None and col not in columns:
                    continue
                value = cell.find(NS + 'v')
                value = value.text if value is not None else None
                if cell.attrib.get('t') == 's' and value is not None:
                    value = strings[int(value)]
                elif cell.attrib.get('t') == 'inlineStr':
                    value = ''.join(child.text or '' for child in cell.iter(NS + 't'))
                values[col] = value
            yield int(row.attrib['r']), values
            row.clear()
            while row.getprevious() is not None:
                del row.getparent()[0]


def parts(archive):
    workbook = ET.fromstring(archive.read('xl/workbook.xml'))
    rels = ET.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
    targets = {row.attrib['Id']: row.attrib['Target'] for row in rels}
    result = {}
    for sheet in workbook.find(NS + 'sheets'):
        target = targets[sheet.attrib['{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id']]
        result[sheet.attrib['name']] = target.lstrip('/') if target.startswith('/') else 'xl/' + target
    return result


def numeric(value):
    if value is None or value == '':
        return None
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('Source contains nonfinite municipal data.')
    return result


def encode(value):
    return json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(',', ':')).encode('utf-8')


def write_country(output, country_id, country_name, rows, metric_ids):
    value = {'schema': SCHEMA, 'country_id': country_id, 'metric_ids': metric_ids,
             'statistics': STATISTICS, 'rows': rows}
    raw = encode(value)
    memory = io.BytesIO()
    # Fixed mtime and empty filename make gzip bytes independent of build time.
    with gzip.GzipFile(fileobj=memory, mode='wb', filename='', compresslevel=9, mtime=0) as stream:
        stream.write(raw)
    compressed = memory.getvalue()
    filename = country_id + '.json.gz'
    temporary = output / (filename + '.tmp')
    temporary.write_bytes(compressed)
    temporary.replace(output / filename)
    areas = {}
    for row in rows:
        source_name = row['admin_names'][0]
        area_id = source_name or EMPTY_AREA_ID
        if source_name == EMPTY_AREA_ID:
            raise ValueError('Source area collides with the explicit missing-area sentinel.')
        area = areas.setdefault(area_id, {'id': area_id, 'name': source_name, 'count': 0})
        area['count'] += 1
    return {'id': country_id, 'name': country_name, 'units': len(rows),
            'no_modelled_population_units': sum(row['status'] == 'no_modelled_population' for row in rows),
            'areas': list(areas.values()), 'file': filename, 'bytes': len(compressed),
            'json_bytes': len(raw), 'sha256': hashlib.sha256(compressed).hexdigest()}


def prepare(source, output, qa):
    started = time.monotonic()
    output.mkdir(parents=True, exist_ok=True)
    qa.mkdir(parents=True, exist_ok=True)
    input_file = source / '04-MFA/inputs/Monte Carlo MFA Inputs.xlsx'
    result_file = source / '04-MFA/outputs/SPOT_MFA_Municipal_results_V1.4.1-G-0426_2000i.xlsx'
    bundle = json.loads((ROOT / 'data/results.json').read_bytes())
    national_metrics = {row['id']: row for row in bundle['metrics'] if row['family'] == 'outputs'}
    registry = {}
    with zipfile.ZipFile(input_file) as archive:
        strings = shared_strings(archive)
        for row_number, values in sheet_rows(archive, parts(archive)['MFA_inputs'], strings, set('ABCDEFGHI')):
            if row_number < 4:
                continue
            uid = values.get('A')
            if not uid:
                continue
            if uid in registry:
                raise ValueError('Source municipal identifier is duplicated.')
            registry[uid] = {'country_id': values.get('B'), 'name': values.get('H'),
                             'admin_names': [values.get(col) for col in 'DEFG'],
                             'population': numeric(values.get('I'))}
    print('Input registry ready:', len(registry), 'units', round(time.monotonic() - started, 1), 'seconds', flush=True)
    countries, seen_units, seen_countries = [], set(), set()
    current_unit, unit_statistics = None, set()
    current_country, country_name, country_rows = None, None, []
    source_count, source_stats = 0, Counter()
    negatives, status_counts = [], Counter()
    metric_minimum = {}

    def finish_unit():
        if current_unit is not None:
            if unit_statistics != set(SOURCE_STATISTICS):
                raise ValueError('A municipal unit lacks the six released summary statistics.')
            country_rows.append(current_unit)

    with zipfile.ZipFile(result_file) as archive:
        sheets = parts(archive)
        strings = shared_strings(archive)
        legends = {}
        for row_number, values in sheet_rows(archive, sheets['03a_Outputs_legend'], strings):
            if row_number > 1 and values.get('A'):
                legends[values['A']] = {'id': values['A'], 'name': values.get('C'), 'description': values.get('C'),
                                        'unit': values.get('D'), 'source_legend_row': row_number}
        for row_number, values in sheet_rows(archive, sheets['Outputs'], strings):
            if row_number == 1:
                metric_columns = [(col, value) for col, value in values.items() if col not in set('ABCDEFGHIJKLMN')]
                metric_ids = [metric for _, metric in metric_columns]
                if len(metric_ids) != 68 or set(metric_ids) != set(national_metrics):
                    raise ValueError('Municipal output fields do not match the published national dictionary.')
                continue
            source_count += 1
            uid, iso, statistic = values.get('J'), values.get('C'), values.get('A')
            source_stats[statistic] += 1
            if statistic not in SOURCE_STATISTICS:
                raise ValueError('Unexpected source summary statistic.')
            if current_unit is None or uid != current_unit['id']:
                finish_unit()
                if iso != current_country:
                    if current_country is not None:
                        countries.append(write_country(output, current_country, country_name, country_rows, metric_ids))
                    if iso in seen_countries:
                        raise ValueError('Country rows are not contiguous in the source.')
                    seen_countries.add(iso)
                    current_country, country_name, country_rows = iso, values.get('B'), []
                source_unit = registry[uid]
                if uid in seen_units or source_unit['country_id'] != iso or uid.split('.', 1)[0] != iso:
                    raise ValueError('Invalid native municipal key/country relationship.')
                if source_unit['name'] != values.get('I'):
                    raise ValueError('Input and result municipal names differ.')
                population = numeric(values.get('K'))
                if not math.isclose(source_unit['population'], population, rel_tol=1e-12, abs_tol=1e-8):
                    raise ValueError('Input and result municipal populations differ.')
                seen_units.add(uid)
                current_unit = {'id': uid, 'name': values.get('I'), 'population': population,
                                'admin_names': source_unit['admin_names'], 'rural_share': numeric(values.get('L')),
                                'urban_class_1': values.get('M'), 'urban_class_2': values.get('N'),
                                'status': 'no_modelled_population' if population == 0 else 'modelled',
                                'values': [[None] * 4 for _ in metric_ids]}
                status_counts[current_unit['status']] += 1
                unit_statistics = set()
            if statistic in unit_statistics:
                raise ValueError('Duplicate municipal summary statistic.')
            unit_statistics.add(statistic)
            slot = STATISTICS.index(statistic) if statistic in STATISTICS else None
            for position, (col, metric) in enumerate(metric_columns):
                value = numeric(values.get(col))
                if value is not None:
                    metric_minimum[metric] = min(metric_minimum.get(metric, value), value)
                    if value < 0:
                        negatives.append({'id': uid, 'country_id': iso, 'source_cell': col + str(row_number),
                                          'statistic': statistic, 'metric': metric, 'value': value})
                if slot is not None:
                    current_unit['values'][position][slot] = value
            if source_count % 60000 == 0:
                print('Output rows:', source_count, 'seconds:', round(time.monotonic() - started, 1), flush=True)
        finish_unit()
        if current_country is not None:
            countries.append(write_country(output, current_country, country_name, country_rows, metric_ids))
    if seen_units != set(registry) or len(countries) != 246 or source_count != len(registry) * 6:
        raise ValueError('Municipal source coverage check failed.')
    metrics = []
    for col, metric in metric_columns:
        definition = legends[metric]
        national = national_metrics[metric]
        metrics.append({**definition, 'family': 'outputs', 'display_unit': national.get('display_unit', definition['unit']),
                        'unit_note': national.get('unit_note'), 'source_sheet': 'Outputs', 'source_field': metric,
                        'source_range': f'{col}2:{col}{source_count + 1}',
                        'source_legend_sheet': '03a_Outputs_legend',
                        'source_legend_range': f"A{definition['source_legend_row']}:D{definition['source_legend_row']}"})
    manifest = {'schema': SCHEMA, 'release': bundle['release'], 'statistics': STATISTICS,
                'source_statistics': SOURCE_STATISTICS, 'metric_ids': metric_ids, 'metrics': metrics,
                'unit_count': len(registry), 'no_modelled_population_unit_count': status_counts['no_modelled_population'],
                'countries': countries, 'empty_area_id': EMPTY_AREA_ID,
                'native_id_country_prefix_verified': True,
                'sources': [{'file': '04-MFA/outputs/' + result_file.name, 'bytes': result_file.stat().st_size,
                             'sha256': checksum(result_file), 'sheet': 'Outputs', 'range': f'A1:CD{source_count + 1}'},
                            {'file': '04-MFA/inputs/' + input_file.name, 'bytes': input_file.stat().st_size,
                             'sha256': checksum(input_file), 'sheet': 'MFA_inputs', 'range': 'A3:I50705'}],
                'notes': ['Published modelled 2020 municipal reporting units use mixed administrative levels and custom merged boundaries.',
                          'Native summaries and nulls are preserved; marginal quantiles must not be summed to construct national or regional intervals.',
                          'Zero modelled population has unavailable results, not zero emissions.',
                          'Small negative numerical residuals remain as supplied; no clipping or numerical adjustment is applied.',
                          'National and supra-national views must use their separately released summaries.']}
    temporary = output / 'manifest.json.tmp'
    temporary.write_bytes(encode(manifest))
    temporary.replace(output / 'manifest.json')
    qa_summary = {'source_rows': source_count, 'units': len(registry), 'country_count': len(countries),
                  'source_statistics': dict(source_stats), 'selected_statistics': STATISTICS,
                  'status_counts': dict(status_counts), 'negative_source_values': negatives,
                  'metric_minimum': metric_minimum, 'gzip_bytes': sum(c['bytes'] for c in countries),
                  'json_bytes': sum(c['json_bytes'] for c in countries),
                  'largest_chunks': sorted(countries, key=lambda c: c['json_bytes'], reverse=True)[:5],
                  'elapsed_seconds': round(time.monotonic() - started, 2)}
    (qa / 'extraction_qa.json').write_bytes(encode(qa_summary))
    print('DONE', json.dumps({key: qa_summary[key] for key in ['units', 'country_count', 'gzip_bytes', 'json_bytes', 'elapsed_seconds']}), flush=True)
    print('NEGATIVES', len(negatives), 'largest magnitude', max((abs(r['value']) for r in negatives), default=0), flush=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, default=ROOT.parent / 'MFA_V1.4.1-G-0426')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'data/municipal')
    parser.add_argument('--qa-dir', type=Path, default=ROOT.parent / 'review_20261016/municipal_audit')
    args = parser.parse_args()
    prepare(args.source_root.resolve(), args.output_dir.resolve(), args.qa_dir.resolve())
