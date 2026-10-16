'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const ranks=require('../web/rankings.js');
const data=JSON.parse(fs.readFileSync(path.resolve(__dirname,'../data/results.json'),'utf8'));
const rows=data.entities.map(entity=>({...entity,values:Object.fromEntries(Object.values(ranks.METRICS).map(id=>{
  const source=data.national[entity.id].outputs[id];
  return [id,{value:-999,mean:source.Mean,median:source.Median,low:source['5th percentile'],high:source['95th percentile']}];
}))}));
function fixture(id,total,perPerson,percent,extra={}){
  return {id,name:id,region:'Asia',income:'LMC',...extra,values:{
    plas_em:{mean:total,median:total===null?null:total/2,low:total===null?null:total/4,high:total===null?null:total*1.2},
    plas_em_per_cap:{mean:perPerson,median:perPerson===null?null:perPerson/2,low:0,high:perPerson===null?null:perPerson*2},
    plas_em_pct_pwg:{mean:percent,median:percent===null?null:percent/2,low:0,high:percent===null?null:Math.min(100,percent*2)}
  }};
}
function parseCSV(text){
  const lines=[];let row=[],cell='',quoted=false;
  for(let i=0;i<text.length;i++){
    const ch=text[i];if(i===0&&ch==='\ufeff')continue;
    if(ch==='"'){if(quoted&&text[i+1]==='"'){cell+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){row.push(cell);cell='';}
    else if(ch==='\r'&&text[i+1]==='\n'&&!quoted){row.push(cell);lines.push(row);row=[];cell='';i++;}
    else cell+=ch;
  }
  if(cell||row.length){row.push(cell);lines.push(row);}return lines;
}
test('exact source ties use competition ranks, zero is ranked and missing/nonfinite are excluded',()=>{
  const input=[fixture('DDD',0,1,1),fixture('CCC',2,1,1),fixture('BBB',5,1,1),fixture('AAA',5,1,1),fixture('EEE',null,1,1),fixture('FFF',NaN,1,1),fixture('GGG',Infinity,1,1)];
  const actual=ranks.rankMetric(input,'plas_em','Mean');
  assert.deepEqual([...actual],[['AAA',1],['BBB',1],['CCC',3],['DDD',4]]);
  assert.equal(actual.has('EEE'),false);assert.equal(actual.has('FFF'),false);assert.equal(actual.has('GGG'),false);
  assert.deepEqual([...ranks.rankMetric(input.slice().reverse(),'plas_em','Mean')],[...actual]);
});
test('duplicate reporting IDs are rejected rather than silently merged',()=>{
  assert.throws(()=>ranks.rankMetric([fixture('AAA',1,2,3),fixture('AAA',4,5,6)],'plas_em','Mean'),/Duplicate reporting entity/);
});
test('central summaries use explicit native fields, never the request-selected value alias',()=>{
  const row=fixture('AAA',1000,7,.731,{population:100});
  row.values.plas_em.value=999999;
  assert.equal(ranks.central(row,'plas_em','Mean'),1000);
  assert.equal(ranks.central(row,'plas_em','Median'),500);
  const record=ranks.buildRecords([row],{region:'all',income:'all'},'Mean')[0];
  assert.equal(record.values.perPerson.value,7);
  assert.equal(record.values.percent.value,.731);
  assert.notEqual(record.values.percent.value,1000/2000*100);
  assert.notEqual(record.values.perPerson.value,1000/100*1000);
  assert.equal(record.values.percent.low,0);
  assert.equal(ranks.central({values:{plas_em:{value:4}}},'plas_em','Mean'),null);
});
test('filters change only filtered ranks and keep the full registry and global ranks',()=>{
  const input=[fixture('AAA',100,3,20),fixture('BBB',80,5,30,{region:'Europe',income:'HIC'}),fixture('CCC',20,4,70),fixture('DDD',0,0,0)];
  const snapshot=JSON.stringify(input);
  const records=ranks.buildRecords(input,{region:'Asia',income:'all'},'Mean');
  assert.equal(records.length,4);assert.equal(records.find(r=>r.id==='BBB').inFilters,false);
  assert.equal(records.find(r=>r.id==='CCC').globalRanks.total,3);
  assert.equal(records.find(r=>r.id==='CCC').ranks.total,2);
  assert.equal(records.find(r=>r.id==='BBB').ranks.total,null);
  assert.equal(records.find(r=>r.id==='DDD').ranks.total,3);
  assert.equal(JSON.stringify(input),snapshot);
});
test('plot limit and highlight never restrict the underlying country registry',()=>{
  const records=ranks.buildRecords([fixture('AAA',100,2,50),fixture('BBB',70,10,30),fixture('CCC',20,9,80),fixture('DDD',0,0,0)],{},'Mean');
  assert.deepEqual(ranks.plotRows(records,'ranks','total',2,null).rows.map(r=>r.id),['AAA','BBB']);
  const highlighted=ranks.plotRows(records,'ranks','total',2,'CCC');
  assert.deepEqual(highlighted.rows.map(r=>r.id),['AAA','BBB','CCC']);assert.equal(highlighted.extraSelected,true);
  assert.deepEqual(ranks.plotRows(records,'ranks','perPerson',2,null).rows.map(r=>r.id),['BBB','CCC']);
  assert.deepEqual(ranks.plotRows(records,'percent','total',2,null).rows.map(r=>r.id),['CCC','AAA']);
  assert.equal(records.length,4);
  const filtered=ranks.buildRecords([fixture('AAA',100,2,50),fixture('BBB',70,10,30,{region:'Europe'})],{region:'Asia'},'Mean');
  assert.deepEqual(ranks.plotRows(filtered,'ranks','total',5,'BBB').rows.map(r=>r.id),['AAA']);
});
test('ties at the plot cutoff are retained without calling them extra selected countries',()=>{
  const records=ranks.buildRecords([fixture('AAA',100,2,50),fixture('BBB',100,10,30),fixture('CCC',20,9,80)],{},'Mean');
  const shown=ranks.plotRows(records,'ranks','total',1,'BBB');
  assert.deepEqual(shown.rows.map(row=>row.id),['AAA','BBB']);
  assert.equal(shown.extraTies,1);assert.equal(shown.extraSelected,false);
});
test('all246 source entities retain original mean/median/bounds and independently calculated ranks',()=>{
  assert.equal(rows.length,246);
  for(const statistic of ['Mean','Median']){
    const records=ranks.buildRecords(rows,{region:'all',income:'all'},statistic);
    assert.equal(records.length,246);
    for(const record of records){
      for(const [key,id] of Object.entries(ranks.METRICS)){
        const native=data.national[record.id].outputs[id];
        assert.equal(record.values[key].value,native[statistic]);
        assert.equal(record.values[key].mean,native.Mean);
        assert.equal(record.values[key].median,native.Median);
        assert.equal(record.values[key].low,native['5th percentile']);
        assert.equal(record.values[key].high,native['95th percentile']);
        const expected=typeof native[statistic]==='number'&&Number.isFinite(native[statistic])?1+rows.filter(row=>ranks.central(row,id,statistic)>native[statistic]&&ranks.central(row,id,statistic)!==null).length:null;
        assert.equal(record.globalRanks[key],expected);
        assert.equal(record.ranks[key],expected);
      }
    }
  }
});
test('CSV retains all countries, exact source fields, rank scope, zeros and missingness',()=>{
  const records=ranks.buildRecords(rows,{region:'Europe',income:'all'},'Median');
  const parsed=parseCSV(ranks.buildCSV(records,{release:'V1.4.1-G-0426',year:2020,statistic:'Median',region:'Europe',income:'all',displayed:['IND']}));
  assert.equal(parsed.length,247);const header=parsed[0],byId=new Map(parsed.slice(1).map(row=>[row[header.indexOf('entity_id')],row]));
  assert.equal(byId.size,246);
  const native=data.national.IND.outputs;
  const india=byId.get('IND');
  for(const [key,id] of Object.entries(ranks.METRICS)){
    assert.equal(india[header.indexOf(id+'_value')],String(native[id].Median));
    assert.equal(india[header.indexOf(id+'_mean')],String(native[id].Mean));
    assert.equal(india[header.indexOf(id+'_median')],String(native[id].Median));
    assert.equal(india[header.indexOf(id+'_5th')],String(native[id]['5th percentile']));
    assert.equal(india[header.indexOf(id+'_95th')],String(native[id]['95th percentile']));
    assert.equal(india[header.indexOf(id+'_filtered_rank')],'');
    assert.equal(india[header.indexOf(id+'_unit')],ranks.UNITS[key]);
  }
  assert.equal(india[header.indexOf('in_filters')],'false');
  assert.equal(india[header.indexOf('income_classification_year')],'');
  assert.equal(india[header.indexOf('rank_method')],'competition_exact_ties');
  const fixtureRecords=ranks.buildRecords([fixture('AAA',0,0,0,{name:'A, "quoted"'}),fixture('BBB',null,null,null)],{},'Mean');
  const fixtureCSV=parseCSV(ranks.buildCSV(fixtureRecords,{release:'test',statistic:'Mean'}));
  assert.equal(fixtureCSV[1][3],'A, "quoted"');
  assert.equal(fixtureCSV[1][header.indexOf('plas_em_value')],'0');
  assert.equal(fixtureCSV[2][header.indexOf('plas_em_value')],'');
  assert.equal(fixtureCSV[2][header.indexOf('plas_em_global_rank')],'');
});
