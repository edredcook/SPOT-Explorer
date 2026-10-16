'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const profiles=require(path.join(root,'web/profiles.js'));
const bundle=JSON.parse(fs.readFileSync(path.join(root,'data/results.json'),'utf8'));
const rows=bundle.entities.map(entity=>({...entity,values:Object.fromEntries(Object.entries(bundle.national[entity.id].outputs).map(([id,statistics])=>[id,{mean:statistics.Mean,value:statistics.Mean,low:statistics['5th percentile'],median:statistics.Median,high:statistics['95th percentile']}]))}));
const near=(left,right)=>assert.ok(Math.abs(left-right)<=Math.max(1e-9,Math.abs(right)*1e-10),`${left} differs from ${right}`);

function parseCSV(text){
  const records=[];let row=[],cell='',quoted=false;
  text=text.replace(/^\ufeff/,'');
  for(let index=0;index<text.length;index++){
    const char=text[index];
    if(char==='"'){if(quoted&&text[index+1]==='"'){cell+='"';index++;}else quoted=!quoted;}
    else if(char===','&&!quoted){row.push(cell);cell='';}
    else if(char==='\n'&&!quoted){row.push(cell.replace(/\r$/,''));records.push(row);row=[];cell='';}
    else cell+=char;
  }
  return records;
}
function fixture(population=1000,total=10){
  return {id:'TST',name:'Test',population,values:{...Object.fromEntries(profiles.ORIGINS.map(origin=>[origin.id,{mean:2,value:2,low:1,median:1.5,high:3}])),plas_em:{mean:total,value:total},plas_em_per_cap:{mean:10,value:10}}};
}

test('five profile origins are native total-mass fields with exact released means',()=>{
  assert.deepEqual(profiles.ORIGINS.map(origin=>origin.id),['plas_litter_em','plas_uncol_em','plas_collection_em','plas_disp_em','plas_recy_em']);
  for(const origin of profiles.ORIGINS){
    const definition=bundle.metrics.find(metric=>metric.family==='outputs'&&metric.id===origin.id);
    assert.equal(definition.display_unit,'tonnes/year');
  }
  for(const row of rows){
    const result=profiles.profileValues(row,'total');
    assert.equal(result.complete,true);
    assert.equal(result.total,row.values.plas_em.mean);
    for(const segment of result.segments)assert.equal(segment.value,bundle.national[row.id].outputs[segment.id].Mean);
    near(result.sum,result.total);
    assert.equal(result.reconciles,true);
  }
});

test('additive shares are ratios of native means and use emissions rather than generation',()=>{
  for(const row of rows){
    const result=profiles.profileValues(row,'share');
    assert.equal(result.complete,true);
    assert.equal(result.total,100);
    near(result.sum,100);
    for(const segment of result.segments)assert.equal(segment.value,segment.nativeMean/row.values.plas_em.mean*100);
  }
  const india=rows.find(row=>row.id==='IND');
  const litter=profiles.profileValues(india,'share').segments[0].value;
  assert.notEqual(litter,india.values.plas_litter_em_pct_em.mean);
  assert.notEqual(litter,india.values.plas_litter_em.mean/india.values.pwg.mean*100);
});

test('derived per-person origins reconcile with the separately retained native total',()=>{
  for(const row of rows){
    const result=profiles.profileValues(row,'per_capita');
    assert.equal(result.complete,true);
    assert.equal(result.total,row.values.plas_em_per_cap.mean);
    for(const segment of result.segments)assert.equal(segment.value,segment.nativeMean*1000/row.population);
    near(result.sum,result.total);
    assert.equal(result.reconciles,true);
  }
});

test('missing source means remain missing even if a fallback point value is zero',()=>{
  const row=fixture();row.values.plas_litter_em={mean:null,value:0,low:null,median:null,high:null};
  for(const basis of ['total','per_capita','share']){
    const result=profiles.profileValues(row,basis);
    assert.equal(result.segments[0].value,null);
    assert.equal(result.segments[1].value,basis==='share'?20:2);
    assert.equal(result.complete,false);
    assert.equal(result.sum,null);
  }
});

test('known zeros, zero emissions and invalid population have different meanings',()=>{
  const zero=fixture();for(const origin of profiles.ORIGINS)zero.values[origin.id].mean=0;zero.values.plas_em.mean=0;zero.values.plas_em_per_cap.mean=0;
  for(const basis of ['total','per_capita']){
    const result=profiles.profileValues(zero,basis);
    assert.equal(result.complete,true);assert.equal(result.sum,0);assert.ok(result.segments.every(segment=>segment.value===0));
  }
  const undefinedShare=profiles.profileValues(zero,'share');
  assert.equal(undefinedShare.complete,false);assert.ok(undefinedShare.segments.every(segment=>segment.value===null));
  for(const population of [0,null,undefined,NaN,-1]){
    const row=fixture();row.population=population;
    const result=profiles.profileValues(row,'per_capita');
    assert.equal(result.complete,false);assert.ok(result.segments.every(segment=>segment.value===null));
    assert.equal(result.nativePerPerson,10);
  }
});

test('material source mismatch is detected without rewriting native values',()=>{
  const result=profiles.profileValues(fixture(1000,12),'total');
  assert.equal(result.total,12);assert.equal(result.sum,10);assert.equal(result.reconciles,false);
});

test('CSV contains only selected countries, exact native fields and declared transformations',()=>{
  const selected=rows.filter(row=>['IND','CHN','GBR','USA','BRA','NGA'].includes(row.id));
  for(const basis of ['total','per_capita','share']){
    const csv=profiles.profilesCSV(selected,basis,bundle.release),parsed=parseCSV(csv),headers=parsed.shift();
    assert.equal(parsed.length,30);assert.equal(csv[0],'\ufeff');
    for(const record of parsed){
      const row=Object.fromEntries(headers.map((header,index)=>[header,record[index]]));
      const source=selected.find(item=>item.id===row.entity_id),native=source.values[row.source_metric];
      assert.equal(Number(row.source_mean_tonnes_year),native.mean);
      assert.equal(Number(row.source_5th_tonnes_year),native.low);
      assert.equal(Number(row.source_median_tonnes_year),native.median);
      assert.equal(Number(row.source_95th_tonnes_year),native.high);
      assert.equal(Number(row.native_total_mean_tonnes_year),source.values.plas_em.mean);
      assert.equal(Number(row.native_total_mean_kg_person_year),source.values.plas_em_per_cap.mean);
      assert.equal(Number(row.population),source.population);
      assert.equal(row.display_basis,basis);assert.equal(row.display_unit,profiles.unit(basis));
      assert.equal(Number(row.display_value),profiles.profileValues(source,basis).segments.find(segment=>segment.id===row.source_metric).value);
      assert.equal(row.model_year,'2020');assert.equal(row.release,'V1.4.1-G-0426');
      assert.ok(row.calculation.includes(basis==='share'?'native total Mean':basis==='per_capita'?'supplied population':'native source Mean'));
    }
  }
});

test('CSV quotes names safely and keeps missing values distinct from numeric zero',()=>{
  const row=fixture();row.name='Quoted, "name"\r\nSecond line';row.values.plas_litter_em.mean=null;row.values.plas_uncol_em.mean=0;
  const parsed=parseCSV(profiles.profilesCSV([row],'total',bundle.release)),headers=parsed.shift();
  const records=parsed.map(record=>Object.fromEntries(headers.map((header,index)=>[header,record[index]])));
  assert.equal(records.length,5);assert.equal(records[0].entity_name,row.name);
  assert.equal(records[0].source_mean_tonnes_year,'');assert.equal(records[0].display_value,'');
  assert.equal(records[1].source_mean_tonnes_year,'0');assert.equal(records[1].display_value,'0');
});
