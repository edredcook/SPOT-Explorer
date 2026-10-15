'use strict';
(function () {
  const $=id=>document.getElementById(id),NS='http://www.w3.org/2000/svg';
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const escape=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number=v=>finite(v)?new Intl.NumberFormat('en-GB',v!==0&&Math.abs(v)<.01?{maximumSignificantDigits:4}:{maximumFractionDigits:3}).format(v):'Unavailable';
  const brief=v=>{if(!finite(v))return 'Unavailable';if(v===0)return '0';if(Math.abs(v)>=1e6)return number(Math.round(v/1e4)/100)+'m';if(Math.abs(v)>=1e3)return number(Math.round(v/10)/100)+'k';return number(v);};
  const element=(tag,attrs)=>{const n=document.createElementNS(NS,tag);Object.entries(attrs||{}).forEach(([k,v])=>n.setAttribute(k,v));return n;};
  async function json(url,signal){const response=await fetch(url,{signal,headers:{Accept:'application/json'}});if(!response.ok){let msg='The map could not be loaded.';try{const body=await response.json();msg=body.error?.message||msg;}catch{}throw Error(msg);}return response.json();}
  function create(options) {
    const s={selected:null,basis:'total',statistic:'Mean',applied:{basis:'total',statistic:'Mean'},rows:[],byId:new Map(),geometry:null,crosswalk:null,boundaryError:null,svg:null,layer:null,paths:null,zoom:null,revision:0,controller:null,loading:false,focusId:null};
    const entityLookup=new Map(options.entities.map(e=>[e.id,e])),chart=$('world-map-chart'),tooltip=$('map-tooltip'),reduced=window.matchMedia('(prefers-reduced-motion: reduce)');
    let mappedIds=new Set(),focusIds=[],resizeTimer;
    const unit=()=>s.applied.basis==='per_capita'?'kg / person / year':'tonnes / year';
    const markStatus=(msg,error)=>{$('map-status').textContent=msg;$('map-status').classList.toggle('error',Boolean(error));};
    const colour=d3.interpolateRgbBasis(['#e5f0e8','#a4d7cb','#4bafa9','#237d7d','#1B3B39']);
    const maxValue=()=>Math.max(...s.rows.map(r=>finite(r.value)?Math.max(0,r.value):0),0);
    const fraction=v=>{const max=maxValue();return max>0?Math.log1p(Math.max(v,0)/max*100)/Math.log(101):0;};
    function featureRow(feature){return feature.properties.spot_id?s.byId.get(feature.properties.spot_id):null;}
    function pathColour(feature){const row=featureRow(feature);return !row||!finite(row.value)?'url(#map-no-data-pattern)':row.value===0?'#f2f1e8':colour(fraction(row.value));}
    function rowDescription(row){return row.name+' ('+row.id+'), '+s.applied.statistic+' '+number(row.value)+' '+unit()+', modelled 2020. 5th to 95th percentile: '+number(row.low)+' to '+number(row.high)+'.';}
    function updateSelected() {
      const row=s.byId.get(s.selected),entity=entityLookup.get(s.selected);
      $('map-selected-name').textContent=entity?entity.name+' ('+entity.id+')':s.selected?'Reporting group selected':'Choose a country';
      $('map-selected-value').textContent=row?number(row.value):'—';$('map-selected-unit').textContent=row?unit():'National map';
      $('map-selected-range').textContent=row?'5th–95th: '+number(row.low)+'–'+number(row.high)+' · '+s.applied.statistic+', 2020'+(s.geometry&&!mappedIds.has(row.id)?' · No matched boundary; estimate retained.':''):s.selected?'Aggregated group values are available in the profile. Select a country to highlight it on the map.':'Search or select a map feature to explore.';
      $('map-profile-link').textContent=entity?'Explore '+entity.name+' ↓':'Explore selected profile ↓';
      if(entity)$('map-search').value=entity.name+' ('+entity.id+')';
      if(s.paths){s.paths.classed('map-country-selected',f=>f.properties.spot_id===s.selected).attr('aria-pressed',f=>f.properties.spot_id?s.selected===f.properties.spot_id?'true':'false':null);s.paths.filter(f=>f.properties.spot_id===s.selected).raise();}
      if(mappedIds.has(s.selected))s.focusId=s.selected;
      updateRoving();
    }
    function updateRoving(){if(!s.paths)return;const focus=s.focusId&&mappedIds.has(s.focusId)?s.focusId:focusIds[0];const first=new Set();s.paths.attr('tabindex',f=>{const id=f.properties.spot_id;if(!id||!s.byId.has(id))return null;if(first.has(id))return -1;first.add(id);return id===focus?0:-1;});}
    function inspect(feature,event,announce) {
      const row=featureRow(feature),name=row?row.name:feature.properties.name||'Map feature';
      tooltip.innerHTML='<strong>'+escape(name)+(row?' <span>'+escape(row.id)+'</span>':'')+'</strong>'+(row?'<p class="map-tooltip-value">'+escape(number(row.value))+' <span>'+escape(unit())+'</span></p><p>'+escape(s.applied.statistic)+' · 2020</p><p class="map-tooltip-range">5th–95th: '+escape(number(row.low))+'–'+escape(number(row.high))+'</p><p class="map-tooltip-action">Select to explore this country</p>':'<p>No matched SPOT reporting estimate.</p><p class="map-tooltip-range">This does not imply zero emissions.</p>');
      tooltip.hidden=false;
      const stage=$('map-stage').getBoundingClientRect(),box=event.currentTarget?.getBoundingClientRect?.();
      const mouse=event.type&&event.type.startsWith('pointer'),px=mouse?event.clientX-stage.left:box?box.left-stage.left+box.width/2:stage.width/2,py=mouse?event.clientY-stage.top:box?box.top-stage.top+Math.min(box.height,40):50;
      const tw=tooltip.offsetWidth,th=tooltip.offsetHeight;
      tooltip.style.left=Math.max(8,Math.min(px+15,stage.width-tw-8))+'px';tooltip.style.top=Math.max(8,Math.min(py+12,stage.height-th-8))+'px';
      if(announce&&row)$('map-live').textContent=rowDescription(row);
    }
    function hideTooltip(){tooltip.hidden=true;}
    function choose(id){if(!id||s.loading)return;hideTooltip();$('map-live').textContent='Loading '+(entityLookup.get(id)?.name||id)+' profile.';options.onSelect(id);}
    function focusCountry(id){if(!id||!s.paths)return;s.focusId=id;updateRoving();const target=s.paths.filter(f=>f.properties.spot_id===id).node();target?.focus();}
    function keyboard(event,feature) {
      const id=feature.properties.spot_id;if(!id||!s.byId.has(id))return;
      if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(id);return;}
      const current=focusIds.indexOf(id);let target=null;
      if(event.key==='ArrowRight'||event.key==='ArrowDown')target=focusIds[(current+1)%focusIds.length];
      if(event.key==='ArrowLeft'||event.key==='ArrowUp')target=focusIds[(current-1+focusIds.length)%focusIds.length];
      if(event.key==='Home')target=focusIds[0];if(event.key==='End')target=focusIds[focusIds.length-1];
      if(target){event.preventDefault();focusCountry(target);}
    }
    function renderLegend() {
      const max=maxValue();$('map-gradient').style.background='linear-gradient(to right,'+[0,.2,.4,.6,.8,1].map(v=>colour(v)).join(',')+')';
      $('map-legend-ticks').replaceChildren();
      [0,.25,.5,.75,1].forEach(p=>{const tick=document.createElement('span');tick.textContent=brief(max*(Math.exp(p*Math.log(101))-1)/100);tick.style.left=(p*100)+'%';$('map-legend-ticks').append(tick);});
      $('map-unit').textContent=unit();$('map-statistic-label').textContent=s.applied.statistic+' · 2020 · compressed scale';
    }
    function renderTable() {
      $('map-central-heading').textContent=s.applied.statistic;$('map-table-stat').textContent=s.applied.statistic+', 2020';$('map-table-caption').textContent='National plastic emissions, '+unit()+', '+s.applied.statistic+', modelled 2020. Every source reporting entity is included.';
      const rows=s.rows.slice().sort((a,b)=>a.name.localeCompare(b.name));
      $('map-table-body').innerHTML=rows.map(row=>'<tr><th scope="row"><button type="button" data-map-entity="'+escape(row.id)+'" class="map-table-country">'+escape(row.name)+'</button></th><td>'+escape(row.id)+'</td><td class="number">'+escape(number(row.value))+'</td><td class="number">'+escape(number(row.low))+'</td><td class="number">'+escape(number(row.high))+'</td><td>'+(s.geometry?mappedIds.has(row.id)?'Mapped':'Not mapped':'Boundary unavailable')+'</td></tr>').join('');
      $('map-table-body').querySelectorAll('[data-map-entity]').forEach(button=>button.addEventListener('click',()=>choose(button.dataset.mapEntity)));
      const params=new URLSearchParams({entities:s.rows.map(r=>r.id).join(','),family:'outputs',metric:s.applied.basis==='per_capita'?'plas_em_per_cap':'plas_em',statistic:'all'});$('map-download').href='/api/download?'+params;
    }
    function renderCoverage() {
      if(!s.geometry)return;const unmatched=s.rows.filter(row=>!mappedIds.has(row.id));
      $('map-coverage-note').textContent=unmatched.length?mappedIds.size+' of '+s.rows.length+' SPOT reporting entities have a matched boundary. All estimates, including the '+unmatched.length+' unmatched places, remain available in search and the complete data table. An unmatched place is not a zero.':'All '+s.rows.length+' SPOT reporting entities have a matched boundary and remain available in search and the complete data table.';
      const source=s.crosswalk?.source||{};
      const sourceLink=document.createElement('a');sourceLink.href='https://www.naturalearthdata.com/about/terms-of-use/';sourceLink.textContent='Natural Earth '+(source.version||'')+' (year not stated; public domain)';
      const manifestLink=document.createElement('a');manifestLink.href='/static/assets/map_manifest.json';manifestLink.textContent='Boundary sources and country matches (2026)';
      $('map-attribution').replaceChildren(document.createTextNode('Made with '),sourceLink,document.createTextNode('. '),manifestLink,document.createTextNode('. Outlines do not imply agreement on territorial status. SPOT release 2026; modelled results 2020.'));
      const terms=document.createElement('a');terms.href='https://www.naturalearthdata.com/about/terms-of-use/';terms.target='_blank';terms.rel='noopener';terms.textContent=' Natural Earth terms (year not stated; accessed 2026).';$('map-attribution').append(terms);
    }
    function applyZoom(transform){if(s.layer)s.layer.attr('transform',transform);$('map-zoom-range').value=transform.k;$('map-zoom-range').setAttribute('aria-valuetext',number(transform.k)+' times');hideTooltip();}
    function zoomTo(value){if(!s.svg||!s.zoom)return;const amount=Math.max(1,Math.min(6,Number(value)));s.svg.call(s.zoom.scaleTo,amount);}
    function draw() {
      if(!s.geometry||!s.rows.length||!window.d3)return;
      const width=1100,height=540,projection=d3.geoEqualEarth().fitExtent([[14,15],[width-14,height-15]],{type:'Sphere'}),path=d3.geoPath(projection);
      mappedIds=new Set(s.geometry.features.map(f=>f.properties.spot_id).filter(id=>id&&s.byId.has(id)));focusIds=Array.from(mappedIds).sort((a,b)=>(entityLookup.get(a)?.name||a).localeCompare(entityLookup.get(b)?.name||b));
      const previous=s.svg?d3.zoomTransform(s.svg.node()):d3.zoomIdentity;
      chart.replaceChildren();const svg=d3.select(chart).append('svg').attr('viewBox','0 0 '+width+' '+height).attr('role','group').attr('aria-labelledby','world-map-svg-title world-map-svg-desc').attr('tabindex','0').attr('class','world-map-svg');
      svg.append('title').attr('id','world-map-svg-title').text('National plastic emissions, '+s.applied.statistic+', 2020');
      svg.append('desc').attr('id','world-map-svg-desc').text('Equal Earth map. Countries are coloured by '+unit()+'. Use country search or the complete table for every reporting entity. Arrow keys move between focused countries; Enter selects. With the map background focused, plus and minus zoom, arrows pan, and Home resets.');
      const defs=svg.append('defs'),pattern=defs.append('pattern').attr('id','map-no-data-pattern').attr('width',5).attr('height',5).attr('patternUnits','userSpaceOnUse');pattern.append('rect').attr('width',5).attr('height',5).attr('fill','#e9ece5');pattern.append('path').attr('d','M-1,1 l2,-2 M0,5 l5,-5 M4,6 l2,-2').attr('stroke','#c6cec3').attr('stroke-width',.65);
      svg.append('path').datum({type:'Sphere'}).attr('d',path).attr('fill','#f7faf6').attr('stroke','#d4ddd5').attr('stroke-width',.8);
      const layer=svg.append('g');layer.append('path').datum(d3.geoGraticule10()).attr('d',path).attr('fill','none').attr('stroke','#dfe8df').attr('stroke-width',.6).attr('pointer-events','none');
      const paths=layer.append('g').selectAll('path').data(s.geometry.features).join('path').attr('d',path).attr('class','map-country').attr('data-spot-id',f=>f.properties.spot_id||'').attr('fill',pathColour).attr('stroke','#fafcf8').attr('stroke-width',.55).attr('vector-effect','non-scaling-stroke').attr('role',f=>f.properties.spot_id&&s.byId.has(f.properties.spot_id)?'button':null).attr('aria-label',f=>{const row=featureRow(f);return row?rowDescription(row):f.properties.name+'; no matched SPOT estimate';}).on('pointerenter',function(event,feature){if(!s.loading){d3.select(this).classed('map-country-hover',true);inspect(feature,event,false);}}).on('pointermove',function(event,feature){if(!s.loading)inspect(feature,event,false);}).on('pointerleave',function(){d3.select(this).classed('map-country-hover',false);hideTooltip();}).on('focus',function(event,feature){d3.select(this).classed('map-country-hover',true);inspect(feature,event,true);}).on('blur',function(){d3.select(this).classed('map-country-hover',false);hideTooltip();}).on('click',(event,feature)=>choose(feature.properties.spot_id)).on('keydown',keyboard);
      s.svg=svg;s.layer=layer;s.paths=paths;
      const zoom=d3.zoom().scaleExtent([1,6]).extent([[0,0],[width,height]]).translateExtent([[-width*.3,-height*.3],[width*1.3,height*1.3]]).filter(event=>!event.button&&(event.type!=='wheel'||event.ctrlKey)).on('zoom',event=>applyZoom(event.transform));s.zoom=zoom;svg.call(zoom).on('dblclick.zoom',null);svg.call(zoom.transform,previous);
      svg.on('keydown.map',event=>{if(event.target!==svg.node())return;const t=d3.zoomTransform(svg.node());if(['+','=','-','Home','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key)){event.preventDefault();if(event.key==='+'||event.key==='=')zoomTo(t.k*1.25);else if(event.key==='-')zoomTo(t.k/1.25);else if(event.key==='Home'||event.key==='0')svg.call(zoom.transform,d3.zoomIdentity);else{const dx=event.key==='ArrowLeft'?35:event.key==='ArrowRight'?-35:0,dy=event.key==='ArrowUp'?35:event.key==='ArrowDown'?-35:0;svg.call(zoom.translateBy,dx/t.k,dy/t.k);}}});
      chart.setAttribute('aria-busy','false');renderLegend();renderCoverage();renderTable();updateSelected();
    }
    async function loadData() {
      s.controller?.abort();const controller=new AbortController();s.controller=controller;const revision=++s.revision,basis=s.basis,statistic=s.statistic;s.loading=true;chart.setAttribute('aria-busy','true');hideTooltip();markStatus('Loading '+(basis==='per_capita'?'per-person':'total')+' emissions…');
      try{const result=await json('/api/map?'+new URLSearchParams({basis,statistic}),controller.signal);if(revision!==s.revision)return;s.rows=result.rows||[];s.byId=new Map(s.rows.map(row=>[row.id,row]));s.applied={basis,statistic};s.loading=false;markStatus(s.boundaryError||'',Boolean(s.boundaryError));renderLegend();renderTable();updateSelected();draw();if(!s.geometry)chart.setAttribute('aria-busy','false');}
      catch(error){if(revision!==s.revision||error.name==='AbortError')return;s.loading=false;chart.setAttribute('aria-busy','false');markStatus(error.message,true);}
    }
    document.querySelectorAll('input[name="map-basis"]').forEach(input=>input.addEventListener('change',()=>{if(input.checked){s.basis=input.value;loadData();}}));
    $('map-statistic').addEventListener('change',()=>{s.statistic=$('map-statistic').value;loadData();});
    $('map-zoom-range').addEventListener('input',event=>zoomTo(event.target.value));$('map-zoom-in').addEventListener('click',()=>zoomTo(Number($('map-zoom-range').value)*1.25));$('map-zoom-out').addEventListener('click',()=>zoomTo(Number($('map-zoom-range').value)/1.25));$('map-reset').addEventListener('click',()=>{if(s.svg)s.svg.call(s.zoom.transform,d3.zoomIdentity);});
    $('map-search-form').addEventListener('submit',event=>{event.preventDefault();const value=$('map-search').value.trim().toLowerCase(),entity=options.entities.find(e=>e.id.toLowerCase()===value||e.name.toLowerCase()===value||(e.name+' ('+e.id+')').toLowerCase()===value);if(!entity){markStatus('Choose a recognised country or territory. Reporting groups remain available in the profile selector.',true);return;}markStatus('');choose(entity.id);});
    $('map-profile-link').addEventListener('click',()=>{$('country').scrollIntoView({behavior:reduced.matches?'auto':'smooth',block:'start'});$('country-search').focus({preventScroll:true});});
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(hideTooltip,120);});
    Promise.all([json('/static/assets/world_boundaries.geojson'),json('/static/assets/map_crosswalk.json')]).then(([geometry,crosswalk])=>{s.geometry=geometry;s.crosswalk=crosswalk;s.boundaryError=null;draw();}).catch(()=>{s.boundaryError='The boundary layer could not be loaded. Country estimates remain available in search and the complete table.';markStatus(s.boundaryError,true);chart.setAttribute('aria-busy','false');renderTable();});
    loadData();
    return {select(id){s.selected=id;updateSelected();},refresh:loadData};
  }
  window.SPOTMap={create};
})();
