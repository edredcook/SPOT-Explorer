'use strict';
(function () {
  const finite=value=>typeof value==='number'&&Number.isFinite(value),RAD=Math.PI/180;
  const normalNumber=new Intl.NumberFormat('en-GB',{maximumFractionDigits:3}),smallNumber=new Intl.NumberFormat('en-GB',{maximumSignificantDigits:4}),names=new Intl.Collator('en');
  const fmt=value=>finite(value)?(value!==0&&Math.abs(value)<.01?smallNumber:normalNumber).format(value):'Unavailable';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const mercatorY=latitude=>-Math.log(Math.tan(Math.PI/4+Math.max(-85.05112878,Math.min(85.05112878,latitude))*RAD/2));
  function fitMercator(bounds,width,height,padding=18) {
    if(!Array.isArray(bounds)||bounds.length!==4||!bounds.every(finite)||bounds[2]===bounds[0]||bounds[3]<=bounds[1]||width<=2*padding||height<=2*padding)return null;
    const [west,south,rawEast,north]=bounds,east=rawEast<west?rawEast+360:rawEast,x0=west*RAD,x1=east*RAD,y0=mercatorY(north),y1=mercatorY(south);
    const scale=Math.min((width-2*padding)/(x1-x0),(height-2*padding)/Math.max(1e-12,y1-y0));
    return {scale,tx:width/2-scale*(x0+x1)/2,ty:height/2-scale*(y0+y1)/2};
  }
  function camera(base,transform) {return {scale:base.scale*transform.k,tx:base.tx*transform.k+transform.x,ty:base.ty*transform.k+transform.y};}
  function worldShifts(base,width) {const period=2*Math.PI*base.scale,centre=Math.round((width/2-base.tx)/period);return [centre-1,centre,centre+1].map(copy=>copy*period);}
  function worldWindow(base,transform,width,bounds) {
    if(!base||!Array.isArray(bounds)||bounds.join(',')!=='-180,-80,180,85')return null;
    const p=camera(base,transform),clamp=value=>Math.max(0,Math.min(width,value));
    return [clamp(p.tx-Math.PI*p.scale),clamp(p.tx+Math.PI*p.scale)];
  }
  function imageTransform(current,rendered) {const k=current.k/rendered.k;return {k,x:current.x-k*rendered.x,y:current.y-k*rendered.y};}
  function rasterViewport(width,height,projection) {
    if(!finite(width)||!finite(height)||width<=0||height<=0)return null;
    const low=Math.max(100/width,100/height),high=Math.min(2000/width,1400/height,Math.sqrt(2000000/(width*height)));
    if(low>high)return null;
    const ratio=Math.max(low,Math.min(1,high));
    return {width:Math.max(100,Math.floor(width*ratio)),height:Math.max(100,Math.floor(height*ratio)),scale:projection.scale*ratio,tx:projection.tx*ratio,ty:projection.ty*ratio,ratio};
  }
  function inverseMercator(x,y,projection) {return [((x-projection.tx)/projection.scale/RAD+180)%360+360,2*Math.atan(Math.exp(-(y-projection.ty)/projection.scale))/RAD-90].map((value,index)=>index===0?value%360-180:value);}
  function metricValue(row,metric,statistic) {const value=row?.values?.[metric]?.[statistic==='Median'?'median':'mean'];return finite(value)?value:null;}
  function modelStatus(value) {return ({modelled:'Modelled',no_modelled_population:'No modelled population'})[value]||value||'Unavailable';}
  function zoomGesture(event) {return !event.button&&(event.type!=='wheel'||event.ctrlKey===true);}
  function countryAtPoint(geometry, location, geo, countries, current) {
    const matches=(geometry?.features||[]).filter(feature=>countries.has(feature.properties?.spot_id)&&geo.geoContains(feature,location));
    // Display boundaries choose a country focus only, never a municipality.
    return matches.find(feature=>feature.properties.spot_id===current)?.properties.spot_id||matches[0]?.properties.spot_id||null;
  }
  function requestGate() {
    let active=null;
    return {begin(){active?.abort();active=new AbortController();return active;},current(ticket){return active===ticket&&!ticket.signal.aborted;},cancel(){active?.abort();active=null;}};
  }
  function validatePayload(payload,scope) {
    if(!payload||!Array.isArray(payload.rows)||payload.country?.id!==scope.country||payload.metric?.id!==scope.metric||payload.statistic!==scope.statistic||(payload.area||'')!==(scope.area||''))throw Error('The municipal response does not match the selected scope.');
    const ids=new Set();
    for(const row of payload.rows){if(typeof row.id!=='string'||!row.id||ids.has(row.id)||typeof row.name!=='string'||!row.values?.[scope.metric])throw Error('Municipal source records could not be verified.');ids.add(row.id);const values=row.values[scope.metric];for(const key of ['value','mean','median','low','high'])if(values[key]!==null&&!finite(values[key]))throw Error('Municipal source values could not be verified.');}
    return payload;
  }
  function selectStatistic(payload,statistic) {
    if(!['Mean','Median'].includes(statistic))throw Error('Select Mean or Median.');
    if(payload.statistic===statistic)return payload;
    const metric=payload.metric.id,rows=payload.rows.map(row=>({...row,values:{...row.values,[metric]:{...row.values[metric],value:metricValue(row,metric,statistic)}}}));
    const values=rows.map(row=>row.values[metric].value).filter(finite);
    return {...payload,statistic,rows,legend:{...payload.legend,minimum:values.length?Math.min(...values):null,maximum:values.length?Math.max(...values):null}};
  }
  function imageRequestAction(key,state) {
    if(key===state.queued)return 'queued';
    if(key===state.pending&&!state.pendingAborted)return 'pending';
    if(key===state.completed&&state.hasImage)return 'reuse';
    return 'fetch';
  }
  function selectionFrame(scope,view) {
    if(!scope.country||!scope.municipality||!view.base)return null;
    const transform={...view.transform},projection=camera(view.base,transform),raster=rasterViewport(view.width,view.height,projection);if(!raster)return null;
    const params=new URLSearchParams({country:scope.country,municipality:scope.municipality,...(scope.area?{area:scope.area}:{}),width:raster.width,height:raster.height,scale:raster.scale,tx:raster.tx,ty:raster.ty});
    return {identity:JSON.stringify([scope.country,scope.municipality,scope.area||'']),key:'/api/municipal/selection.png?'+params,raster,transform,projection};
  }
  function createSelectionOverlay(options) {
    const schedule=options.schedule||setTimeout,cancel=options.cancel||clearTimeout;
    let revision=0,controller=null,timer=null,identity=null,queued=null,pending=null,completed=null,asset=null,rendered=null;
    function clear(){++revision;controller?.abort();if(timer!==null)cancel(timer);timer=null;queued=null;pending=null;completed=null;identity=null;asset?.dispose();asset=null;rendered=null;options.onClear?.();}
    async function request(frame){
      if(frame.key!==options.getFrame()?.key)return;
      const current=++revision;controller=new AbortController();const ticket=controller;pending=frame.key;
      let candidate=null;
      try{
        candidate=await options.loadImage(frame,ticket.signal);
        if(current!==revision||ticket.signal.aborted||frame.key!==options.getFrame()?.key){candidate.dispose();return;}
        asset?.dispose();asset=candidate;rendered=frame;completed=frame.key;options.onRender(asset,rendered);
      }catch(error){candidate?.dispose();if(asset===candidate){asset=null;rendered=null;completed=null;}if(current===revision&&!ticket.signal.aborted&&frame.key===options.getFrame()?.key&&error.name!=='AbortError')options.onError?.();}
      finally{if(controller===ticket)pending=null;}
    }
    function queue(immediate=false){
      const frame=options.getFrame();if(!frame){clear();return;}
      if(identity!==frame.identity){clear();identity=frame.identity;}
      const action=imageRequestAction(frame.key,{queued,pending,pendingAborted:controller?.signal.aborted,completed,hasImage:Boolean(asset)});
      if(action==='queued'||action==='pending')return;
      ++revision;controller?.abort();if(timer!==null)cancel(timer);timer=null;queued=null;pending=null;
      if(action==='reuse'){options.onRender(asset,rendered);return;}
      if(immediate)return request(frame);
      queued=frame.key;timer=schedule(()=>{timer=null;queued=null;request(frame);},180);
    }
    return {queue,clear};
  }
  function csvValue(value) {return value==null?'':'"'+String(value).replace(/"/g,'""')+'"';}
  function municipalCSV(rows,context) {
    const lines=[['release','model_year','country_id','area_filter','municipality_id','municipality_name','admin_1','admin_2','admin_3','admin_4','population','model_status','metric_id','statistic','value','mean','median','5th_percentile','95th_percentile','unit']];
    for(const row of rows){const source=row.values?.[context.metric]||{},names=row.admin_names||[];lines.push([context.release,context.year??2020,context.country,context.area||'',row.id,row.name,...Array.from({length:4},(_,i)=>names[i]??null),row.population,row.status,context.metric,context.statistic,metricValue(row,context.metric,context.statistic),source.mean,source.median,source.low,source.high,context.unit]);}
    return '\ufeff'+lines.map(line=>line.map(csvValue).join(',')).join('\r\n')+'\r\n';
  }
  function create(options) {
    const $=id=>document.getElementById(id),chart=options.chart,controls=options.controls;
    const s={active:false,geometry:options.geometry,basemap:null,frameBounds:null,selection:null,selectionImage:null,selectionRendered:{k:1,x:0,y:0},selectionError:false,country:null,metric:null,statistic:'Mean',area:'',meta:null,payload:null,rows:[],revision:0,imageRevision:0,inspectRevision:0,controller:null,imageController:null,inspectController:null,base:null,transform:{k:1,x:0,y:0},rendered:{k:1,x:0,y:0},svg:null,zoom:null,image:null,imageURL:null,csvURL:null,csvDirty:true,placesKey:null,areasMeta:null,areasCountry:null,queuedImageKey:null,pendingImageKey:null,completedImageKey:null,page:0,search:'',width:0,height:0,needFit:true};
    const cache=new Map(),loadGate=requestGate(),countryIds=new Set(options.entities.map(entity=>entity.id));let imageTimer,frame=null,selectionOverlay=null;
    controls.innerHTML='<div class="control"><label for="municipal-area">First-level area</label><select id="municipal-area"><option value="">All areas</option></select></div><details class="municipal-find"><summary>Find municipality</summary><div class="control"><label for="municipal-search">Name or source ID</label><input id="municipal-search" type="search" maxlength="160" autocomplete="off" placeholder="Name or source ID"></div><div class="control"><label for="municipal-place">Municipality</label><select id="municipal-place"><option value="">Choose municipality</option></select></div></details><p class="municipal-note">Country and area fit the view. Click the map or choose a municipality for its values.</p><button id="municipal-retry" type="button" class="secondary-button" hidden>Retry municipal layer</button>';
    const status=(message,error=false)=>{$('map-status').textContent=message;$('map-status').classList.toggle('error',error);$('municipal-retry').hidden=!error;};
    const definition=()=>s.payload?.metric||{},unit=()=>definition().display_unit||definition().unit||'',release=()=>s.payload?.release||s.meta?.release||{};
    const filteredRows=()=>s.rows.filter(row=>!s.search||[row.id,row.name,...(row.admin_names||[])].some(value=>String(value??'').toLowerCase().includes(s.search)));
    const countryLabel=()=>s.payload?.country?.name||s.meta?.countries?.find(country=>country.id===s.country)?.name||s.country;
    const scopeLabel=()=>countryLabel()+(s.area?' / '+(s.meta?.countries?.find(country=>country.id===s.country)?.areas?.find(area=>area.id===s.area)?.name??'Unnamed first-level area'):'');
    const findDetails=controls.querySelector('.municipal-find'),dataDetails=$('map-table-body').closest('details');
    function stopRequests(){loadGate.cancel();s.controller?.abort();s.imageController?.abort();s.inspectController?.abort();clearTimeout(imageTimer);s.queuedImageKey=null;s.pendingImageKey=null;++s.imageRevision;++s.inspectRevision;}
    async function json(url,signal){const response=await fetch(url,{signal,headers:{Accept:'application/json'},...(url==='/api/municipal/meta'?{cache:'no-cache'}:{})});if(!response.ok){let message='Municipal results could not be loaded.';try{const body=await response.json();message=body.error?.message||message;}catch{}throw Error(message);}return response.json();}
    function selectors(extra={}){return new URLSearchParams({country:s.country,metric:s.metric,statistic:s.statistic,...(s.area?{area:s.area}:{}),...extra});}
    function dirtyDownload(){$('map-table-stat').textContent=s.statistic+', 2020';s.csvDirty=true;if(s.csvURL){URL.revokeObjectURL(s.csvURL);s.csvURL=null;}$('map-download').href='#';}
    function updateDownload(){if(!s.csvDirty&&s.csvURL)return;if(s.csvURL)URL.revokeObjectURL(s.csvURL);s.csvURL=URL.createObjectURL(new Blob([municipalCSV(s.rows,{release:release().version||release().model_version||'V1.4.1-G-0426',year:release().model_year||2020,country:s.country,area:s.area,metric:s.metric,statistic:s.statistic,unit:unit()})],{type:'text/csv;charset=utf-8'}));s.csvDirty=false;$('map-download').href=s.csvURL;$('map-download').download='SPOT_municipal_'+s.country+'_'+s.metric+'_'+s.statistic+'.csv';}
    function summary(row){const value=metricValue(row,s.metric,s.statistic);$('map-selected-name').textContent=row?row.name+' ('+row.id+')':scopeLabel();$('map-selected-value').textContent=row?fmt(value):'—';$('map-selected-unit').textContent=row?unit():'';const source=row?.values?.[s.metric]||{};$('map-selected-range').textContent=row?s.statistic+' · 2020 · 5th–95th '+fmt(source.low)+'–'+fmt(source.high)+(s.selectionError?' · Boundary highlight unavailable':''):'Choose a municipality';$('map-profile-link').textContent='Country profile: '+countryLabel();if(row)$('map-live').textContent=row.name+', '+fmt(value)+' '+unit()+', '+s.statistic+', 2020.';}
    function clearSelection(){selectionOverlay?.clear();s.selection=null;s.selectionError=false;s.svg?.selectAll('.municipal-selection-mark').remove();}
    function selectRow(row,point){if(!row)return;if(row.id!==s.selection?.id)clearSelection();s.selection=row;summary(row);$('municipal-place').value=row.id;if(point&&s.svg){s.svg.selectAll('.municipal-selection-mark').remove();const [x,y]=point;s.svg.append('circle').attr('class','municipal-selection-mark').attr('cx',x).attr('cy',y).attr('r',7);}selectionOverlay?.queue(true);options.onSelect(s.country);}
    function table(){if(!s.active||!s.payload||!dataDetails?.open)return;const rows=filteredRows(),pageCount=Math.max(1,Math.ceil(rows.length/100));s.page=Math.min(s.page,pageCount-1);const shown=rows.slice(s.page*100,(s.page+1)*100),head=$('map-table-body').closest('table')?.querySelector('thead tr');if(head)head.innerHTML=['Municipality','Native ID','First-level area',s.statistic+' ('+unit()+')','5th percentile','95th percentile','Model status'].map(label=>'<th scope="col">'+escape(label)+'</th>').join('');$('map-table-body').innerHTML=shown.map(row=>{const v=row.values?.[s.metric]||{};return '<tr><th scope="row"><button type="button" data-municipal-id="'+escape(row.id)+'">'+escape(row.name)+'</button></th><td>'+escape(row.id)+'</td><td>'+escape(row.admin_names?.[0]??'Unavailable')+'</td><td class="number">'+fmt(metricValue(row,s.metric,s.statistic))+'</td><td class="number">'+fmt(v.low)+'</td><td class="number">'+fmt(v.high)+'</td><td>'+escape(modelStatus(row.status))+'</td></tr>';}).join('');$('map-table-body').querySelectorAll('[data-municipal-id]').forEach(button=>button.addEventListener('click',()=>selectRow(s.rows.find(row=>row.id===button.dataset.municipalId))));$('map-table-caption').textContent=scopeLabel()+', municipal '+definition().name+', '+s.statistic+', 2020';$('map-table-stat').textContent=s.statistic+', 2020';const toolbar=$('map-download').closest('.map-table-toolbar'),note=toolbar?.querySelector('p');if(note)note.textContent=rows.length+' municipalities match the search; rows '+(rows.length?s.page*100+1:0)+'–'+Math.min((s.page+1)*100,rows.length)+'. CSV includes all '+s.rows.length+' records in the country / area scope.';let pages=toolbar?.querySelector('.municipal-pages');if(!pages&&toolbar){pages=document.createElement('div');pages.className='municipal-pages';toolbar.append(pages);}if(pages){pages.replaceChildren();for(const [label,offset]of[['Previous',-1],['Next',1]]){const b=document.createElement('button');b.type='button';b.textContent=label;b.disabled=offset<0?s.page===0:s.page===pageCount-1;b.addEventListener('click',()=>{s.page+=offset;table();});pages.append(b);}}}
    function places(){if(!s.active||!s.payload||!findDetails?.open)return;const key=[release().version||release().model_version,s.country,s.area,s.search].join('\u0000'),select=$('municipal-place');if(s.placesKey!==key){const fragment=document.createDocumentFragment();fragment.append(new Option('Choose municipality',''));filteredRows().slice().sort((a,b)=>names.compare(a.name,b.name)).forEach(row=>fragment.append(new Option(row.name+' ('+row.id+')',row.id)));select.replaceChildren(fragment);s.placesKey=key;}select.value=s.selection?.id||'';}
    function legend(){$('map-scale-legend').querySelector('.municipal-negative-key')?.remove();for(const id of['map-composition-legend','map-bivariate-legend'])$(id).hidden=true;$('map-scale-legend').hidden=false;$('map-unit').textContent=unit();$('map-statistic-label').textContent=s.statistic+' · 2020 · '+(s.area?'Area':'Country')+' scale';const ramp=d3.interpolateRgbBasis(['#e5f0e8','#a4d7cb','#4bafa9','#237d7d','#1B3B39']);$('map-gradient').style.background='linear-gradient(to right,'+[0,.2,.4,.6,.8,1].map(ramp).join(',')+')';$('map-legend-ticks').replaceChildren();const maximum=s.payload?.legend?.maximum;for(const position of[0,.25,.5,.75,1]){const tick=document.createElement('span');tick.style.left=position*100+'%';tick.textContent=finite(maximum)?fmt(Math.max(0,maximum)*(Math.exp(position*Math.log(101))-1)/100):'Unavailable';$('map-legend-ticks').append(tick);}const minimum=s.payload?.legend?.minimum;if(finite(minimum)&&minimum<0){const span=document.createElement('span');span.className='municipal-negative-key';span.textContent='Negative released residuals: '+fmt(minimum)+' to <0 (neutral)';$('map-scale-legend').append(span);}else $('map-scale-legend').querySelector('.municipal-negative-key')?.remove();}
    function renderBasemap(){if(!s.basemap||!s.base||!s.geometry)return;const key=[s.base.scale,s.base.tx,s.base.ty,s.width,s.height].join(':');if(s.basemap.attr('data-camera')!==key){s.basemap.attr('data-camera',key).attr('viewBox','0 0 '+s.width+' '+s.height);const projection=d3.geoMercator().scale(s.base.scale).translate([s.base.tx,s.base.ty]),path=d3.geoPath(projection)(s.geometry);s.basemap.select('g').selectAll('path').data(worldShifts(s.base,s.width)).join('path').attr('d',path).attr('transform',shift=>'translate('+shift+',0)').attr('fill','#e5ebe5').attr('stroke','#fff').attr('stroke-width',.55).attr('vector-effect','non-scaling-stroke');}transformImage();}
    function transformImage(){s.basemap?.select('g').attr('transform','translate('+s.transform.x+','+s.transform.y+') scale('+s.transform.k+')');const paint=chart.querySelector('.municipal-paint'),clip=worldWindow(s.base,s.transform,s.width,s.frameBounds);if(paint)paint.style.clipPath=clip?'polygon('+clip[0]+'px 0,'+clip[1]+'px 0,'+clip[1]+'px 100%,'+clip[0]+'px 100%)':'none';if(s.image){const t=imageTransform(s.transform,s.rendered);s.image.style.transform='translate('+t.x+'px,'+t.y+'px) scale('+t.k+')';}if(s.selectionImage){const p=camera(s.base,s.transform),t=imageTransform({k:p.scale,x:p.tx,y:p.ty},s.selectionRendered);s.selectionImage.style.transform='translate('+t.x+'px,'+t.y+'px) scale('+t.k+')';}}
    function imageSpec(){
      if(!s.active||!s.base||!s.payload?.rows?.length)return null;
      const transform={...s.transform},raster=rasterViewport(s.width,s.height,camera(s.base,transform));
      if(!raster){status('Expand the map viewport to load municipal shading.',true);chart.setAttribute('aria-busy','false');return null;}
      const params=selectors({width:raster.width,height:raster.height,scale:raster.scale,tx:raster.tx,ty:raster.ty});
      return {key:'/api/municipal/map.png?'+params,transform,raster};
    }
    function queueImage(){
      const spec=imageSpec();if(!spec)return;
      const action=imageRequestAction(spec.key,{queued:s.queuedImageKey,pending:s.pendingImageKey,pendingAborted:s.imageController?.signal.aborted,completed:s.completedImageKey,hasImage:Boolean(s.image?.isConnected)});
      if(action==='queued'||action==='pending')return;
      s.imageController?.abort();++s.imageRevision;clearTimeout(imageTimer);s.queuedImageKey=null;s.pendingImageKey=null;
      if(action==='reuse'){s.image.style.visibility='';transformImage();status(scopeLabel()+' · '+s.rows.length+' municipalities · '+s.statistic+', 2020 · click for values');chart.setAttribute('aria-busy','false');return;}
      s.queuedImageKey=spec.key;imageTimer=setTimeout(()=>{s.queuedImageKey=null;requestImage(spec);},180);
    }
    async function requestImage(spec){
      if(!s.active||spec.key!==imageSpec()?.key)return;
      const revision=++s.imageRevision,controller=new AbortController();s.imageController?.abort();s.imageController=controller;s.pendingImageKey=spec.key;
      const {transform,raster}=spec;let url=null;
      try{
        const response=await fetch(spec.key,{signal:controller.signal,headers:{Accept:'image/png'}});
        if(!response.ok)throw Error('Municipal shading could not be loaded. The source values remain in the table.');
        const blob=await response.blob();if(!blob.type.startsWith('image/png'))throw Error('The municipal image could not be verified.');
        url=URL.createObjectURL(blob);const image=new Image();image.alt='Municipal '+definition().name+', '+s.statistic+', 2020. Click the map or use the municipality selector for exact values.';
        image.className='municipal-image';image.style.width=raster.width/raster.ratio+'px';image.style.height=raster.height/raster.ratio+'px';image.src=url;await image.decode();
        if(!s.active||revision!==s.imageRevision){URL.revokeObjectURL(url);return;}
        s.image?.remove();if(s.imageURL)URL.revokeObjectURL(s.imageURL);s.imageURL=url;s.image=image;s.rendered=transform;s.completedImageKey=spec.key;
        chart.querySelector('.municipal-paint').append(image);transformImage();status(scopeLabel()+' · '+s.rows.length+' municipalities · '+s.statistic+', 2020 · click for values');chart.setAttribute('aria-busy','false');
      }catch(error){if(url)URL.revokeObjectURL(url);if(error.name!=='AbortError'&&s.active&&revision===s.imageRevision){status(error.message,true);chart.setAttribute('aria-busy','false');}}
      finally{if(s.imageController===controller)s.pendingImageKey=null;}
    }
    selectionOverlay=createSelectionOverlay({
      getFrame(){if(!s.active||!s.selection||!s.svg||!chart.contains(s.svg.node()))return null;return selectionFrame({country:s.country,municipality:s.selection.id,area:s.area},{base:s.base,transform:s.transform,width:s.width,height:s.height});},
      async loadImage(spec,signal){
        let url=null,image=null;
        try{
          const response=await fetch(spec.key,{signal,headers:{Accept:'image/png'}});if(!response.ok)throw Error('Boundary highlight unavailable.');
          const blob=await response.blob();if(!blob.type.startsWith('image/png'))throw Error('Boundary highlight unavailable.');
          url=URL.createObjectURL(blob);image=new Image();image.className='municipal-image municipal-selection-image';image.alt='';image.setAttribute('aria-hidden','true');
          image.style.width=spec.raster.width/spec.raster.ratio+'px';image.style.height=spec.raster.height/spec.raster.ratio+'px';image.src=url;await image.decode();
          let disposed=false;return {image,dispose(){if(disposed)return;disposed=true;image.remove();URL.revokeObjectURL(url);}};
        }catch(error){if(url)URL.revokeObjectURL(url);throw error;}
      },
      onRender(asset,snapshot){s.selectionImage=asset.image;s.selectionRendered={k:snapshot.projection.scale,x:snapshot.projection.tx,y:snapshot.projection.ty};s.selectionError=false;chart.querySelector('.municipal-paint').append(asset.image);s.svg?.selectAll('.municipal-selection-mark').remove();transformImage();summary(s.selection);},
      onClear(){s.selectionImage=null;},
      onError(){s.selectionError=true;summary(s.selection);},
    });
    async function inspect(event){if(event.defaultPrevented||!s.base||!s.payload||!s.active)return;const point=d3.pointer(event,s.svg.node()),clip=worldWindow(s.base,s.transform,s.width,s.frameBounds);if(clip&&(point[0]<clip[0]||point[0]>clip[1]))return;const location=inverseMercator(point[0],point[1],camera(s.base,s.transform)),country=countryAtPoint(s.geometry,location,d3,countryIds,s.country);if(country&&country!==s.country){++s.inspectRevision;s.inspectController?.abort();options.onSelect(country);return;}const revision=++s.inspectRevision,controller=new AbortController();s.inspectController?.abort();s.inspectController=controller;try{const result=await json('/api/municipal/inspect?'+selectors({lon:location[0],lat:location[1]}),controller.signal);if(!s.active||revision!==s.inspectRevision)return;if(result.row){selectRow(result.row,point);status(scopeLabel()+' · '+s.rows.length+' municipalities · '+s.statistic+', 2020');}else status('No matched municipal geometry at this location. Source records remain in the selector and table.');}catch(error){if(error.name!=='AbortError'&&s.active&&revision===s.inspectRevision)status(error.message,true);}}
    function viewBounds(){return s.frameBounds||s.payload?.bounds||s.payload?.country?.bounds||s.meta?.countries?.find(country=>country.id===s.country)?.bounds;}
    function draw(fit=false){if(!s.active||!s.payload)return;const width=chart.clientWidth,height=chart.clientHeight;if(width<40||height<40)return;const bounds=viewBounds(),base=fitMercator(bounds,width,height);if(!base||!s.rows.length||s.payload.geometry_ready===false||s.meta?.countries?.find(country=>country.id===s.country)?.geometry_ready===false){chart.replaceChildren();const p=document.createElement('p');p.className='municipal-empty';p.textContent=s.rows.length?'Municipal geometry is unavailable for this country / area. The released values remain in the table.':'No released municipal records match this country / area.';chart.append(p);status(p.textContent,Boolean(s.rows.length));chart.setAttribute('aria-busy','false');return;}const resized=width!==s.width||height!==s.height;s.width=width;s.height=height;if(fit||resized||!s.base){s.base=base;s.transform={k:1,x:0,y:0};}if(!s.svg||!chart.contains(s.svg.node())){chart.replaceChildren();const stage=document.createElement('div');stage.className='municipal-stage';chart.append(stage);const paint=document.createElement('div');paint.className='municipal-paint';stage.append(paint);s.image=null;s.basemap=d3.select(paint).append('svg').attr('class','municipal-basemap').attr('aria-hidden','true');s.basemap.append('g');s.svg=d3.select(stage).append('svg').attr('class','municipal-input').attr('role','group').attr('tabindex',0).attr('aria-label','Municipal map. Drag to pan, control plus wheel or the zoom controls to zoom. Click for values; the municipality selector and data table provide keyboard access.');const zoom=d3.zoom().scaleExtent([1,64]).clickDistance(5).filter(zoomGesture).on('zoom',event=>{s.transform={k:event.transform.k,x:event.transform.x,y:event.transform.y};$('map-zoom-range').value=event.transform.k;$('map-zoom-range').setAttribute('aria-valuetext',fmt(event.transform.k)+' times');s.svg.selectAll('.municipal-selection-mark').remove();if(frame===null)frame=requestAnimationFrame(()=>{frame=null;transformImage();});queueImage();selectionOverlay?.queue();});s.zoom=zoom;s.svg.call(zoom).on('dblclick.zoom',null).on('click.inspect',inspect).on('keydown.municipal',event=>{if(event.target!==s.svg.node())return;const t=d3.zoomTransform(s.svg.node());if(['+','=','-','Home','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();if(event.key==='Home'||event.key==='0')api.world();else if(event.key==='+'||event.key==='=')api.zoomTo(t.k*1.25);else if(event.key==='-')api.zoomTo(t.k/1.25);else s.svg.call(s.zoom.translateBy,(event.key==='ArrowLeft'?35:event.key==='ArrowRight'?-35:0)/t.k,(event.key==='ArrowUp'?35:event.key==='ArrowDown'?-35:0)/t.k);}});}renderBasemap();s.svg.attr('viewBox','0 0 '+width+' '+height).style('width','100%').style('height','100%');const resolution=rasterViewport(width,height,s.base),maximumZoom=Math.max(1,Math.min(64,100000000/(s.base.scale*(resolution?.ratio||1))));s.zoom.extent([[0,0],[width,height]]).scaleExtent([1,maximumZoom]);$('map-zoom-range').max=maximumZoom;s.transform.k=Math.min(s.transform.k,maximumZoom);s.svg.call(s.zoom.transform,d3.zoomIdentity.translate(s.transform.x,s.transform.y).scale(s.transform.k));queueImage();selectionOverlay?.queue();}
    async function load(next){const countryChanged=s.country!==next.country;const sourceChanged=countryChanged||s.metric!==next.metric||s.statistic!==next.statistic||s.needFit;if(sourceChanged){if(s.image)s.image.style.visibility='hidden';s.payload=null;$('map-table-body').replaceChildren();$('map-download').removeAttribute('href');}s.active=true;if(countryChanged){s.frameBounds=null;s.area='';s.search='';$('municipal-search').value='';clearSelection();}Object.assign(s,next);stopRequests();const revision=++s.revision,controller=loadGate.begin();s.controller=controller;chart.setAttribute('aria-busy','true');$('map-chart-title').textContent='Municipal '+(s.metric||'results');status('Loading municipal results…');if(!next.inScope){s.rows=[];clearSelection();s.payload={rows:[]};chart.replaceChildren();legend();summary(null);dirtyDownload();table();$('municipal-place').replaceChildren(new Option('Outside current filters',''));status('This country is outside the current region / income filters. Change the filters or country.');chart.setAttribute('aria-busy','false');return;}try{if(!s.meta)s.meta=await json('/api/municipal/meta',controller.signal);if(!loadGate.current(controller)||!s.active)return;const country=s.meta.countries.find(item=>item.id===s.country),areas=country?.areas||[];if(s.areasMeta!==s.meta||s.areasCountry!==s.country){$('municipal-area').replaceChildren(new Option('All areas',''));areas.forEach(area=>$('municipal-area').append(new Option((area.name??'Unnamed first-level area')+' ('+area.count+')',area.id)));s.areasMeta=s.meta;s.areasCountry=s.country;}$('municipal-area').value=s.area;const params=selectors(),key=params.toString();let payload=cache.get(key);if(!payload){const other=new URLSearchParams(params);other.set('statistic',s.statistic==='Mean'?'Median':'Mean');const cached=cache.get(other.toString());payload=cached?selectStatistic(cached,s.statistic):await json('/api/municipal/values?'+params,controller.signal);}if(!loadGate.current(controller)||!s.active)return;validatePayload(payload,{country:s.country,metric:s.metric,statistic:s.statistic,area:s.area});if(!cache.has(key)){if(cache.size>=8)cache.delete(cache.keys().next().value);cache.set(key,payload);}s.payload=payload;s.rows=payload.rows||[];s.selection=s.rows.find(row=>row.id===s.selection?.id)||null;if(!s.selection)clearSelection();s.page=0;const changed=countryChanged||s.needFit;s.needFit=false;s.svg=changed?null:s.svg;$('map-chart-title').textContent=definition().name||s.metric;legend();places();table();dirtyDownload();summary(s.selection);$('map-coverage-note').textContent=s.rows.length+' released municipal records in this country / area. Missing geometry remains in the table. Municipal outlines are rendered on the server; source vectors are not distributed.';$('map-attribution').textContent='SPOT 2020 municipal results. Geography source and reuse terms are recorded in the spatial manifest.';status(scopeLabel()+' · '+s.rows.length+' municipalities · '+s.statistic+', 2020 · click for values');draw(changed);}catch(error){if(error.name!=='AbortError'&&s.active&&loadGate.current(controller)){status(error.message,true);chart.setAttribute('aria-busy','false');}}}
    $('municipal-area').addEventListener('change',()=>{clearSelection();s.area=$('municipal-area').value;s.frameBounds=null;s.needFit=true;load({country:s.country,metric:s.metric,statistic:s.statistic,inScope:true});});
    $('municipal-search').addEventListener('input',event=>{s.search=event.target.value.trim().toLowerCase();s.page=0;places();table();});
    $('municipal-place').addEventListener('change',()=>{const row=s.rows.find(row=>row.id===$('municipal-place').value);if(row)selectRow(row);});
    $('municipal-retry').addEventListener('click',()=>{s.meta=null;cache.clear();s.placesKey=null;s.needFit=true;load({country:s.country,metric:s.metric,statistic:s.statistic,inScope:s.inScope});});
    findDetails?.addEventListener('toggle',()=>{if(findDetails.open)places();});
    dataDetails?.addEventListener('toggle',()=>{if(dataDetails.open)table();});
    $('map-download').addEventListener('click',event=>{if(!s.active)return;if(!s.payload){event.preventDefault();return;}updateDownload();});
    const api={activate:load,deactivate(){s.active=false;clearSelection();stopRequests();++s.revision;s.svg=null;s.basemap=null;s.image=null;document.querySelector('.municipal-pages')?.remove();document.querySelector('.municipal-negative-key')?.remove();},zoomTo(value){if(s.active&&s.svg&&s.zoom)s.svg.call(s.zoom.scaleTo,Math.max(1,Math.min(64,Number(value))));},fit(){s.needFit=false;s.frameBounds=null;if(s.image)s.image.style.visibility='hidden';if(s.active)draw(true);},world(){s.frameBounds=[-180,-80,180,85];if(s.image)s.image.style.visibility='hidden';if(s.active)draw(true);},setGeometry(geometry){s.geometry=geometry;s.basemap?.attr('data-camera',null);if(s.active)renderBasemap();},resize(){if(s.active)draw(false);}};
    return api;
  }
  if(typeof window!=='undefined')window.SPOTMunicipal={create};
  if(typeof module!=='undefined'&&module.exports)module.exports={selectionFrame,createSelectionOverlay,selectStatistic,imageRequestAction,fitMercator,camera,imageTransform,inverseMercator,metricValue,municipalCSV,requestGate,validatePayload,rasterViewport,zoomGesture,worldShifts,countryAtPoint,worldWindow,modelStatus};
})();
