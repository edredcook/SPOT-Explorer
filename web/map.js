'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const escape = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const number = value => finite(value) ? new Intl.NumberFormat('en-GB', value !== 0 && Math.abs(value) < .01 ? {maximumSignificantDigits:4} : {maximumFractionDigits:3}).format(value) : 'Unavailable';
  const brief = value => !finite(value) ? 'Unavailable' : Math.abs(value) >= 1e6 ? number(value / 1e6) + 'm' : Math.abs(value) >= 1e3 ? number(value / 1e3) + 'k' : number(value);
  const PAIRS = {plas_em:'plas_em_per_cap', plas_debris_em:'plas_debris_em_per_cap', plas_burn_em:'plas_burn_em_per_cap', wg:'wg_per_cap', pwg:'pwg_per_cap'};
  const MODES = {choropleth:'Shaded countries', symbols:'Proportional circles', composition:'Emissions mix', bivariate:'Collection and emissions'};
  const BIVARIATE = [['#e8e8e8','#ace4e4','#5ac8c8'],['#dfb0d6','#a5add3','#5698b9'],['#be64ac','#8c62aa','#3b4994']];
  const DEBRIS = '#227c7b', BURNING = '#da7648';

  // Squaring this radius gives a constant times the original value. No minimum
  // area is imposed: known zeros and missing values get separate outline marks.
  function symbolRadius(value, maximum, size, plotWidth) {
    const maximumRadius=finite(plotWidth)&&plotWidth>0?Math.min(34,plotWidth*.035):34;
    return finite(value) && value > 0 && finite(maximum) && maximum > 0 ? maximumRadius * size * Math.sqrt(value / maximum) : 0;
  }
  function markerScale(zoom) { return finite(zoom) && zoom > 0 ? 1 / zoom : 1; }
  function thirds(values) {
    const sorted = values.filter(finite).sort((a, b) => a - b);
    const quantile = p => {
      if (!sorted.length) return null;
      const position = (sorted.length - 1) * p, lower = Math.floor(position), weight = position - lower;
      return sorted[lower] + (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * weight;
    };
    return [quantile(1 / 3), quantile(2 / 3)];
  }
  function classIndex(value, bounds) {
    return !finite(value) || !bounds.every(finite) ? null : value <= bounds[0] ? 0 : value <= bounds[1] ? 1 : 2;
  }
  function metricForBasis(metric, basis) { return basis === 'per_capita' && PAIRS[metric] ? PAIRS[metric] : metric; }
  function atlasRows(payload, view) {
    return payload.rows.map(entity => {
      const values = entity.values[view.metric] || {};
      return {...entity, source:entity.values, value:view.mode === 'composition' ? values.mean : values.value,
        low:values.low, median:values.median, high:values.high};
    });
  }

  // One display location per native SPOT entity, even where a reporting entity
  // has several map units or distant islands. Use its largest polygon; this is
  // a display anchor, not a population centre or a new spatial allocation.
  function entityAnchors(geometry, geo) {
    const largest = new Map();
    for (const feature of geometry.features || []) {
      const id = feature.properties?.spot_id;
      if (!id || !feature.geometry) continue;
      const parts = feature.geometry.type === 'MultiPolygon' ? feature.geometry.coordinates : feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : [];
      for (const coordinates of parts) {
        const polygon = {type:'Polygon', coordinates}, area = geo.geoArea(polygon);
        if (!largest.has(id) || area > largest.get(id).area) largest.set(id, {id, area, polygon});
      }
    }
    return Array.from(largest.values(), item => ({id:item.id, location:geo.geoCentroid(item.polygon)})).filter(item => item.location.every(finite));
  }

  async function json(url) {
    const response = await fetch(url, {headers:{Accept:'application/json'}});
    if (!response.ok) {
      let message = 'The map could not be loaded.';
      try { message = (await response.json()).error?.message || message; } catch {}
      throw Error(message);
    }
    return response.json();
  }

  function create(options) {
    const chart = $('world-map-chart'), tooltip = $('map-tooltip');
    const entities = new Map(options.entities.map(entity => [entity.id, entity]));
    const s = {selected:null, mode:'choropleth', metric:'plas_em', basis:'total', statistic:'Mean', size:1,
      applied:{mode:'choropleth', metric:'plas_em', basis:'total', statistic:'Mean'}, rows:[], byId:new Map(), definitions:new Map(),
      geometry:null, crosswalk:null, anchors:[], boundaryError:null, svg:null, layer:null, paths:null, symbols:null,
      zoom:null, viewport:null, revision:0, loading:false, focusId:null, xBounds:[null,null], yBounds:[null,null], release:null};
    const cache = new Map(), colour = d3.interpolateRgbBasis(['#e5f0e8','#a4d7cb','#4bafa9','#237d7d','#1B3B39']);
    let mappedIds = new Set(), focusIds = [], resizeTimer, downloadURL = null;
    const mode = () => s.applied.mode;
    const statistic = () => s.applied.statistic;
    const metric = () => s.definitions.get(s.applied.metric);
    const unit = () => metric()?.display_unit || metric()?.unit || '';
    const title = () => mode() === 'composition' ? 'Plastic debris and open burning' : mode() === 'bivariate' ? 'Collection coverage and per-person emissions' : metric()?.name || 'Plastic emissions';
    const year = () => s.release?.model_year || 2020;
    const markStatus = (message, error) => { $('map-status').textContent = message; $('map-status').classList.toggle('error', Boolean(error)); };
    const maxValue = () => Math.max(...s.rows.map(row => finite(row.value) ? Math.max(0, row.value) : 0), 0);
    const fraction = value => { const max = maxValue(); return max > 0 ? Math.log1p(Math.max(value, 0) / max * 100) / Math.log(101) : 0; };
    const raw = (row, id) => row.source[id] || {};
    const central = (row, id) => raw(row, id)[statistic() === 'Mean' ? 'mean' : 'value'];
    const mixKeys = () => ({debris:metricForBasis('plas_debris_em',s.applied.basis),burn:metricForBasis('plas_burn_em',s.applied.basis)});
    const featureId = feature => feature.properties?.spot_id || null;
    const featureRow = feature => s.byId.get(featureId(feature));
    function bivariateValues(row) { return [central(row, 'col_cov_pct_gen_exc_lit'), central(row, 'plas_em_per_cap')]; }
    function bivariateClasses(row) { const [x, y] = bivariateValues(row); return [classIndex(x, s.xBounds), classIndex(y, s.yBounds)]; }
    function pathColour(feature) {
      const row = featureRow(feature);
      if (!row) return 'url(#map-no-data-pattern)';
      if (mode() === 'symbols' || mode() === 'composition') return '#e5ebe5';
      if (mode() === 'bivariate') { const [x, y] = bivariateClasses(row); return x == null || y == null ? 'url(#map-no-data-pattern)' : BIVARIATE[y][x]; }
      return !finite(row.value) ? 'url(#map-no-data-pattern)' : row.value === 0 ? '#f2f1e8' : colour(fraction(row.value));
    }
    function rowDescription(row) {
      const identity = row.name + ' (' + row.id + '), ';
      if (mode() === 'composition') {const keys=mixKeys();return identity + 'mean plastic debris ' + number(raw(row,keys.debris).mean) + ', openly burned plastic ' + number(raw(row,keys.burn).mean) + ', total ' + number(row.value) + ' '+unit()+', ' + year() + '.';}
      if (mode() === 'bivariate') { const [x,y] = bivariateValues(row); return identity + statistic() + ' collection coverage ' + number(x) + ' percent; plastic emissions ' + number(y) + ' kg/person/year, ' + year() + '.'; }
      return identity + statistic() + ' ' + number(row.value) + ' ' + unit() + ', ' + year() + '. 5th to 95th percentile: ' + number(row.low) + ' to ' + number(row.high) + '.';
    }
    function hideTooltip() { tooltip.hidden = true; }
    function inspect(row, feature, event, announce) {
      const name = row?.name || feature?.properties?.name || 'Map feature';
      let body;
      if (!row) body = '<p>No matched SPOT estimate.</p>';
      else if (mode() === 'composition') {const keys=mixKeys();body = '<p>Plastic debris: ' + escape(number(raw(row,keys.debris).mean)) +' '+escape(unit())+'</p><p>Openly burned plastic: ' + escape(number(raw(row,keys.burn).mean)) +' '+escape(unit())+'</p><p class="map-tooltip-value">Total: ' + escape(number(row.value)) +' '+escape(unit())+'</p><p>Mean · ' + year() + '</p>';}
      else if (mode() === 'bivariate') { const [x,y] = bivariateValues(row); body = '<p>Collection coverage: ' + escape(number(x)) + '%</p><p>Plastic emissions: ' + escape(number(y)) + ' kg/person/year</p><p>' + escape(statistic()) + ' · ' + year() + '</p>'; }
      else body = '<p class="map-tooltip-value">' + escape(number(row.value)) + ' <span>' + escape(unit()) + '</span></p><p>' + escape(statistic()) + ' · ' + year() + '</p><p>5th–95th: ' + escape(number(row.low)) + '–' + escape(number(row.high)) + '</p>';
      tooltip.innerHTML = '<strong>' + escape(name) + (row ? ' <span>' + escape(row.id) + '</span>' : '') + '</strong>' + body;
      tooltip.hidden = false;
      const stage = $('map-stage').getBoundingClientRect(), box = event.currentTarget?.getBoundingClientRect?.();
      const pointer = event.type?.startsWith('pointer'), px = pointer ? event.clientX-stage.left : box ? box.left-stage.left+box.width/2 : stage.width/2, py = pointer ? event.clientY-stage.top : box ? box.top-stage.top+Math.min(box.height,40) : 50;
      tooltip.style.left = Math.max(8,Math.min(px+15,stage.width-tooltip.offsetWidth-8)) + 'px';
      tooltip.style.top = Math.max(8,Math.min(py+12,stage.height-tooltip.offsetHeight-8)) + 'px';
      if (announce && row) $('map-live').textContent = rowDescription(row);
    }
    function choose(id) { if (!id || s.loading) return; hideTooltip(); options.onSelect(id); }
    function interactive() { return mode() === 'symbols' || mode() === 'composition' ? s.symbols : s.paths; }
    function datumId(datum) { return datum.properties ? featureId(datum) : datum.id; }
    function updateRoving() {
      const marks = interactive(); if (!marks) return;
      const focus = s.focusId && mappedIds.has(s.focusId) ? s.focusId : focusIds[0], seen = new Set();
      marks.attr('tabindex', datum => { const id = datumId(datum); if (!id || !s.byId.has(id)) return null; if (seen.has(id)) return -1; seen.add(id); return id === focus ? 0 : -1; });
    }
    function updateSelected() {
      const row = s.byId.get(s.selected), entity = entities.get(s.selected);
      $('map-selected-name').textContent = entity ? entity.name + ' (' + entity.id + ')' : s.selected ? 'Reporting group selected' : 'Choose a country';
      if (row && mode() === 'bivariate') { const [x,y] = bivariateValues(row); $('map-selected-value').textContent = 'Collection: ' + number(x) + '% · Emissions: ' + number(y); $('map-selected-unit').textContent = 'kg/person/year'; }
      else { $('map-selected-value').textContent = row ? number(row.value) : '—'; $('map-selected-unit').textContent = row ? unit() : ''; }
      $('map-selected-range').textContent = row ? mode() === 'composition' ? 'Debris ' + number(raw(row,mixKeys().debris).mean) + ' · openly burned ' + number(raw(row,mixKeys().burn).mean) +' '+unit() : statistic() + ', ' + year() : '';
      $('map-profile-link').textContent = entity ? 'Country profile: ' + entity.name : 'Country profile';
      if (entity) $('map-search').value = entity.name + ' (' + entity.id + ')';
      for (const marks of [s.paths,s.symbols]) if (marks) { marks.classed('map-country-selected', datum => datumId(datum) === s.selected).attr('aria-pressed', datum => datumId(datum) && s.byId.has(datumId(datum)) ? datumId(datum) === s.selected ? 'true':'false' : null); marks.filter(datum => datumId(datum) === s.selected).raise(); }
      if(s.symbols)s.symbols.select('.map-symbol-outline').attr('stroke',datum=>datum.id===s.selected?BURNING:'#1B3B39').attr('stroke-width',datum=>datum.id===s.selected?2.5:.6);
      if (mappedIds.has(s.selected)) s.focusId = s.selected;
      updateRoving();
    }
    function keyboard(event, datum) {
      const id = datumId(datum); if (!id || !s.byId.has(id)) return;
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(id); return; }
      const position = focusIds.indexOf(id); let target;
      if (event.key === 'ArrowRight' || event.key === 'ArrowDown') target = focusIds[(position+1)%focusIds.length];
      if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') target = focusIds[(position-1+focusIds.length)%focusIds.length];
      if (event.key === 'Home') target = focusIds[0]; if (event.key === 'End') target = focusIds[focusIds.length-1];
      if (target) { event.preventDefault(); s.focusId=target; updateRoving(); interactive().filter(item => datumId(item) === target).node()?.focus(); }
    }
    function bindInspection(marks, rowFor, featureFor) {
      return marks.on('pointerenter', function(event,datum) { if (!s.loading) { d3.select(this).classed('map-country-hover',true); inspect(rowFor(datum),featureFor(datum),event,false); } })
        .on('pointermove', function(event,datum) { if (!s.loading) inspect(rowFor(datum),featureFor(datum),event,false); })
        .on('pointerleave', function() { d3.select(this).classed('map-country-hover',false); hideTooltip(); })
        .on('focus', function(event,datum) { d3.select(this).classed('map-country-hover',true);inspect(rowFor(datum),featureFor(datum),event,true); })
        .on('blur', function(){d3.select(this).classed('map-country-hover',false);hideTooltip();}).on('click', (event,datum) => choose(datumId(datum))).on('keydown', keyboard);
    }
    function classLabels(bounds, suffix) {
      return ['≤ ' + number(bounds[0]) + suffix, '> ' + number(bounds[0]) + '–' + number(bounds[1]) + suffix, '> ' + number(bounds[1]) + suffix];
    }
    function renderLegend() {
      const scale = $('map-scale-legend'), composition = $('map-composition-legend'), bivariate = $('map-bivariate-legend');
      if (scale) scale.hidden = mode() !== 'choropleth';
      if (composition) composition.hidden = mode() !== 'composition' && mode() !== 'symbols';
      if (bivariate) bivariate.hidden = mode() !== 'bivariate';
      $('map-unit').textContent = mode() === 'bivariate' ? 'Collection coverage × plastic emissions' : unit();
      $('map-statistic-label').textContent = statistic() + ' · ' + year();
      if (mode() === 'bivariate' && bivariate) {
        const xLabels=classLabels(s.xBounds,'%'), yLabels=classLabels(s.yBounds,' kg/person/year');
        bivariate.replaceChildren();
        const heading=document.createElement('div'); heading.textContent='Collection coverage → · per-person emissions ↑'; bivariate.append(heading);
        const grid=document.createElement('div'); grid.style.cssText='display:grid;grid-template-columns:minmax(110px,1.3fr) repeat(3,minmax(60px,1fr));gap:3px;font-size:10px;max-width:560px;align-items:stretch';
        grid.append(document.createElement('span'));
        xLabels.forEach(label=>{const cell=document.createElement('span');cell.textContent=label;cell.style.textAlign='center';grid.append(cell);});
        [2,1,0].forEach(y=>{const label=document.createElement('span');label.textContent=yLabels[y];grid.append(label);[0,1,2].forEach(x=>{const cell=document.createElement('span');cell.style.cssText='height:22px;background:'+BIVARIATE[y][x];cell.setAttribute('role','img');cell.setAttribute('aria-label','Collection '+xLabels[x]+'; emissions '+yLabels[y]);cell.title='Collection '+xLabels[x]+'; emissions '+yLabels[y];grid.append(cell);});});
        bivariate.append(grid);return;
      }
      if (mode() === 'symbols' || mode() === 'composition') {
        if (composition) {
          composition.innerHTML = mode() === 'composition' ? '<span><i style="display:inline-block;width:12px;height:12px;background:'+DEBRIS+';margin-right:5px"></i>Plastic debris</span> <span><i style="display:inline-block;width:12px;height:12px;background:'+BURNING+';margin-right:5px"></i>Openly burned plastic</span> <span>Mean · area: '+escape(unit())+'</span>' : '<span>Area: '+escape(unit())+'</span>';
          const maximum=maxValue(),available=Array.from(new Set(s.rows.map(row=>row.value).filter(value=>finite(value)&&value>0)));
          const references=[];
          for(const target of [maximum,maximum/4,maximum/16]) {
            const remaining=available.filter(value=>!references.includes(value));
            if(remaining.length)references.push(remaining.reduce((best,value)=>Math.abs(value-target)<Math.abs(best-target)?value:best));
          }
          references.sort((a,b)=>b-a);
          const plotWidth=s.viewport?.width||chart.clientWidth||1100;
          const radius=symbolRadius(maximum,maximum,s.size,plotWidth),height=Math.max(54,2*radius+16),width=2*radius+145,baseline=height-8,cx=radius+4;
          const key=d3.create('svg').attr('id','map-size-legend').attr('role','img').attr('aria-label','Circle areas in '+unit()+': '+references.map(number).join(', ')).attr('width',width).attr('height',height).attr('viewBox','0 0 '+width+' '+height).style('flex-shrink','0');
          references.forEach((value,index)=>{
            const r=symbolRadius(value,maximum,s.size,plotWidth),top=baseline-2*r,labelY=12+index*(height-24)/Math.max(1,references.length-1);
            key.append('circle').attr('cx',cx).attr('cy',baseline-r).attr('r',r).attr('data-reference-value',value).attr('fill','none').attr('stroke','#526c69').attr('stroke-width',.8);
            key.append('path').attr('d','M'+cx+','+top+'L'+(2*radius+12)+','+labelY+'H'+(2*radius+22)).attr('fill','none').attr('stroke','#84968c').attr('stroke-width',.6);
            key.append('text').attr('x',2*radius+27).attr('y',labelY+3).attr('font-size',10).attr('fill','#1B3B39').text(brief(value));
          });
          const samples=document.createElement('div');samples.id='map-size-legend-row';samples.append(key.node());composition.append(samples);
        }
        return;
      }
      const max=maxValue();$('map-gradient').style.background='linear-gradient(to right,'+[0,.2,.4,.6,.8,1].map(value=>colour(value)).join(',')+')';
      $('map-legend-ticks').replaceChildren();
      [0,.25,.5,.75,1].forEach(position=>{const tick=document.createElement('span');tick.textContent=brief(max*(Math.exp(position*Math.log(101))-1)/100);tick.style.left=position*100+'%';$('map-legend-ticks').append(tick);});
    }
    function selectedMetrics() { return mode() === 'composition' ? [s.applied.metric,mixKeys().debris,mixKeys().burn] : mode() === 'bivariate' ? ['col_cov_pct_gen_exc_lit','plas_em_per_cap'] : [s.applied.metric]; }
    function makeDownload() {
      if (downloadURL) URL.revokeObjectURL(downloadURL);
      const lines=[['release','model_year','entity_id','entity_name','family','metric_id','metric_name','statistic','value','unit']];
      for(const row of s.rows) for(const id of selectedMetrics()) {
        const values=raw(row,id), definition=s.definitions.get(id)||{};
        const stats={Mean:values.mean,Median:values.median,'5th percentile':values.low,'95th percentile':values.high};
        for(const [stat,value] of Object.entries(stats)) lines.push([s.release?.version||s.release?.id||'',year(),row.id,row.name,'outputs',id,definition.name||id,stat,value==null?'':value,definition.display_unit||definition.unit||'']);
      }
      const csv=lines.map(row=>row.map(value=>'"'+String(value).replace(/"/g,'""')+'"').join(',')).join('\r\n')+'\r\n';
      downloadURL=URL.createObjectURL(new Blob(['\ufeff',csv],{type:'text/csv;charset=utf-8'}));
      $('map-download').href=downloadURL;$('map-download').download='SPOT_'+mode()+'_'+year()+'.csv';
    }
    function renderTable() {
      const fields=mode()==='composition' ? ['Plastic debris ('+unit()+')','Openly burned ('+unit()+')','Total ('+unit()+')'] : mode()==='bivariate' ? ['Collection coverage (%)','Plastic emissions (kg/person/year)','Collection class','Emissions class'] : [statistic()+' ('+unit()+')','5th percentile','95th percentile'];
      const head=$('map-table-body').closest('table')?.querySelector('thead tr');
      if(head)head.innerHTML=['Country / territory','Code',...fields,'Boundary match'].map(label=>'<th scope="col">'+escape(label)+'</th>').join('');
      $('map-table-stat').textContent=statistic()+', '+year();$('map-table-caption').textContent=title()+', '+statistic()+', '+year();
      $('map-table-body').innerHTML=s.rows.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(row=>{
        let values;
        if(mode()==='composition') values=[raw(row,mixKeys().debris).mean,raw(row,mixKeys().burn).mean,row.value].map(number);
        else if(mode()==='bivariate'){const [x,y]=bivariateValues(row),[xc,yc]=bivariateClasses(row);values=[number(x),number(y),xc==null?'Unavailable':classLabels(s.xBounds,'%')[xc],yc==null?'Unavailable':classLabels(s.yBounds,'')[yc]];}
        else values=[row.value,row.low,row.high].map(number);
        return '<tr><th scope="row"><button type="button" data-map-entity="'+escape(row.id)+'" class="map-table-country">'+escape(row.name)+'</button></th><td>'+escape(row.id)+'</td>'+values.map(value=>'<td class="number">'+escape(value)+'</td>').join('')+'<td>'+(s.geometry?mappedIds.has(row.id)?'Mapped':'Not mapped':'Boundary unavailable')+'</td></tr>';
      }).join('');
      $('map-table-body').querySelectorAll('[data-map-entity]').forEach(button=>button.addEventListener('click',()=>choose(button.dataset.mapEntity)));
      if(s.rows.length)makeDownload();
    }
    function renderCoverage() {
      if(!s.geometry)return;
      const missing=s.rows.filter(row=>!mappedIds.has(row.id));
      $('map-coverage-note').textContent=mappedIds.size+' of '+s.rows.length+' source entities mapped; all remain in the table.'+(mode()==='symbols'||mode()==='composition'?' One display location per entity, on its largest mapped polygon.':'')+(missing.length?' '+missing.length+' have no matched boundary.':'');
      const source=s.crosswalk?.source||{};
      $('map-attribution').textContent=(source.attribution||'Natural Earth display boundaries, public domain.')+' SPOT '+year()+'.';
    }
    function symbolTransform(location,zoom) { return 'translate('+s.projection(location).join(',')+') scale('+markerScale(zoom)+')'; }
    function applyZoom(transform) { s.layer?.attr('transform',transform);if(s.symbols)s.symbols.attr('transform',datum=>symbolTransform(datum.location,transform.k));$('map-zoom-range').value=transform.k;$('map-zoom-range').setAttribute('aria-valuetext',number(transform.k)+' times');hideTooltip(); }
    function zoomTo(value) { if(s.svg&&s.zoom)s.svg.call(s.zoom.scaleTo,Math.max(1,Math.min(6,Number(value)))); }
    function drawSymbols(layer,projection) {
      const anchors=s.anchors.filter(anchor=>s.byId.has(anchor.id)).map(anchor=>({...anchor,row:s.byId.get(anchor.id)})).sort((a,b)=>(b.row.value||0)-(a.row.value||0));
      const zoom=s.svg?d3.zoomTransform(s.svg.node()).k:1;
      const marks=layer.append('g').attr('class','map-symbol-layer').selectAll('g').data(anchors).join('g').attr('class','map-symbol').attr('data-spot-id',datum=>datum.id).attr('data-symbol-value',datum=>datum.row.value==null?'':datum.row.value).attr('transform',datum=>symbolTransform(datum.location,zoom)).attr('role','button').attr('aria-label',datum=>rowDescription(datum.row));
      marks.each(function(datum){
        const mark=d3.select(this),value=datum.row.value,radius=symbolRadius(value,maxValue(),s.size,s.viewport?.width||chart.clientWidth||1100);
        mark.attr('data-symbol-radius',radius);
        if(!finite(value)){mark.append('path').attr('d','M-3,-3L3,3M-3,3L3,-3').attr('stroke','#748079').attr('stroke-width',1.5);return;}
        if(value===0){mark.append('circle').attr('class','map-symbol-outline').attr('r',2.5).attr('fill','white').attr('stroke','#718278').attr('stroke-width',1);return;}
        if(mode()==='composition'){
          const debris=raw(datum.row,mixKeys().debris).mean,burn=raw(datum.row,mixKeys().burn).mean;
          if(!finite(debris)||!finite(burn)||debris<0||burn<0){mark.append('circle').attr('r',radius).attr('fill','url(#map-no-data-pattern)');return;}
          const arcs=d3.pie().sort(null).value(item=>item.value)([{value:debris,colour:DEBRIS},{value:burn,colour:BURNING}]);
          mark.selectAll('path').data(arcs).join('path').attr('d',d3.arc().innerRadius(0).outerRadius(radius)).attr('fill',arc=>arc.data.colour).attr('stroke','#fff').attr('stroke-width',.4);
        }else mark.append('circle').attr('r',radius).attr('fill',DEBRIS).attr('fill-opacity',.65).attr('stroke','#fff').attr('stroke-width',.7);
        mark.append('circle').attr('class','map-symbol-outline').attr('r',radius).attr('fill','none').attr('stroke','#1B3B39').attr('stroke-width',.6).attr('pointer-events','none');
      });
      s.symbols=bindInspection(marks,datum=>datum.row,()=>null);
    }
    function draw() {
      if(!s.geometry||!s.rows.length||!window.d3)return;
      const width=Math.max(1,chart.clientWidth||1100),height=Math.max(1,chart.clientHeight||540);
      const projection=d3.geoEqualEarth().fitExtent([[12,12],[width-12,height-12]],{type:'Sphere'}),path=d3.geoPath(projection);
      mappedIds=new Set(s.geometry.features.map(featureId).filter(id=>id&&s.byId.has(id)));focusIds=Array.from(mappedIds).sort((a,b)=>(entities.get(a)?.name||a).localeCompare(entities.get(b)?.name||b));
      const previous=s.svg?d3.zoomTransform(s.svg.node()):d3.zoomIdentity,old=s.viewport||{width,height};
      const transform=d3.zoomIdentity.translate(previous.x*width/old.width,previous.y*height/old.height).scale(previous.k);
      s.viewport={width,height};s.symbols=null;chart.replaceChildren();
      const svg=d3.select(chart).append('svg').attr('viewBox','0 0 '+width+' '+height).attr('role','group').attr('aria-labelledby','world-map-svg-title world-map-svg-desc').attr('tabindex',0).attr('class','world-map-svg').style('width','100%').style('height','100%');
      svg.append('title').attr('id','world-map-svg-title').text(MODES[mode()]+': '+title()+', '+year());
      svg.append('desc').attr('id','world-map-svg-desc').text('Equal Earth map, '+statistic()+', '+year()+'. Arrow keys move between countries, Enter selects. Focus the background for plus/minus zoom, arrow-key pan and Home reset. All source entities are in the table.');
      const pattern=svg.append('defs').append('pattern').attr('id','map-no-data-pattern').attr('width',5).attr('height',5).attr('patternUnits','userSpaceOnUse');pattern.append('rect').attr('width',5).attr('height',5).attr('fill','#e9ece5');pattern.append('path').attr('d','M-1,1l2,-2M0,5l5,-5M4,6l2,-2').attr('stroke','#c6cec3').attr('stroke-width',.65);
      svg.append('path').datum({type:'Sphere'}).attr('d',path).attr('fill','#f7faf6').attr('stroke','#d4ddd5').attr('stroke-width',.8);
      const layer=svg.append('g');layer.append('path').datum(d3.geoGraticule10()).attr('d',path).attr('fill','none').attr('stroke','#dfe8df').attr('stroke-width',.6).attr('pointer-events','none');
      const bubbles=mode()==='symbols'||mode()==='composition';
      const paths=layer.append('g').selectAll('path').data(s.geometry.features).join('path').attr('d',path).attr('class','map-country').attr('data-spot-id',feature=>featureId(feature)||'').attr('fill',pathColour).attr('stroke','#fff').attr('stroke-width',.55).attr('vector-effect','non-scaling-stroke').attr('role',feature=>!bubbles&&featureRow(feature)?'button':null).attr('aria-hidden',bubbles?'true':null).attr('aria-label',feature=>featureRow(feature)?rowDescription(featureRow(feature)):feature.properties.name+'; no matched estimate');
      s.svg=svg;s.layer=layer;s.paths=paths;s.projection=projection;
      bindInspection(paths,featureRow,feature=>feature);
      if(bubbles)drawSymbols(layer,projection);
      const zoom=d3.zoom().scaleExtent([1,6]).extent([[0,0],[width,height]]).translateExtent([[-width*.3,-height*.3],[width*1.3,height*1.3]]).filter(event=>!event.button&&(event.type!=='wheel'||event.ctrlKey)).on('zoom',event=>applyZoom(event.transform));
      s.zoom=zoom;svg.call(zoom).on('dblclick.zoom',null);svg.call(zoom.transform,transform);
      svg.on('keydown.map',event=>{
        if(event.target!==svg.node())return;const t=d3.zoomTransform(svg.node());
        if(!['+','=','-','Home','0','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;
        event.preventDefault();if(event.key==='+'||event.key==='=')zoomTo(t.k*1.25);else if(event.key==='-')zoomTo(t.k/1.25);else if(event.key==='Home'||event.key==='0')svg.call(zoom.transform,d3.zoomIdentity);else svg.call(zoom.translateBy,(event.key==='ArrowLeft'?35:event.key==='ArrowRight'?-35:0)/t.k,(event.key==='ArrowUp'?35:event.key==='ArrowDown'?-35:0)/t.k);
      });
      chart.setAttribute('aria-busy','false');renderLegend();renderCoverage();renderTable();updateSelected();
    }
    function syncControls() {
      const fixed=s.mode==='composition'||s.mode==='bivariate';
      $('map-metric').disabled=fixed;$('map-statistic').disabled=s.mode==='composition';$('map-statistic').value=s.mode==='composition'?'Mean':s.statistic;
      const metricControl=$('map-metric').closest('.control'),statisticControl=$('map-statistic').closest('.control'),measurement=document.querySelector('fieldset.map-basis');
      if(metricControl)metricControl.hidden=fixed;if(measurement)measurement.hidden=s.mode==='bivariate';if(statisticControl)statisticControl.hidden=s.mode==='composition';
      const canPerPerson=s.mode==='composition'||Boolean(PAIRS[s.metric]),basisFixed=s.mode==='bivariate';
      document.querySelectorAll('input[name="map-basis"]').forEach(input=>{input.disabled=basisFixed||!canPerPerson;input.checked=input.value===(basisFixed||!canPerPerson?'total':s.basis);});
      if($('map-symbol-size-control'))$('map-symbol-size-control').hidden=s.mode!=='symbols'&&s.mode!=='composition';
      if($('world-map-title'))$('world-map-title').textContent=MODES[s.mode];
    }
    function resizeSymbols() {
      if(!s.layer||!s.projection||(mode()!=='symbols'&&mode()!=='composition'))return;
      hideTooltip();s.layer.select('.map-symbol-layer').remove();drawSymbols(s.layer,s.projection);updateSelected();renderLegend();
    }
    function populateMetrics() {
      const select=$('map-metric');if(!select||select.dataset.populated)return;
      select.replaceChildren();const priority=['plas_em','plas_debris_em','plas_burn_em','wg','pwg','open_burn_MSW','col_cov_pct_gen_exc_lit','plas_em_pct_pwg'];
      const definitions=Array.from(s.definitions.values()).filter(definition=>!Object.values(PAIRS).includes(definition.id));
      definitions.sort((a,b)=>{const ai=priority.indexOf(a.id),bi=priority.indexOf(b.id);return ai>=0||bi>=0?(ai<0?999:ai)-(bi<0?999:bi):a.name.localeCompare(b.name);});
      definitions.forEach(definition=>{const option=document.createElement('option');option.value=definition.id;option.textContent=definition.name;select.append(option);});
      select.value=s.metric;select.dataset.populated='true';
    }
    async function loadData() {
      const revision=++s.revision,view={mode:s.mode,metric:s.mode==='composition'?metricForBasis('plas_em',s.basis):s.mode==='bivariate'?'plas_em_per_cap':metricForBasis(s.metric,s.basis),basis:s.mode==='bivariate'?'per_capita':s.basis,statistic:s.mode==='composition'?'Mean':s.statistic};
      s.loading=true;chart.setAttribute('aria-busy','true');hideTooltip();markStatus('Loading…');syncControls();
      try {
        let pending=cache.get(view.statistic);if(!pending){pending=json('/api/atlas?'+new URLSearchParams({statistic:view.statistic})).catch(error=>{cache.delete(view.statistic);throw error;});cache.set(view.statistic,pending);}
        const result=await pending;if(revision!==s.revision)return;
        s.release=result.release;s.definitions=new Map(result.metrics.filter(definition=>definition.family==='outputs').map(definition=>[definition.id,definition]));s.applied=view;
        s.rows=atlasRows(result,view);
        s.byId=new Map(s.rows.map(row=>[row.id,row]));s.xBounds=thirds(s.rows.map(row=>central(row,'col_cov_pct_gen_exc_lit')));s.yBounds=thirds(s.rows.map(row=>central(row,'plas_em_per_cap')));
        s.loading=false;markStatus(s.boundaryError||'',Boolean(s.boundaryError));populateMetrics();if($('map-chart-title'))$('map-chart-title').textContent=title();renderLegend();renderTable();updateSelected();draw();if(!s.geometry)chart.setAttribute('aria-busy','false');
      } catch(error) { if(revision!==s.revision)return;s.loading=false;chart.setAttribute('aria-busy','false');markStatus(error.message,true); }
    }
    $('map-mode').addEventListener('change',()=>{s.mode=$('map-mode').value;loadData();});
    $('map-metric').addEventListener('change',()=>{s.metric=$('map-metric').value;if(!PAIRS[s.metric])s.basis='total';loadData();});
    document.querySelectorAll('input[name="map-basis"]').forEach(input=>input.addEventListener('change',()=>{if(input.checked){s.basis=input.value;loadData();}}));
    $('map-statistic').addEventListener('change',()=>{s.statistic=$('map-statistic').value;loadData();});
    $('map-symbol-size').addEventListener('input',event=>{s.size=Math.max(.5,Math.min(2,Number(event.target.value)));event.target.setAttribute('aria-valuetext',number(s.size)+' times');resizeSymbols();});
    $('map-zoom-range').addEventListener('input',event=>zoomTo(event.target.value));$('map-zoom-in').addEventListener('click',()=>zoomTo(Number($('map-zoom-range').value)*1.25));$('map-zoom-out').addEventListener('click',()=>zoomTo(Number($('map-zoom-range').value)/1.25));$('map-reset').addEventListener('click',()=>{if(s.svg)s.svg.call(s.zoom.transform,d3.zoomIdentity);});
    $('map-search-form').addEventListener('submit',event=>{event.preventDefault();const value=$('map-search').value.trim().toLowerCase(),entity=options.entities.find(item=>item.id.toLowerCase()===value||item.name.toLowerCase()===value||(item.name+' ('+item.id+')').toLowerCase()===value);if(entity)choose(entity.id);else markStatus('Choose a country name or source code.',true);});
    $('map-profile-link').addEventListener('click',()=>{if(window.SPOTApp?.showTab)window.SPOTApp.showTab('country');else $('country').scrollIntoView();$('country-search').focus({preventScroll:true});});
    const resize=()=>{hideTooltip();if(chart.clientWidth&&chart.clientHeight&&(!s.viewport||Math.abs(chart.clientWidth-s.viewport.width)>1||Math.abs(chart.clientHeight-s.viewport.height)>1))draw();};
    window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,120);});
    if(window.ResizeObserver){const observer=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,60);});observer.observe(chart);}
    Promise.all([json('/static/assets/world_boundaries.geojson'),json('/static/assets/map_crosswalk.json')]).then(([geometry,crosswalk])=>{s.geometry=geometry;s.crosswalk=crosswalk;s.anchors=entityAnchors(geometry,d3);s.boundaryError=null;draw();}).catch(()=>{s.boundaryError='The boundary layer could not be loaded. Source values remain in the table.';markStatus(s.boundaryError,true);chart.setAttribute('aria-busy','false');renderTable();});
    loadData();
    return {select(id){s.selected=id;updateSelected();},refresh:loadData,resize};
  }
  if(typeof window!=='undefined')window.SPOTMap={create};
  if(typeof module!=='undefined'&&module.exports)module.exports={symbolRadius,markerScale,thirds,classIndex,metricForBasis,entityAnchors,atlasRows};
})();
