'use strict';
(function () {
  const METRICS={total:'plas_em',perPerson:'plas_em_per_cap',percent:'plas_em_pct_pwg'};
  const UNITS={total:'tonnes / year',perPerson:'kg / person / year',percent:'% of plastic waste generated'};
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const format=value=>finite(value)?new Intl.NumberFormat('en-GB',value!==0&&Math.abs(value)<.01?{maximumSignificantDigits:4}:{maximumFractionDigits:3}).format(value):'Unavailable';
  const compact=value=>!finite(value)?'Unavailable':Math.abs(value)>=1e6?format(value/1e6)+'m':Math.abs(value)>=1e3?format(value/1e3)+'k':format(value);
  const idOrder=(a,b)=>a.id<b.id?-1:a.id>b.id?1:0;
  function central(row,metric,statistic) {
    const source=row.values?.[metric],value=source?.[statistic==='Median'?'median':'mean'];
    return finite(value)?value:null;
  }
  // Exact source ties share a competition rank: 1, 1, 3. A published zero is
  // ranked; null/nonfinite values have no rank and are never changed to zero.
  function rankMetric(rows,metric,statistic) {
    if(new Set(rows.map(row=>row.id)).size!==rows.length)throw Error('Duplicate reporting entity in ranking data.');
    const sorted=rows.map(row=>({id:row.id,value:central(row,metric,statistic)})).filter(row=>finite(row.value)).sort((a,b)=>b.value-a.value||idOrder(a,b));
    const ranks=new Map();let previous,rank=0;
    sorted.forEach((row,index)=>{if(index===0||row.value!==previous)rank=index+1;ranks.set(row.id,rank);previous=row.value;});
    return ranks;
  }
  function matchesFilters(row,filters) {return (!filters.region||filters.region==='all'||row.region===filters.region)&&(!filters.income||filters.income==='all'||row.income===filters.income);}
  function buildRecords(rows,filters,statistic) {
    const selected=rows.filter(row=>matchesFilters(row,filters)),globalRanks={},filteredRanks={};
    Object.entries(METRICS).forEach(([key,id])=>{globalRanks[key]=rankMetric(rows,id,statistic);filteredRanks[key]=rankMetric(selected,id,statistic);});
    return rows.map(row=>{
      const values={},ranks={},global={};
      Object.entries(METRICS).forEach(([key,id])=>{const source=row.values?.[id]||{};values[key]={value:central(row,id,statistic),mean:finite(source.mean)?source.mean:null,median:finite(source.median)?source.median:null,low:finite(source.low)?source.low:null,high:finite(source.high)?source.high:null};ranks[key]=filteredRanks[key].get(row.id)??null;global[key]=globalRanks[key].get(row.id)??null;});
      return {id:row.id,name:row.name,income:row.income,region:row.region,inFilters:matchesFilters(row,filters),values,ranks,globalRanks:global};
    });
  }
  function plotRows(records,mode,order,limit,selected) {
    const key=mode==='percent'?'percent':order==='perPerson'?'perPerson':'total',count=Math.max(1,Math.min(50,Math.floor(Number(limit)||10)));
    const eligible=records.filter(row=>row.inFilters&&finite(row.ranks[key])).sort((a,b)=>a.ranks[key]-b.ranks[key]||idOrder(a,b));
    const cutoff=eligible[Math.min(count,eligible.length)-1]?.ranks[key],visible=eligible.filter(row=>row.ranks[key]<=cutoff),extraTies=Math.max(0,visible.length-count),chosen=eligible.find(row=>row.id===selected);
    const extraSelected=Boolean(chosen&&!visible.some(row=>row.id===chosen.id));if(extraSelected)visible.push(chosen);
    return {rows:visible,eligibleCount:eligible.length,key,extraSelected,extraTies};
  }
  function csvCell(value){if(value===null||value===undefined)return '';return '"'+String(value).replace(/"/g,'""')+'"';}
  function buildCSV(records,context) {
    const header=['release','model_year','entity_id','entity_name','statistic','region','income','income_classification_year','region_filter','income_filter','in_filters','shown_in_plot','rank_method'];
    Object.entries(METRICS).forEach(([key,id])=>header.push(id+'_value',id+'_unit',id+'_mean',id+'_median',id+'_5th',id+'_95th',id+'_global_rank',id+'_filtered_rank'));
    const shown=new Set(context.displayed||[]);
    const lines=records.slice().sort(idOrder).map(row=>{
      const line=[context.release,context.year??2020,row.id,row.name,context.statistic,row.region,row.income,'',context.region||'all',context.income||'all',row.inFilters,shown.has(row.id),'competition_exact_ties'];
      Object.entries(METRICS).forEach(([key])=>{const source=row.values[key];line.push(source.value,UNITS[key],source.mean,source.median,source.low,source.high,row.globalRanks[key],row.ranks[key]);});
      return line;
    });
    return '\ufeff'+[header,...lines].map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n';
  }
  function create(options) {
    const root=document.getElementById('rankings-panel');if(!root)throw Error('Rankings mount is missing.');
    const state={atlas:null,records:[],mode:'ranks',statistic:'Mean',order:'total',limit:10,region:'all',income:'all',selected:null,displayed:[],blob:null,focus:null};
    root.classList.add('rankings-workspace');
    root.innerHTML='<aside class="rk-controls" aria-label="Ranking controls">'+
      '<label>Measurement<select id="rk-mode"><option value="ranks">Total vs per person</option><option value="percent">Emissions / plastic generated (%)</option></select></label>'+
      '<label>Statistic<select id="rk-statistic"><option value="Mean">Mean</option><option value="Median">Median</option></select></label>'+
      '<label id="rk-order-control">Order by<select id="rk-order"><option value="total">Total plastic emissions</option><option value="perPerson">Per-person plastic emissions</option></select></label>'+
      '<label class="rk-slider-label" for="rk-limit">Top N <output id="rk-limit-label">10</output></label><input id="rk-limit" type="range" min="5" max="30" step="1" value="10" aria-label="Number of leading countries, including ties">'+
      '<label>Region<select id="rk-region"><option value="all">All regions</option></select></label>'+
      '<label>Income category<select id="rk-income"><option value="all">All categories</option></select></label>'+
      '<label id="rk-country-label">Highlight country<select id="rk-country"><option value="">No highlight</option></select></label>'+
      '<div class="rk-actions"><button id="rk-table-open" type="button">Data table</button><a id="rk-csv" href="#" download>All-country CSV</a></div><button id="rk-country-profile" type="button">Country profile</button>'+
      '</aside><div class="rk-display"><div class="rk-heading"><h2 id="rk-title">Total and per-person ranks</h2><span>2020</span></div>'+
      '<div class="rk-legend" id="rk-legend"><span><i class="rk-key-total"></i>Total emissions</span><span><i class="rk-key-person"></i>Per person</span><span class="rk-rank-basis">Rank 1 = highest · within filters</span></div>'+
      '<div id="rk-status" role="status" aria-live="polite">Loading all countries…</div><div id="rk-canvas" class="rk-canvas" aria-busy="true"></div><div id="rk-tooltip" class="rk-tooltip" role="tooltip" hidden></div>'+
      '<div id="rk-selection" class="rk-selection" aria-live="polite">Select a country</div></div>'+
      '<dialog id="rk-table-dialog" class="rk-table-dialog" aria-labelledby="rk-table-title"><div class="rk-dialog-heading"><h2 id="rk-table-title">Country ranking data · 2020</h2><button id="rk-table-close" type="button">Close</button></div>'+
      '<div class="rk-table-controls"><label>Rows<select id="rk-table-scope"><option value="all">All countries and territories</option><option value="filtered">Current filters only</option></select></label><a id="rk-table-csv" href="#" download>All-country CSV ↓</a></div><p id="rk-table-context"></p>'+
      '<div class="table-scroll"><table><caption id="rk-table-caption" class="sr-only"></caption><thead id="rk-table-head"></thead><tbody id="rk-table-body"></tbody></table></div></dialog>';
    const $=id=>root.querySelector('#'+id),canvas=$('rk-canvas'),tooltip=$('rk-tooltip'),display=root.querySelector('.rk-display'),ns='http://www.w3.org/2000/svg';
    let rowGroups=[],resizeTimer,frame=null;
    const svgNode=(tag,attrs,text)=>{const node=document.createElementNS(ns,tag);Object.entries(attrs||{}).forEach(([key,value])=>node.setAttribute(key,String(value)));if(text!=null)node.textContent=text;return node;};
    const sourceRelease=()=>state.atlas?.release.model_version||state.atlas?.release.version||'V1.4.1-G-0426';
    const selectedRow=()=>state.records.find(row=>row.id===state.selected);
    function summary(row) {
      if(state.mode==='percent')return row.name+' ('+row.id+') · '+format(row.values.percent.value)+'% of plastic waste generated · '+state.statistic+', 2020 · filtered rank '+(row.ranks.percent??'Unavailable');
      return row.name+' ('+row.id+') · total '+format(row.values.total.value)+' '+UNITS.total+', rank '+(row.ranks.total??'Unavailable')+' · per person '+format(row.values.perPerson.value)+' '+UNITS.perPerson+', rank '+(row.ranks.perPerson??'Unavailable');
    }
    function updateSelection() {
      const row=selectedRow();$('rk-selection').textContent=row?summary(row)+(row.inFilters?'':' · Outside current filters'):'Select a country';
      $('rk-country').value=state.records.some(item=>item.id===state.selected)?state.selected:'';
      $('rk-country-profile').disabled=!row;
      const focused=state.displayed.some(row=>row.id===state.focus)?state.focus:state.displayed.some(row=>row.id===state.selected)?state.selected:state.displayed[0]?.id;
      rowGroups.forEach(({node,row})=>{node.classList.toggle('rk-selected',row.id===state.selected);node.setAttribute('aria-pressed',String(row.id===state.selected));node.setAttribute('tabindex',row.id===focused?'0':'-1');});
    }
    function hideTooltip(){tooltip.hidden=true;}
    function choose(id){state.selected=id||null;hideTooltip();draw();rowGroups.find(item=>item.row.id===id)?.node.scrollIntoView({block:'nearest',inline:'nearest'});if(id)options.onSelect(id);}
    function inspect(event,row) {
      const keys=state.mode==='percent'?['percent']:['total','perPerson'];
      const labels={total:'Total emissions',perPerson:'Per person',percent:'Emissions / plastic generated'};
      tooltip.innerHTML='<strong>'+escape(row.name)+' ('+escape(row.id)+')</strong>'+keys.map(key=>{const value=row.values[key];return '<p>'+labels[key]+': <b>'+escape(format(value.value))+'</b> '+escape(UNITS[key])+'</p><p class="rk-tip-range">5th–95th: '+escape(format(value.low))+'–'+escape(format(value.high))+' · rank '+escape(row.ranks[key]??'Unavailable')+'</p>';}).join('')+'<p class="rk-tip-stat">'+escape(state.statistic)+' · 2020</p>';
      tooltip.hidden=false;const bounds=display.getBoundingClientRect(),anchor=event.currentTarget?.getBoundingClientRect(),pointer=event.type?.startsWith('pointer');
      const x=pointer?event.clientX-bounds.left:anchor?anchor.left-bounds.left+Math.min(anchor.width,100):10,y=pointer?event.clientY-bounds.top:anchor?anchor.top-bounds.top+15:20;
      tooltip.style.left=Math.max(5,Math.min(x+13,bounds.width-tooltip.offsetWidth-5))+'px';tooltip.style.top=Math.max(5,Math.min(y+13,bounds.height-tooltip.offsetHeight-5))+'px';
    }
    function keyboard(event,row) {
      if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(row.id);return;}
      const index=state.displayed.findIndex(item=>item.id===row.id);let next;
      if(event.key==='ArrowDown'||event.key==='ArrowRight')next=state.displayed[(index+1)%state.displayed.length];
      if(event.key==='ArrowUp'||event.key==='ArrowLeft')next=state.displayed[(index-1+state.displayed.length)%state.displayed.length];
      if(event.key==='Home')next=state.displayed[0];if(event.key==='End')next=state.displayed.at(-1);
      if(next){event.preventDefault();state.focus=next.id;updateSelection();rowGroups.find(item=>item.row.id===next.id)?.node.focus();}
    }
    function updateCSV() {
      const csv=buildCSV(state.records,{release:sourceRelease(),year:state.atlas.model_year||2020,statistic:state.statistic,region:state.region,income:state.income,displayed:state.displayed.map(row=>row.id)});
      if(state.blob)URL.revokeObjectURL(state.blob);state.blob=URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8'}));
      ['rk-csv','rk-table-csv'].forEach(id=>{$(id).href=state.blob;$(id).download='SPOT_2020_all_country_ranks_'+state.statistic+'.csv';});
    }
    function updateTable() {
      if(!state.atlas)return;const keys=state.mode==='percent'?['percent']:['total','perPerson'],labels={total:'Total emissions',perPerson:'Per person',percent:'Emissions / generated'};
      const filterOnly=$('rk-table-scope').value==='filtered',rows=state.records.filter(row=>!filterOnly||row.inFilters).slice().sort((a,b)=>a.name.localeCompare(b.name));
      $('rk-table-context').textContent=rows.length+' of '+state.records.length+' reporting entities · '+state.statistic+', 2020 · rank 1 is highest; exact ties share competition rank. The plot limit does not limit this table or CSV.';
      $('rk-table-caption').textContent='Published SPOT country values and ranks, '+state.statistic+', 2020. Global ranks use all available reporting entities. Filter ranks use the current region and income selection.';
      $('rk-table-head').innerHTML='<tr><th scope="col">Country / territory</th><th scope="col">Code</th><th scope="col">In filters</th>'+keys.map(key=>'<th scope="col">'+labels[key]+' · 2020 ('+UNITS[key]+')</th><th scope="col">5th percentile</th><th scope="col">95th percentile</th><th scope="col">Global rank</th><th scope="col">Filter rank</th>').join('')+'<th scope="col">Income category</th><th scope="col">Region</th></tr>';
      $('rk-table-body').innerHTML=rows.map(row=>'<tr><th scope="row"><button type="button" data-rk-country="'+escape(row.id)+'">'+escape(row.name)+'</button></th><td>'+escape(row.id)+'</td><td>'+(row.inFilters?'Yes':'No')+'</td>'+keys.map(key=>{const value=row.values[key];return '<td class="number">'+escape(format(value.value))+'</td><td class="number">'+escape(format(value.low))+'</td><td class="number">'+escape(format(value.high))+'</td><td class="number">'+(row.globalRanks[key]??'Unavailable')+'</td><td class="number">'+(row.ranks[key]??'—')+'</td>';}).join('')+'<td>'+escape(row.income)+'</td><td>'+escape(row.region)+'</td></tr>').join('');
      $('rk-table-body').querySelectorAll('[data-rk-country]').forEach(button=>button.addEventListener('click',()=>{choose(button.dataset.rkCountry);$('rk-table-dialog').close();}));
    }
    function draw() {
      if(!state.atlas)return;
      const focusedCountry=canvas.contains(document.activeElement)?document.activeElement.getAttribute('data-rk-country'):null;
      state.records=buildRecords(state.atlas.rows,{region:state.region,income:state.income},state.statistic);
      const selection=plotRows(state.records,state.mode,state.order,state.limit,state.selected);state.displayed=selection.rows;rowGroups=[];
      $('rk-order-control').hidden=state.mode==='percent';$('rk-limit-label').textContent=state.limit;$('rk-limit').setAttribute('aria-valuetext',state.limit+' leading countries');
      $('rk-title').textContent=state.mode==='percent'?'Emissions / plastic generated':'Total and per-person ranks';
      $('rk-legend').innerHTML=state.mode==='percent'?'<span>'+escape(UNITS.percent)+' · '+state.statistic+'</span><span class="rk-rank-basis">5th–95th percentile range</span>':'<span><i class="rk-key-total"></i>Total (tonnes/year)</span><span><i class="rk-key-person"></i>Per person (kg/person/year)</span><span class="rk-rank-basis">Rank 1 = highest · within filters</span>';
      const inFilters=state.records.filter(row=>row.inFilters).length;
      $('rk-status').textContent=state.displayed.length+' shown of '+selection.eligibleCount+' ranked · '+inFilters+' countries / territories in filters'+(selection.extraTies?' · cutoff ties included':'')+(selection.extraSelected?' · highlighted country added':'')+(selection.eligibleCount<inFilters?' · unavailable values excluded from ordering':'');
      updateCSV();updateTable();updateSelection();const bounds={width:Math.floor(canvas.clientWidth),height:Math.floor(canvas.clientHeight)};if(bounds.width<100||bounds.height<100)return;
      const previousScroll=canvas.scrollTop;hideTooltip();canvas.replaceChildren();
      if(!state.displayed.length){const empty=document.createElement('p');empty.className='rk-empty';empty.textContent='No released estimates match these filters.';canvas.append(empty);canvas.setAttribute('aria-busy','false');return;}
      const narrow=bounds.width<520,width=bounds.width,left=narrow?64:Math.min(190,width*.23),right=state.mode==='percent'?(narrow?50:95):25,top=43,bottom=30;
      const rowHeight=Math.max(narrow?30:25,Math.min(38,(bounds.height-top-bottom)/state.displayed.length)),height=Math.max(bounds.height,Math.ceil(top+bottom+rowHeight*state.displayed.length));
      const svg=svgNode('svg',{viewBox:'0 0 '+width+' '+height,role:'group','aria-label':state.mode==='percent'?'Plastic emissions as a native percentage of plastic generated, '+state.statistic+', 2020':'Total versus per-person plastic emission ranks, '+state.statistic+', 2020'});
      svg.style.height=height+'px';const plotWidth=Math.max(80,width-left-right),rankMaximum=Math.max(1,...state.records.filter(row=>row.inFilters).flatMap(row=>[row.ranks.total,row.ranks.perPerson].filter(finite)));
      const maximum=state.mode==='percent'?Math.max(100,...state.displayed.flatMap(row=>[row.values.percent.value,row.values.percent.low,row.values.percent.high].filter(finite))):rankMaximum;
      const X=value=>state.mode==='percent'?left+value/maximum*plotWidth:left+(value-1)/Math.max(1,maximum-1)*plotWidth;
      const tickCount=narrow?3:5,ticks=state.mode==='percent'?Array.from({length:tickCount+1},(_,i)=>maximum*i/tickCount):Array.from(new Set(Array.from({length:tickCount+1},(_,i)=>Math.round(1+(maximum-1)*i/tickCount))));
      ticks.forEach(value=>{const x=X(value);svg.append(svgNode('line',{x1:x,x2:x,y1:top-12,y2:height-bottom+3,class:'rk-grid-line'}));svg.append(svgNode('text',{x,y:top-22,'text-anchor':'middle',class:'rk-axis-tick'},state.mode==='percent'?format(value)+'%':String(value)));});
      svg.append(svgNode('text',{x:3,y:top-22,class:'rk-axis-tick'},narrow?'Code':'Country / territory'));
      state.displayed.forEach((row,index)=>{
        const describedKeys=state.mode==='percent'?['percent']:['total','perPerson'];
        const accessible=summary(row)+' · '+state.statistic+', 2020. '+describedKeys.map(key=>key+' 5th–95th percentile '+format(row.values[key].low)+' to '+format(row.values[key].high)+' '+UNITS[key]).join('; ');
        const y=top+rowHeight*(index+.5),g=svgNode('g',{class:'rk-chart-row','data-rk-country':row.id,role:'button','aria-label':accessible,'aria-pressed':String(row.id===state.selected),tabindex:-1});
        g.append(svgNode('rect',{x:0,y:y-rowHeight/2,width,height:rowHeight,class:'rk-row-background'}));
        const name=narrow?row.id:row.name.length>27?row.name.slice(0,25)+'…':row.name;g.append(svgNode('text',{x:3,y:y+4,class:'rk-row-name'},name));
        if(state.mode==='ranks'){
          const a=row.ranks.total,b=row.ranks.perPerson;
          if(finite(a)&&finite(b))g.append(svgNode('line',{x1:X(a),x2:X(b),y1:y,y2:y,class:'rk-rank-link'}));
          if(finite(a))g.append(svgNode('circle',{cx:X(a),cy:y,r:4.5,class:'rk-total-mark'}));
          if(finite(b))g.append(svgNode('circle',{cx:X(b),cy:y,r:4.5,class:'rk-person-mark'}));
          if(!finite(a)||!finite(b))g.append(svgNode('text',{x:width-right,y:y-7,'text-anchor':'end',class:'rk-unavailable'},'One rank unavailable'));
        }else{
          const source=row.values.percent,barY=y-5;
          if(finite(source.value))g.append(svgNode('rect',{x:left,y:barY,width:Math.max(0,X(source.value)-left),height:10,class:'rk-percent-bar',rx:1}));
          if(finite(source.low)&&finite(source.high)){g.append(svgNode('line',{x1:X(source.low),x2:X(source.high),y1:y,y2:y,class:'rk-interval'}));[source.low,source.high].forEach(value=>g.append(svgNode('line',{x1:X(value),x2:X(value),y1:y-7,y2:y+7,class:'rk-interval-cap'})));}
          if(finite(source.value))g.append(svgNode('circle',{cx:X(source.value),cy:y,r:3.5,class:'rk-percent-point'}));
          g.append(svgNode('text',{x:width-right+9,y:y+4,class:'rk-bar-value'},format(source.value)+'%'));
        }
        g.addEventListener('pointerenter',event=>inspect(event,row));g.addEventListener('pointermove',event=>inspect(event,row));g.addEventListener('pointerleave',hideTooltip);g.addEventListener('focus',event=>inspect(event,row));g.addEventListener('blur',hideTooltip);g.addEventListener('click',()=>choose(row.id));g.addEventListener('keydown',event=>keyboard(event,row));svg.append(g);rowGroups.push({node:g,row});
      });
      canvas.append(svg);canvas.scrollTop=previousScroll;canvas.setAttribute('aria-busy','false');updateSelection();if(focusedCountry)rowGroups.find(item=>item.row.id===focusedCountry)?.node.focus({preventScroll:true});
    }
    function controls() {state.mode=$('rk-mode').value;state.statistic=$('rk-statistic').value;state.order=$('rk-order').value;state.region=$('rk-region').value;state.income=$('rk-income').value;draw();}
    ['rk-mode','rk-statistic','rk-order','rk-region','rk-income'].forEach(id=>$(id).addEventListener('change',controls));
    $('rk-limit').addEventListener('input',event=>{state.limit=Math.max(5,Math.min(30,Number(event.target.value)));$('rk-limit-label').textContent=state.limit;if(frame!==null)cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{frame=null;draw();});});
    $('rk-country').addEventListener('change',()=>choose($('rk-country').value));
    $('rk-country-profile').addEventListener('click',()=>{if(window.SPOTApp?.showTab)window.SPOTApp.showTab('country');});
    $('rk-table-open').addEventListener('click',()=>{updateTable();$('rk-table-dialog').showModal();});$('rk-table-close').addEventListener('click',()=>$('rk-table-dialog').close());$('rk-table-scope').addEventListener('change',updateTable);
    $('rk-table-dialog').addEventListener('click',event=>{if(event.target===$('rk-table-dialog')){const b=event.target.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)event.target.close();}});
    fetch('/api/atlas?statistic=Mean',{headers:{Accept:'application/json'}}).then(response=>{if(!response.ok)throw Error('Country rankings could not be loaded.');return response.json();}).then(atlas=>{
      if(!Array.isArray(atlas.rows))throw Error('Ranking source rows are missing.');state.atlas=atlas;
      const rows=atlas.rows.slice().sort((a,b)=>a.name.localeCompare(b.name));$('rk-country').innerHTML='<option value="">No highlight</option>'+rows.map(row=>'<option value="'+escape(row.id)+'">'+escape(row.name)+' ('+escape(row.id)+')</option>').join('');
      $('rk-country-label').firstChild.textContent='Highlight country ('+rows.length+')';
      $('rk-region').innerHTML+=[...new Set(rows.map(row=>row.region))].sort().map(key=>'<option value="'+escape(key)+'">'+escape(key)+'</option>').join('');
      const names={LIC:'Low income',LMC:'Lower middle income',UMC:'Upper middle income',HIC:'High income'};$('rk-income').innerHTML+=[...new Set(rows.map(row=>row.income))].sort((a,b)=>['LIC','LMC','UMC','HIC'].indexOf(a)-['LIC','LMC','UMC','HIC'].indexOf(b)).map(key=>'<option value="'+escape(key)+'">'+escape(names[key]||key)+'</option>').join('');
      draw();
    }).catch(error=>{$('rk-status').textContent=error.message;canvas.setAttribute('aria-busy','false');});
    const resize=()=>{hideTooltip();draw();};window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(resize,120);});
    return {resize,select(id){state.selected=id;draw();}};
  }
  if(typeof window!=='undefined')window.SPOTRankings={create};
  if(typeof module!=='undefined'&&module.exports)module.exports={METRICS,UNITS,central,rankMetric,matchesFilters,buildRecords,plotRows,buildCSV};
})();
