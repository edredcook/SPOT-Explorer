'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const map=require('../web/map.js'),municipal=require('../web/multiscale.js'),d3=require('../web/vendor/d3.v7.9.0.min.js');
const data=JSON.parse(fs.readFileSync(path.join(__dirname,'../data/results.json'),'utf8'));
const geometry=JSON.parse(fs.readFileSync(path.join(__dirname,'../web/assets/world_boundaries.geojson'),'utf8'));

test('country, region and income scope preserve native records, including zero and null',()=>{
  const rows=[{id:'A',region:'Asia',income:'LIC',value:0},{id:'B',region:'Asia',income:'HIC',value:null},{id:'C',region:'Europe',income:'HIC',value:20}];
  const before=JSON.stringify(rows);
  assert.deepEqual(map.scopeRows(rows,'national',{country:'all',region:'Asia',income:'all'}),rows.slice(0,2));
  assert.equal(map.scopeRows(rows,'national',{country:'B',region:'Asia',income:'HIC'})[0].value,null);
  assert.equal(map.scopeRows(rows,'national',{country:'A',region:'Europe',income:'all'}).length,0);
  assert.equal(map.scopeRows(rows,'national',{country:'all',region:'all',income:'LIC'})[0].value,0);
  assert.equal(JSON.stringify(rows),before);
});

test('regional scope selects whole released groups and never applies income intersections',()=>{
  const rows=[{id:'region:asia',members:['IND','CHN'],value:7,low:2,high:20},{id:'region:europe',members:['GBR'],value:4}];
  const actual=map.scopeRows(rows,'regional',{country:'IND',region:'Europe',income:'HIC'});
  assert.equal(actual.length,1);assert.equal(actual[0],rows[0]);assert.deepEqual(actual[0].members,['IND','CHN']);
  assert.deepEqual(map.scopeRows(rows,'regional',{country:'all'}),rows);
  assert.throws(()=>map.memberIndex([...rows,{id:'region:other',members:['IND']}]),/more than one/);
});

test('group polygons reuse native values while circles remain one per group',()=>{
  const groups=data.groups.filter(row=>row.scheme==='UN Region').map(group=>({...group,members:data.entities.filter(entity=>entity.region===group.name).map(entity=>entity.id),values:{plas_em:{value:data.aggregated[group.id].outputs.plas_em.Mean,mean:data.aggregated[group.id].outputs.plas_em.Mean,low:data.aggregated[group.id].outputs.plas_em['5th percentile'],high:data.aggregated[group.id].outputs.plas_em['95th percentile']}}}));
  const rows=map.atlasRows({rows:groups},{metric:'plas_em',mode:'choropleth'}),joined=map.displayGeometry(geometry,rows,'regional'),anchors=map.entityAnchors(joined,d3);
  assert.equal(rows.length,6);assert.equal(anchors.length,6);assert.equal(new Set(anchors.map(row=>row.id)).size,6);
  const index=map.memberIndex(rows);
  for(const feature of joined.features){const country=feature.properties.country_id;assert.equal(feature.properties.spot_id,index.get(country)||null);}
  for(const row of rows){const native=data.aggregated[row.id].outputs.plas_em;assert.equal(row.value,native.Mean);assert.equal(row.low,native['5th percentile']);assert.equal(row.high,native['95th percentile']);}
  assert.equal(geometry.features.find(feature=>feature.properties.spot_id==='IND').properties.country_id,undefined);
});

test('municipal Mercator camera fits real bounds and round-trips click locations including date wrapping',()=>{
  for(const bounds of [[68,6,98,36],[170,-22,190,-10],[176,-20,-178,-12],[-6,49,2,59]]){
    const base=municipal.fitMercator(bounds,1000,600);assert.ok(base&&Number.isFinite(base.scale));
    const transform={k:5,x:-70,y:20},projection=municipal.camera(base,transform);
    const east=bounds[2]<bounds[0]?bounds[2]+360:bounds[2];
    for(const lon of[bounds[0],(bounds[0]+east)/2,east]){
      const lat=(bounds[1]+bounds[3])/2,x=lon*Math.PI/180*projection.scale+projection.tx,y=-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))*projection.scale+projection.ty;
      const actual=municipal.inverseMercator(x,y,projection),expected=((lon+180)%360+360)%360-180;
      assert.ok(Math.abs(actual[0]-expected)<1e-9);assert.ok(Math.abs(actual[1]-lat)<1e-9);
    }
  }
  for(const bounds of [null,[0,1,0,2],[1,2,3,1],[0,0,Infinity,1]])assert.equal(municipal.fitMercator(bounds,1000,600),null);
});

test('temporary raster zoom maps the prior image onto the current camera without changing data',()=>{
  const base={scale:120,tx:300,ty:200},old={k:2,x:7,y:-8},current={k:5,x:17,y:-20};
  const delta=municipal.imageTransform(current,old),a=municipal.camera(base,old),b=municipal.camera(base,current);
  for(const point of[[.5,.7],[-1,2],[3,-2]]){
    const oldPoint=[point[0]*a.scale+a.tx,point[1]*a.scale+a.ty],newPoint=[point[0]*b.scale+b.tx,point[1]*b.scale+b.ty];
    assert.ok(Math.abs(oldPoint[0]*delta.k+delta.x-newPoint[0])<1e-10);assert.ok(Math.abs(oldPoint[1]*delta.k+delta.y-newPoint[1])<1e-10);
  }
});

test('municipal CSV preserves native negative residuals, zero, null, identifiers and scope',()=>{
  const rows=[{id:'IND.1_1',name:'A, "quoted"',admin_names:['Area',null,'Town'],population:0,status:'matched',values:{plas_em:{mean:-1e-13,median:0,low:null,high:1}}},{id:'IND.2_1',name:'No location',admin_names:[],population:null,status:'unmatched',values:{plas_em:{mean:0,median:null,low:0,high:0}}}];
  assert.equal(municipal.metricValue(rows[0],'plas_em','Mean'),-1e-13);assert.equal(municipal.metricValue(rows[1],'plas_em','Median'),null);assert.equal(municipal.metricValue(null,'plas_em','Mean'),null);
  const csv=municipal.municipalCSV(rows,{country:'IND',area:'Area',metric:'plas_em',statistic:'Mean',release:'test',unit:'tonnes/year'});
  assert.match(csv,/"A, ""quoted"""/);assert.match(csv,/"-1e-13"/);assert.match(csv,/"IND","Area","IND.1_1"/);assert.match(csv,/"mean","median","5th_percentile","95th_percentile"/);
  assert.match(csv,/"model_status"/);assert.doesNotMatch(csv,/"geometry_status"/);
  assert.equal(csv.trimEnd().split('\r\n').length,3);assert.match(csv,/"unmatched","plas_em","Mean","0","0",,"0","0"/);
});

test('new municipal requests abort prior loads and reject stale completion tickets',()=>{
  const gate=municipal.requestGate(),first=gate.begin();let aborted=false;first.signal.addEventListener('abort',()=>{aborted=true;});
  assert.equal(gate.current(first),true);const second=gate.begin();assert.equal(aborted,true);assert.equal(gate.current(first),false);assert.equal(gate.current(second),true);
  gate.cancel();assert.equal(second.signal.aborted,true);assert.equal(gate.current(second),false);const retry=gate.begin();assert.equal(gate.current(retry),true);
});

test('municipal payload joins require the requested country, metric, area, statistic and unique native IDs',()=>{
  const scope={country:'IND',metric:'plas_em',statistic:'Mean',area:''};
  const payload={country:{id:'IND'},metric:{id:'plas_em'},statistic:'Mean',area:null,rows:[{id:'native.1',name:'A',values:{plas_em:{value:-1e-12,mean:-1e-12,median:0,low:null,high:2}}}]};
  assert.equal(municipal.validatePayload(payload,scope),payload);
  for(const invalid of [{...payload,country:{id:'CHN'}},{...payload,metric:{id:'pwg'}},{...payload,statistic:'Median'},{...payload,area:'Other'},{...payload,rows:[payload.rows[0],payload.rows[0]]},{...payload,rows:[{...payload.rows[0],values:{plas_em:{value:0,mean:0,median:0,low:NaN,high:2}}}]}])assert.throws(()=>municipal.validatePayload(invalid,scope));
});

test('PNG viewport caps preserve screen-to-geography mapping on small and large displays',()=>{
  const projection={scale:1200,tx:-3200,ty:800};
  for(const [width,height]of[[350,220],[1800,1200],[3840,2160],[500,80]]){
    const raster=municipal.rasterViewport(width,height,projection);assert.ok(raster);assert.ok(raster.width>=100&&raster.width<=2000);assert.ok(raster.height>=100&&raster.height<=1400);assert.ok(raster.width*raster.height<=2000000);
    for(const [x,y]of[[0,0],[width/2,height/2],[width,height]]){
      const actual=municipal.inverseMercator(x*raster.ratio,y*raster.ratio,raster),expected=municipal.inverseMercator(x,y,projection);
      assert.ok(Math.abs(actual[0]-expected[0])<1e-10);assert.ok(Math.abs(actual[1]-expected[1])<1e-10);
    }
  }
  assert.equal(municipal.rasterViewport(10000,40,projection),null);
});

test('municipal wheel zoom requires control while pointer pan and touch stay available',()=>{
  assert.equal(municipal.zoomGesture({type:'wheel',button:0,ctrlKey:false}),false);
  assert.equal(municipal.zoomGesture({type:'wheel',button:0,ctrlKey:true}),true);
  assert.equal(municipal.zoomGesture({type:'mousedown',button:0}),true);
  assert.equal(municipal.zoomGesture({type:'mousedown',button:2}),false);
  assert.equal(municipal.zoomGesture({type:'touchstart'}),true);
});

test('Natural Earth basemap and municipal raster share Mercator camera, including wrapped copies',()=>{
  for(const bounds of[[68,6,98,36],[176,-20,-178,-12],[-180,-80,180,85]]){
    const base=municipal.fitMercator(bounds,1000,600),projection=d3.geoMercator().scale(base.scale).translate([base.tx,base.ty]),east=bounds[2]<bounds[0]?bounds[2]+360:bounds[2],lon=(bounds[0]+east)/2,lat=(bounds[1]+bounds[3])/2;
    const point=projection([lon,lat]),expected=[lon*Math.PI/180*base.scale+base.tx,-Math.log(Math.tan(Math.PI/4+lat*Math.PI/360))*base.scale+base.ty];
    assert.ok(municipal.worldShifts(base,1000).some(shift=>Math.abs(point[0]+shift-expected[0])<1e-8));
    assert.ok(Math.abs(point[1]-expected[1])<1e-8);
  }
});

test('linked country callbacks preserve municipal selection and reload only a different recognised country',()=>{
  const countries=new Map([['IND',{}],['GBR',{}]]),state={level:'municipal',country:'IND',sourceSelected:'IND',selected:'IND',rows:[{id:'IND',value:999}]};
  assert.equal(map.linkedSelection(state,'IND',countries),'retain');
  assert.equal(state.country,'IND');assert.equal(state.sourceSelected,'IND');
  const before=JSON.stringify(state);assert.equal(map.linkedSelection(state,'un-region:asia',countries),'ignore');assert.equal(JSON.stringify(state),before);
  assert.equal(map.linkedSelection(state,'GBR',countries),'reload');assert.equal(state.country,'GBR');assert.equal(state.sourceSelected,'GBR');
  assert.equal(map.linkedSelection(state,'GBR',countries),'retain');
  state.level='regional';state.rows=[{id:'un-region:europe',members:['GBR']}];assert.equal(map.linkedSelection(state,'GBR',countries),'render');assert.equal(state.selected,'un-region:europe');
  state.level='national';assert.equal(map.linkedSelection(state,'IND',countries),'render');assert.equal(state.selected,'IND');
});

test('world context hits return native countries only, leaving municipality lookup to the server',()=>{
  const ids=new Set(data.entities.map(entity=>entity.id));
  for(const [point,expected]of[[[78,22],'IND'],[[-52,-12],'BRA'],[[-2,54],'GBR'],[[12,51],'DEU']])assert.equal(municipal.countryAtPoint(geometry,point,d3,ids,'IND'),expected);
  assert.equal(municipal.countryAtPoint(geometry,[0,-30],d3,ids,'IND'),null);
  assert.equal(municipal.countryAtPoint(geometry,[78,22],d3,new Set(['GBR']),'GBR'),null);
  const land=geometry.features.find(feature=>feature.properties.spot_id==='IND'),overlap={type:'FeatureCollection',features:[{...land,properties:{...land.properties,spot_id:'GBR'}},land]};
  assert.equal(municipal.countryAtPoint(overlap,[78,22],d3,ids,'IND'),'IND');
  assert.equal(municipal.countryAtPoint(null,[78,22],d3,ids,'IND'),null);
});

test('explicit municipal world camera clips exactly one world while country fits retain wrapping',()=>{
  const frame=[-180,-80,180,85],base=municipal.fitMercator(frame,970,480),identity={k:1,x:0,y:0};
  const clip=municipal.worldWindow(base,identity,970,frame);
  assert.ok(clip[0]>0&&clip[1]<970);assert.ok(Math.abs((clip[0]+clip[1])/2-485)<1e-9);
  assert.ok(clip[0]/2<clip[0]);assert.ok((970+clip[1])/2>clip[1]);
  const moved=municipal.worldWindow(base,{k:2,x:-400,y:0},970,frame),p=municipal.camera(base,{k:2,x:-400,y:0});
  assert.equal(moved[0],Math.max(0,Math.min(970,p.tx-Math.PI*p.scale)));assert.equal(moved[1],Math.max(0,Math.min(970,p.tx+Math.PI*p.scale)));
  assert.equal(municipal.worldWindow(base,identity,970,null),null);
  assert.equal(municipal.worldWindow(base,identity,970,[176,-20,-178,-12]),null);
});

test('municipal display statuses are readable while CSV keeps native codes',()=>{
  assert.equal(municipal.modelStatus('modelled'),'Modelled');assert.equal(municipal.modelStatus('no_modelled_population'),'No modelled population');assert.equal(municipal.modelStatus(null),'Unavailable');
  const csv=municipal.municipalCSV([{id:'A',name:'A',status:'no_modelled_population',values:{plas_em:{mean:null,median:null,low:null,high:null}}}],{country:'IND',metric:'plas_em',statistic:'Mean'});
  assert.match(csv,/"no_modelled_population"/);assert.doesNotMatch(csv,/No modelled population/);
});
