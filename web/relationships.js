'use strict';
(function () {
  const finite=v=>typeof v==='number'&&Number.isFinite(v);
  const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt=v=>finite(v)?new Intl.NumberFormat('en-GB',Math.abs(v)>0&&Math.abs(v)<.01?{maximumSignificantDigits:3}:{maximumFractionDigits:3}).format(v):'Unavailable';
  const labels={col_cov_pct_gen_exc_lit:'Collection service coverage',plas_em_per_cap:'Plastic emissions / person',pwg_per_cap:'Plastic waste generated / person',wg_per_cap:'Municipal waste generated / person',plas_debris_em_per_cap:'Plastic debris / person',plas_burn_em_per_cap:'Openly burned plastic / person',plas_em:'Plastic emissions',pwg:'Plastic waste generated',wg:'Municipal waste generated',plas_debris_em:'Plastic debris',plas_burn_em:'Openly burned plastic',plas_em_pct_pwg:'Plastic emitted / generated',recy_pct_gen:'Collected for recycling',man_cont_pct_gen:'Managed in controlled facilities'};
  const incomeColours={LIC:'#6C85BC',LMC:'#DC99C4',UMC:'#707C40',HIC:'#DF753F'};
  const incomeNames={LIC:'Low income',LMC:'Lower middle income',UMC:'Upper middle income',HIC:'High income'};
  const regionColours={Africa:'#707C40',Americas:'#DF753F',Asia:'#6C85BC',Europe:'#4A8484',Oceania:'#DC99C4',NA:'#968C8C'};
  const presets={coverage:{x:'col_cov_pct_gen_exc_lit',y:'plas_em_per_cap',logX:false,logY:true},generation:{x:'pwg_per_cap',y:'plas_em_per_cap',logX:true,logY:true},mix:{x:'plas_debris_em_per_cap',y:'plas_burn_em_per_cap',logX:true,logY:true},scale:{x:'plas_em',y:'plas_em_per_cap',logX:true,logY:true}};

  function create(options) {
    const root=document.getElementById('relationships-panel');
    const state={atlas:null,selected:null,x:'col_cov_pct_gen_exc_lit',y:'plas_em_per_cap',logX:false,logY:true,statistic:'Mean',colour:'income',size:'equal',region:'all',income:'all',blob:null,visible:[]};
    root.classList.add('relationships-workspace');
    root.innerHTML=`<aside class="rel-controls" aria-label="Country comparison controls">
      <label>Comparison<select id="rel-preset"><option value="coverage">Collection &amp; emissions</option><option value="generation">Plastic generation &amp; emissions</option><option value="mix">Debris &amp; burning</option><option value="scale">Total &amp; per person</option><option value="custom">Custom axes</option></select></label>
      <label>Horizontal axis<select id="rel-x"></select></label><label>Vertical axis<select id="rel-y"></select></label>
      <div class="rel-checks"><label><input id="rel-log-x" type="checkbox"> Log horizontal</label><label><input id="rel-log-y" type="checkbox" checked> Log vertical</label></div>
      <label>Statistic<select id="rel-statistic"><option>Mean</option><option>Median</option></select></label>
      <label>Colour<select id="rel-colour"><option value="income">Income category</option><option value="region">Region</option></select></label>
      <label>Circle area<select id="rel-size"><option value="equal">Equal markers</option><option value="plas_em">Total plastic emissions</option><option value="population">Population</option></select></label>
      <label>Region<select id="rel-region"><option value="all">All regions</option></select></label>
      <label>Income category<select id="rel-income"><option value="all">All categories</option></select></label>
      <form id="rel-search-form"><label for="rel-search">Find a country</label><div class="rel-search-row"><input id="rel-search" list="country-options" type="search" placeholder="Name or code" autocomplete="off"><button aria-label="Select comparison country" type="submit">→</button></div></form>
      <div class="rel-actions"><button id="rel-table-button" type="button">Data table</button><a id="rel-csv" href="#">CSV</a></div>
    </aside><div class="rel-display"><div id="rel-status" role="status" aria-live="polite">Loading country estimates…</div><div id="rel-legend" class="rel-legend"></div><div id="rel-plot" class="rel-plot" aria-busy="true"><div id="rel-tooltip" class="rel-tooltip" role="tooltip" hidden></div></div><div id="rel-selection" class="rel-selection" aria-live="polite">Select a country</div></div>
    <dialog id="rel-table-dialog" class="rel-table-dialog"><div class="rel-dialog-heading"><h2>Country comparison data · 2020</h2><button id="rel-table-close" type="button">Close</button></div><div class="table-scroll"><table><caption id="rel-table-caption"></caption><thead><tr><th>Country / territory</th><th>Code</th><th id="rel-table-x"></th><th id="rel-table-y"></th><th>Income category</th><th>Region</th></tr></thead><tbody id="rel-table-body"></tbody></table></div><p class="rel-source">Cottom, Cook &amp; Velis (2026), <a href="https://doi.org/10.5281/zenodo.22231994">SPOT V1.4.1-G-0426</a>. Modelled 2020 estimates.</p></dialog>`;
    const $=id=>root.querySelector('#'+id),tooltip=$('rel-tooltip'),plot=$('rel-plot');
    let definitions=new Map(),groups=null,svg=null,focusId=null;
    const definition=id=>definitions.get(id);
    const label=id=>labels[id]||definition(id)?.name||id;
    const unit=id=>definition(id)?.display_unit||definition(id)?.unit||'';
    const value=(row,id)=>{const entry=row.values[id];return entry?entry[state.statistic==='Mean'?'mean':'median']:null;};
    const colour=row=>state.colour==='income'?(incomeColours[row.income]||'#968C8C'):(regionColours[row.region]||'#968C8C');
    const filtered=()=>state.atlas?state.atlas.rows.filter(row=>(state.region==='all'||row.region===state.region)&&(state.income==='all'||row.income===state.income)):[];
    function hideTip(){tooltip.hidden=true;}
    function summary(row) {return row.name+' ('+row.id+') · '+label(state.x)+': '+fmt(value(row,state.x))+' '+unit(state.x)+' · '+label(state.y)+': '+fmt(value(row,state.y))+' '+unit(state.y);}
    function updateSelection(){
      const row=state.atlas?.rows.find(row=>row.id===state.selected);
      $('rel-selection').textContent=row?summary(row)+(state.visible.some(r=>r.id===row.id)?'':' · Outside current filters'): 'Select a country';
      if(groups){const current=state.visible.some(row=>row.id===focusId)?focusId:state.visible.some(row=>row.id===state.selected)?state.selected:state.visible[0]?.id;
        groups.classed('rel-point-selected',row=>row.id===state.selected).attr('aria-pressed',row=>String(row.id===state.selected)).attr('tabindex',row=>row.id===current?0:-1);
        groups.select('.rel-point-label').text(row=>row.id===state.selected?row.name+' ('+row.id+')':'');
        groups.filter(row=>row.id===state.selected).raise();}
    }
    function choose(id){state.selected=id;updateSelection();hideTip();options.onSelect(id);}
    function inspect(event,row){
      const fields=[state.x,state.y].map(id=>{const v=row.values[id];return '<p>'+esc(label(id))+': <b>'+esc(fmt(value(row,id)))+'</b> '+esc(unit(id))+'</p><p class="rel-tooltip-range">5th–95th: '+esc(fmt(v?.low))+'–'+esc(fmt(v?.high))+'</p>';}).join('');
      tooltip.innerHTML='<strong>'+esc(row.name)+' ('+esc(row.id)+')</strong>'+fields;tooltip.hidden=false;
      const bounds=plot.getBoundingClientRect(),anchor=event.currentTarget?.getBoundingClientRect(),pointer=event.type?.startsWith('pointer');
      const x=pointer?event.clientX-bounds.left:anchor?anchor.left-bounds.left+anchor.width/2:20,y=pointer?event.clientY-bounds.top:anchor?anchor.top-bounds.top:20;
      tooltip.style.left=Math.max(4,Math.min(x+12,bounds.width-tooltip.offsetWidth-4))+'px';tooltip.style.top=Math.max(4,Math.min(y+12,bounds.height-tooltip.offsetHeight-4))+'px';
    }
    function keyboard(event,row){
      if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(row.id);return;}
      const sorted=state.visible.slice().sort((a,b)=>a.name.localeCompare(b.name)),index=sorted.findIndex(r=>r.id===row.id);let next;
      if(event.key==='ArrowRight'||event.key==='ArrowDown')next=sorted[(index+1)%sorted.length];
      if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=sorted[(index-1+sorted.length)%sorted.length];
      if(event.key==='Home')next=sorted[0];if(event.key==='End')next=sorted.at(-1);
      if(next){event.preventDefault();focusId=next.id;updateSelection();groups.filter(r=>r.id===next.id).node()?.focus();}
    }
    function updateTable(rows){
      $('rel-table-x').textContent=label(state.x)+' · 2020 ('+unit(state.x)+')';$('rel-table-y').textContent=label(state.y)+' · 2020 ('+unit(state.y)+')';
      $('rel-table-caption').textContent=state.statistic+' · '+rows.length+' reporting entities in the selected region/income filters. Values excluded by a log axis remain in this table.';
      $('rel-table-body').innerHTML=rows.slice().sort((a,b)=>a.name.localeCompare(b.name)).map(row=>'<tr><th scope="row"><button data-rel-country="'+esc(row.id)+'">'+esc(row.name)+'</button></th><td>'+esc(row.id)+'</td><td class="number">'+esc(fmt(value(row,state.x)))+'</td><td class="number">'+esc(fmt(value(row,state.y)))+'</td><td>'+esc(row.income)+'</td><td>'+esc(row.region)+'</td></tr>').join('');
      $('rel-table-body').querySelectorAll('[data-rel-country]').forEach(button=>button.addEventListener('click',()=>{choose(button.dataset.relCountry);$('rel-table-dialog').close();}));
      const csvCell=v=>{if(v===null||v===undefined)return '';return '"'+String(v).replace(/"/g,'""')+'"';};
      const header=['release','model_year','entity_id','entity_name','statistic','x_metric','x_value','x_unit','x_5th','x_95th','y_metric','y_value','y_unit','y_5th','y_95th','population','income','region'];
      const release=state.atlas.release.version||state.atlas.release.model_version||'V1.4.1-G-0426';
      const lines=[header,...rows.map(row=>[release,2020,row.id,row.name,state.statistic,state.x,value(row,state.x),unit(state.x),row.values[state.x]?.low,row.values[state.x]?.high,state.y,value(row,state.y),unit(state.y),row.values[state.y]?.low,row.values[state.y]?.high,row.population,row.income,row.region])];
      if(state.blob)URL.revokeObjectURL(state.blob);state.blob=URL.createObjectURL(new Blob(['\ufeff'+lines.map(line=>line.map(csvCell).join(',')).join('\r\n')+'\r\n'],{type:'text/csv;charset=utf-8'}));
      $('rel-csv').href=state.blob;$('rel-csv').download='SPOT_2020_'+state.x+'_vs_'+state.y+'_'+state.statistic+'.csv';
    }
    function draw(){
      if(!state.atlas)return;const rows=filtered();
      state.visible=rows.filter(row=>{const x=value(row,state.x),y=value(row,state.y);return finite(x)&&finite(y)&&(!state.logX||x>0)&&(!state.logY||y>0);});
      updateTable(rows);updateSelection();
      $('rel-status').textContent=state.visible.length+' of '+rows.length+' countries / territories shown'+(state.visible.length<rows.length?' · Missing or non-positive log values omitted':'');
      const categories=Array.from(new Set(rows.map(row=>row[state.colour]))).sort((a,b)=>state.colour==='income'?['LIC','LMC','UMC','HIC'].indexOf(a)-['LIC','LMC','UMC','HIC'].indexOf(b):String(a).localeCompare(String(b)));
      $('rel-legend').innerHTML=categories.map(category=>'<span><i style="background:'+(state.colour==='income'?(incomeColours[category]||'#968C8C'):(regionColours[category]||'#968C8C'))+'"></i>'+esc(state.colour==='income'?(incomeNames[category]||category):category)+'</span>').join('')+'<span class="rel-size-label">'+(state.size==='equal'?'Equal markers':state.size==='population'?'Area: population':'Area: total plastic emissions')+'</span>';
      const bounds=plot.getBoundingClientRect();if(bounds.width<100||bounds.height<100)return;
      hideTip();plot.querySelector('svg')?.remove();
      const width=bounds.width,height=bounds.height,left=70,right=26,top=24,bottom=62;
      svg=d3.select(plot).insert('svg',':first-child').attr('viewBox','0 0 '+width+' '+height).attr('role','group').attr('aria-label',label(state.x)+' versus '+label(state.y)+', '+state.statistic+', modelled 2020').attr('data-x-metric',state.x).attr('data-y-metric',state.y).attr('data-statistic',state.statistic).attr('data-count',state.visible.length);
      if(!state.visible.length){svg.append('text').attr('x',width/2).attr('y',height/2).attr('text-anchor','middle').text('No estimates for these filters');plot.setAttribute('aria-busy','false');return;}
      function scale(id,log,range){const vals=state.visible.map(row=>value(row,id));let min=d3.min(vals),max=d3.max(vals);if(log){if(min===max){min/=1.2;max*=1.2;}return d3.scaleLog().domain([min/1.5,max*1.5]).range(range);}if(min===max)max=min===0?1:min*1.1;if(unit(id)==='%'&&min>=0&&max<=100)return d3.scaleLinear().domain([0,100]).range(range);return d3.scaleLinear().domain([Math.min(0,min),max*1.07]).range(range).nice();}
      const x=scale(state.x,state.logX,[left,width-right]),y=scale(state.y,state.logY,[height-bottom,top]);
      const axisFormat=v=>Math.abs(v)>=1e6?fmt(v/1e6)+'m':Math.abs(v)>=1e3?fmt(v/1e3)+'k':fmt(v);
      function ticks(scale,log,count,spacing){if(!log)return scale.ticks(count);const [lo,hi]=scale.domain(),values=[];for(let power=Math.floor(Math.log10(lo));power<=Math.ceil(Math.log10(hi));power++){for(const factor of [1,2,5]){const v=factor*10**power;if(v>=lo&&v<=hi&&(!values.length||Math.abs(scale(v)-scale(values.at(-1)))>=spacing))values.push(v);}}return values;}
      const xTicks=ticks(x,state.logX,Math.max(3,Math.floor(width/120)),55),yTicks=ticks(y,state.logY,Math.max(3,Math.floor(height/85)),28);
      svg.append('g').attr('class','rel-grid').attr('transform','translate('+left+',0)').call(d3.axisLeft(y).tickValues(yTicks).tickSize(-(width-left-right)).tickFormat('')).call(g=>g.select('.domain').remove());
      svg.append('g').attr('class','rel-axis').attr('transform','translate(0,'+(height-bottom)+')').call(d3.axisBottom(x).tickValues(xTicks).tickFormat(axisFormat));
      svg.append('g').attr('class','rel-axis').attr('transform','translate('+left+',0)').call(d3.axisLeft(y).tickValues(yTicks).tickFormat(axisFormat));
      svg.append('text').attr('class','rel-axis-title').attr('x',(left+width-right)/2).attr('y',height-15).attr('text-anchor','middle').text(label(state.x)+' ('+unit(state.x)+')'+(state.logX?' · log':''));
      svg.append('text').attr('class','rel-axis-title').attr('transform','translate(17,'+((top+height-bottom)/2)+') rotate(-90)').attr('text-anchor','middle').text(label(state.y)+' ('+unit(state.y)+')'+(state.logY?' · log':''));
      const sizeValue=row=>state.size==='population'?row.population:value(row,'plas_em');
      const radius=d3.scaleSqrt().domain([0,d3.max(state.visible,row=>Math.max(0,sizeValue(row)||0))||1]).range([0,Math.min(30,width*.055,height*.075)]);
      groups=svg.append('g').selectAll('g').data(state.visible.slice().sort((a,b)=>(sizeValue(b)||0)-(sizeValue(a)||0))).join('g').attr('class','rel-point').attr('data-country',row=>row.id).attr('transform',row=>'translate('+x(value(row,state.x))+','+y(value(row,state.y))+')').attr('role','button').attr('aria-label',summary).on('pointerenter',inspect).on('pointermove',inspect).on('pointerleave',hideTip).on('focus',inspect).on('blur',hideTip).on('click',(event,row)=>choose(row.id)).on('keydown',keyboard);
      groups.append('circle').attr('class','rel-hit').attr('r',row=>Math.max(7,state.size==='equal'?4.5:radius(sizeValue(row)))).attr('fill','transparent');
      groups.append('circle').attr('class','rel-mark').attr('r',row=>state.size==='equal'?4.5:radius(sizeValue(row))).attr('fill',colour).attr('fill-opacity',.72).attr('stroke','#fff').attr('stroke-width',.6).attr('data-value',row=>state.size==='equal'?null:sizeValue(row));
      groups.append('circle').attr('class','rel-selected-ring').attr('r',row=>Math.max(5.5,(state.size==='equal'?4.5:radius(sizeValue(row)))+2));
      groups.append('text').attr('class','rel-point-label').attr('x',row=>x(value(row,state.x))>width*.6?-6:6).attr('text-anchor',row=>x(value(row,state.x))>width*.6?'end':'start').attr('y',-9);
      updateSelection();plot.setAttribute('aria-busy','false');
    }
    function controlsToState(){state.x=$('rel-x').value;state.y=$('rel-y').value;state.statistic=$('rel-statistic').value;state.colour=$('rel-colour').value;state.size=$('rel-size').value;state.region=$('rel-region').value;state.income=$('rel-income').value;state.logX=$('rel-log-x').checked;state.logY=$('rel-log-y').checked;draw();}
    ['rel-x','rel-y'].forEach(id=>$(id).addEventListener('change',()=>{$('rel-preset').value='custom';controlsToState();}));
    ['rel-statistic','rel-colour','rel-size','rel-region','rel-income','rel-log-x','rel-log-y'].forEach(id=>$(id).addEventListener('change',controlsToState));
    $('rel-preset').addEventListener('change',()=>{const preset=presets[$('rel-preset').value];if(!preset)return;Object.assign(state,preset);$('rel-x').value=state.x;$('rel-y').value=state.y;$('rel-log-x').checked=state.logX;$('rel-log-y').checked=state.logY;draw();});
    $('rel-search-form').addEventListener('submit',event=>{event.preventDefault();const needle=$('rel-search').value.trim().toLowerCase(),row=state.atlas?.rows.find(r=>r.id.toLowerCase()===needle||r.name.toLowerCase()===needle||(r.name+' ('+r.id+')').toLowerCase()===needle);if(row)choose(row.id);else $('rel-status').textContent='Select a country name or code from the released data.';});
    $('rel-table-button').addEventListener('click',()=>$('rel-table-dialog').showModal());$('rel-table-close').addEventListener('click',()=>$('rel-table-dialog').close());
    $('rel-table-dialog').addEventListener('click',event=>{if(event.target===$('rel-table-dialog')){const b=event.target.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)event.target.close();}});
    fetch('/api/atlas?statistic=Mean',{headers:{Accept:'application/json'}}).then(response=>{if(!response.ok)throw Error('Country comparisons could not be loaded.');return response.json();}).then(atlas=>{
      state.atlas=atlas;definitions=new Map(atlas.metrics.map(metric=>[metric.id,metric]));
      const choices=Object.keys(labels).filter(id=>definitions.has(id));
      ['rel-x','rel-y'].forEach(id=>{$(id).innerHTML=choices.map(key=>'<option value="'+key+'">'+esc(label(key))+'</option>').join('');});$('rel-x').value=state.x;$('rel-y').value=state.y;
      $('rel-region').innerHTML+=[...new Set(atlas.rows.map(row=>row.region))].sort().map(key=>'<option value="'+esc(key)+'">'+esc(key)+'</option>').join('');
      $('rel-income').innerHTML+=['LIC','LMC','UMC','HIC',...[...new Set(atlas.rows.map(row=>row.income))].filter(key=>!incomeNames[key])].map(key=>'<option value="'+esc(key)+'">'+esc(incomeNames[key]||key)+'</option>').join('');draw();
    }).catch(error=>{$('rel-status').textContent=error.message;plot.setAttribute('aria-busy','false');});
    let timer;window.addEventListener('resize',()=>{clearTimeout(timer);timer=setTimeout(draw,150);});
    return {resize:draw,select(id){state.selected=id;updateSelection();}};
  }
  window.SPOTRelationships={create};
})();
