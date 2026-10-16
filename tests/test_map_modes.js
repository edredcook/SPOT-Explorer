'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const map = require(path.join(root, 'web/map.js'));
const d3 = require(path.join(root, 'web/vendor/d3.v7.9.0.min.js'));
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/results.json'), 'utf8'));
const geometry = JSON.parse(fs.readFileSync(path.join(root, 'web/assets/world_boundaries.geojson'), 'utf8'));

test('circle area stays proportional to the published value at every size', () => {
  const values = Object.values(data.national).map(row => row.outputs.plas_em.Mean);
  const maximum = Math.max(...values);
  for (const size of [.5, 1, 2]) {
    const referenceArea = map.symbolRadius(maximum, maximum, size) ** 2;
    for (const value of values) {
      const relativeArea = map.symbolRadius(value, maximum, size) ** 2 / referenceArea;
      assert.ok(Math.abs(relativeArea - value / maximum) < 1e-12);
    }
  }
  assert.equal(map.symbolRadius(0, maximum, 1), 0);
  assert.equal(map.symbolRadius(null, maximum, 1), 0);
  assert.equal(map.symbolRadius(3, 0, 1), 0);
  assert.equal(map.symbolRadius(100, 100, 2), 2 * map.symbolRadius(100, 100, 1));
});

test('zoom separates anchors while keeping circle and pie radii fixed on screen', () => {
  for(const zoom of [1,1.5,3,6]) {
    const radius=map.symbolRadius(25,100,1.5);
    assert.ok(Math.abs(radius*map.markerScale(zoom)*zoom-radius)<1e-12);
  }
  assert.equal(map.markerScale(0),1);
  assert.equal(map.markerScale(null),1);
});

test('mobile markers shrink with plot width without changing their area ratios', () => {
  assert.ok(Math.abs(map.symbolRadius(100,100,1,350)-12.25)<1e-12);
  assert.equal(map.symbolRadius(100,100,1,1100),34);
  assert.ok(Math.abs(map.symbolRadius(100,100,2,350)-24.5)<1e-12);
  for(const width of [300,350,700,1100]) {
    const large=map.symbolRadius(100,100,1,width),small=map.symbolRadius(25,100,1,width);
    assert.ok(Math.abs(large**2/small**2-4)<1e-12);
    for(const zoom of [1,3,6])assert.ok(Math.abs(large*map.markerScale(zoom)*zoom-large)<1e-12);
  }
});

test('multi-part boundaries yield one display location per native source entity', () => {
  const anchors = map.entityAnchors(geometry, d3);
  const ids = anchors.map(anchor => anchor.id);
  assert.equal(anchors.length, 246);
  assert.equal(new Set(ids).size, 246);
  assert.deepEqual(ids.slice().sort(), data.entities.map(entity => entity.id).sort());
  for (const anchor of anchors) {
    assert.ok(anchor.location.every(Number.isFinite));
    assert.ok(Math.abs(anchor.location[0]) <= 180);
    assert.ok(Math.abs(anchor.location[1]) <= 90);
  }
  const byId = new Map(anchors.map(anchor => [anchor.id, anchor.location]));
  const france = byId.get('FRA'), usa = byId.get('USA');
  assert.ok(france[0] > -6 && france[0] < 10 && france[1] > 40 && france[1] < 55);
  assert.ok(usa[0] > -125 && usa[0] < -66 && usa[1] > 24 && usa[1] < 50);
});

test('basis switches use native per-person indicators with their original units', () => {
  const definitions = new Map(data.metrics.filter(metric => metric.family === 'outputs').map(metric => [metric.id, metric]));
  for (const [total, perPerson] of Object.entries({plas_em:'plas_em_per_cap',plas_debris_em:'plas_debris_em_per_cap',plas_burn_em:'plas_burn_em_per_cap',wg:'wg_per_cap',pwg:'pwg_per_cap'})) {
    assert.equal(map.metricForBasis(total, 'total'), total);
    assert.equal(map.metricForBasis(total, 'per_capita'), perPerson);
    assert.ok(definitions.has(total) && definitions.has(perPerson));
    assert.notEqual(definitions.get(total).display_unit, definitions.get(perPerson).display_unit);
  }
  assert.equal(map.metricForBasis('col_cov_pct_gen_exc_lit', 'per_capita'), 'col_cov_pct_gen_exc_lit');
});

test('composition takes source means even when an input contains median point values', () => {
  const source = data.national.IND.outputs;
  const values = Object.fromEntries(['plas_em','plas_debris_em','plas_burn_em'].map(id => [id, {
    value:source[id].Median, mean:source[id].Mean, low:source[id]['5th percentile'],
    median:source[id].Median, high:source[id]['95th percentile']
  }]));
  const payload = {rows:[{id:'IND',name:'India',values}]};
  const [composition] = map.atlasRows(payload, {mode:'composition',metric:'plas_em'});
  const [ordinary] = map.atlasRows(payload, {mode:'choropleth',metric:'plas_em'});
  assert.equal(composition.value, source.plas_em.Mean);
  assert.equal(ordinary.value, source.plas_em.Median);
  assert.notEqual(composition.value, ordinary.value);
  assert.ok(Math.abs(composition.value - values.plas_debris_em.mean - values.plas_burn_em.mean) < 1e-7);
  assert.equal(composition.low, source.plas_em['5th percentile']);
});

test('per-person composition uses three native annual indicators with matching totals', () => {
  for(const entity of Object.values(data.national)) {
    const total=entity.outputs.plas_em_per_cap.Mean;
    const debris=entity.outputs.plas_debris_em_per_cap.Mean;
    const burned=entity.outputs.plas_burn_em_per_cap.Mean;
    assert.ok(Math.abs(total-debris-burned)<1e-8);
    assert.equal(map.metricForBasis('plas_em','per_capita'),'plas_em_per_cap');
    assert.equal(map.metricForBasis('plas_debris_em','per_capita'),'plas_debris_em_per_cap');
    assert.equal(map.metricForBasis('plas_burn_em','per_capita'),'plas_burn_em_per_cap');
  }
});

test('missing and zero stay distinct before marks and tables are built', () => {
  const rows = [{id:'ZER',values:{plas_em:{value:0,mean:0,low:0,median:0,high:0}}},
    {id:'NUL',values:{plas_em:{value:null,mean:null,low:null,median:null,high:null}}}];
  for (const mode of ['choropleth','symbols','composition']) {
    const transformed = map.atlasRows({rows}, {mode,metric:'plas_em'});
    assert.equal(transformed[0].value, 0);
    assert.equal(transformed[1].value, null);
  }
});

test('bivariate thirds have explicit, stable boundaries and never classify missing as zero', () => {
  const boundaries = map.thirds([0,1,2,3,4,5,6,7,8,null,NaN]);
  assert.deepEqual(boundaries, [8/3,16/3]);
  assert.equal(map.classIndex(0,boundaries),0);
  assert.equal(map.classIndex(boundaries[0],boundaries),0);
  assert.equal(map.classIndex(boundaries[1],boundaries),1);
  assert.equal(map.classIndex(8,boundaries),2);
  assert.equal(map.classIndex(null,boundaries),null);
  assert.deepEqual(map.thirds([]),[null,null]);
  for(const metric of ['col_cov_pct_gen_exc_lit','plas_em_per_cap']) {
    const values=Object.values(data.national).map(row=>row.outputs[metric].Mean),cuts=map.thirds(values);
    assert.ok(cuts.every(Number.isFinite));
    assert.equal(values.filter(value=>[0,1,2].includes(map.classIndex(value,cuts))).length,246);
  }
});
