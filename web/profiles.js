'use strict';
(function () {
  const finite=value=>typeof value==='number'&&Number.isFinite(value);
  const esc=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const fmt=value=>finite(value)?new Intl.NumberFormat('en-GB',value!==0&&Math.abs(value)<.01?{maximumSignificantDigits:4}:{maximumFractionDigits:3}).format(value):'Unavailable';
  const short=value=>!finite(value)?'Unavailable':Math.abs(value)>=1e6?fmt(value/1e6)+'m':Math.abs(value)>=1e3?fmt(value/1e3)+'k':fmt(value);
  const ORIGINS=Object.freeze([
    {id:'plas_litter_em',name:'Litter',colour:'#DC99C4'},
    {id:'plas_uncol_em',name:'Uncollected waste',colour:'#6C85BC'},
    {id:'plas_collection_em',name:'Collection',colour:'#72CBCB'},
    {id:'plas_disp_em',name:'Disposal',colour:'#707C40'},
    {id:'plas_recy_em',name:'Recycling',colour:'#DF753F'}
  ]);
  const DEFAULTS=['IND','CHN','GBR','USA','BRA','NGA'];
  const incomeNames={LIC:'Low income',LMC:'Lower middle income',UMC:'Upper middle income',HIC:'High income'};
  const unit=basis=>basis==='share'?'% of mean plastic emissions':basis==='per_capita'?'kg/person/year':'tonnes/year';
  function meanValue(row,id) {
    const entry=row.values?.[id];
    if(!entry)return null;
    return Object.hasOwn(entry,'mean')?(finite(entry.mean)?entry.mean:null):(finite(entry.value)?entry.value:null);
  }
  function near(left,right) {return finite(left)&&finite(right)&&Math.abs(left-right)<=Math.max(1e-9,Math.abs(right)*1e-10);}
  function profileValues(row,basis) {
    const totalMean=meanValue(row,'plas_em'),nativePerPerson=meanValue(row,'plas_em_per_cap');
    const validPopulation=finite(row.population)&&row.population>0;
    const segments=ORIGINS.map(origin=>{
      const nativeMean=meanValue(row,origin.id);
      let value=nativeMean;
      if(basis==='per_capita')value=finite(nativeMean)&&validPopulation?nativeMean*1000/row.population:null;
      if(basis==='share')value=finite(nativeMean)&&finite(totalMean)&&totalMean>0?nativeMean/totalMean*100:null;
      return {...origin,nativeMean,value};
    });
    const complete=segments.every(segment=>finite(segment.value)&&segment.value>=0);
    const sum=complete?segments.reduce((total,segment)=>total+segment.value,0):null;
    const total=basis==='share'?(finite(totalMean)&&totalMean>0?100:null):basis==='per_capita'?nativePerPerson:totalMean;
    return {id:row.id,name:row.name,row,basis,segments,totalMean,nativePerPerson,total,sum,complete,reconciles:finite(sum)&&finite(total)?near(sum,total):null};
  }
  function profilesCSV(rows,basis,release) {
    const header=['release','model_year','entity_id','entity_name','source_metric','source_name','source_mean_tonnes_year','source_5th_tonnes_year','source_median_tonnes_year','source_95th_tonnes_year','native_total_mean_tonnes_year','population','native_total_mean_kg_person_year','display_basis','display_value','display_unit','calculation'];
    const records=[header];
    for(const row of rows) {
      const profile=profileValues(row,basis);
      for(const segment of profile.segments) {
        const source=row.values[segment.id]||{};
        const calculation=basis==='share'?'source Mean / native total Mean * 100':basis==='per_capita'?'source Mean tonnes/year * 1000 / supplied population':'native source Mean';
        records.push([release.version||release.id||'',release.model_year||2020,row.id,row.name,segment.id,segment.name,segment.nativeMean,source.low,source.median,source.high,profile.totalMean,row.population,profile.nativePerPerson,basis,segment.value,unit(basis),calculation]);
      }
    }
    const cell=value=>value==null?'':'"'+String(value).replace(/"/g,'""')+'"';
    return '\ufeff'+records.map(record=>record.map(cell).join(',')).join('\r\n')+'\r\n';
  }

  function create(options) {
    const root=document.getElementById('profiles-panel');
    if(!root)throw Error('The Profiles panel is unavailable.');
    const entities=(options.meta?.entities||[]).slice().sort((a,b)=>a.name.localeCompare(b.name));
    const known=new Map(entities.map(entity=>[entity.id,entity]));
    const state={atlas:null,ids:DEFAULTS.filter(id=>known.has(id)),selected:null,basis:'share',layout:'stacked',region:'all',income:'all',blob:null,focus:null};
    if(!state.ids.length)state.ids=entities.slice(0,6).map(entity=>entity.id);
    root.classList.add('profiles-workspace');
    root.innerHTML=`<aside class="prof-controls" aria-label="Emissions profile controls">
      <label>Measurement<select id="prof-basis"><option value="share">Share of emissions (%)</option><option value="total">Total tonnes/year</option><option value="per_capita">Per person</option></select></label>
      <label>Chart<select id="prof-layout"><option value="stacked">Stacked sources</option><option value="grouped">Separate source bars</option></select></label>
      <div class="prof-country-control"><label for="prof-country">Country / territory</label><div class="prof-country-row"><select id="prof-country"></select><button id="prof-add" type="button">Add</button></div><span id="prof-choice-count" class="prof-choice-count"></span></div>
      <div id="prof-countries" class="prof-country-chips" aria-label="Countries shown"></div>
      <details class="prof-peers"><summary>Peer choices</summary><div class="prof-peer-controls"><label>Region<select id="prof-region"><option value="all">All regions</option></select></label><label>Income category<select id="prof-income"><option value="all">All categories</option></select></label><button id="prof-use-peers" type="button">Use six largest emitters</button><button id="prof-reset-filters" type="button">All countries</button></div></details>
      <div class="prof-actions"><button id="prof-data" type="button">Data table</button><a id="prof-csv" href="#">CSV</a></div>
    </aside><div class="prof-display"><div class="prof-heading"><h2>Five-source profiles</h2><span id="prof-context">Mean · 2020</span></div><div id="prof-status" role="status" aria-live="polite">Loading all country estimates…</div><div id="prof-legend" class="prof-legend"></div><div id="prof-plot" class="prof-plot" aria-busy="true"><div id="prof-tooltip" class="prof-tooltip" role="tooltip" hidden></div></div><div id="prof-selection" class="prof-selection" aria-live="polite"></div></div>
    <dialog id="prof-dialog" class="prof-dialog" aria-labelledby="prof-data-title"><div class="prof-dialog-header"><h2 id="prof-data-title">Five-source data · 2020</h2><button id="prof-close" type="button">Close</button></div><p id="prof-data-explanation"></p><div class="table-scroll"><table><caption id="prof-caption"></caption><thead><tr><th scope="col">Country / territory</th><th scope="col">Code</th><th scope="col">Source</th><th scope="col">Native Mean (t/year)</th><th scope="col">Native total Mean (t/year)</th><th scope="col">Population</th><th scope="col">Native total Mean (kg/person/year)</th><th scope="col" id="prof-display-heading">Display value</th></tr></thead><tbody id="prof-table-body"></tbody></table></div><p class="prof-source">Cottom, Cook &amp; Velis (2026), <a href="https://doi.org/10.5281/zenodo.22231994">SPOT V1.4.1-G-0426</a>. Modelled 2020 estimates.</p></dialog>`;
    const $=id=>root.querySelector('#'+id),plot=$('prof-plot'),tip=$('prof-tooltip');
    let marks=null,lastFocus=null;
    const rows=()=>state.atlas?state.ids.map(id=>state.atlas.rows.find(row=>row.id===id)).filter(Boolean):[];
    const choices=()=>entities.filter(entity=>(state.region==='all'||entity.region===state.region)&&(state.income==='all'||entity.income===state.income));
    const hideTip=()=>{tip.hidden=true;};
    function updateAdd() {
      const duplicate=state.ids.includes($('prof-country').value);
      $('prof-add').disabled=!$('prof-country').value||duplicate;
      $('prof-add').textContent=duplicate?'Shown':state.ids.length>=6?'Replace last':'Add';
      $('prof-use-peers').disabled=!choices().length||!state.atlas;
      $('prof-choice-count').textContent=choices().length+' of '+entities.length+' choices · '+state.ids.length+' shown';
    }
    function fillChoices() {
      const previous=$('prof-country').value||state.selected;
      $('prof-country').replaceChildren();
      choices().forEach(entity=>{const option=document.createElement('option');option.value=entity.id;option.textContent=entity.name+' ('+entity.id+')';$('prof-country').append(option);});
      if(choices().some(entity=>entity.id===previous))$('prof-country').value=previous;
      $('prof-country').disabled=!choices().length;updateAdd();
    }
    function renderChips() {
      $('prof-countries').replaceChildren();
      state.ids.forEach(id=>{
        const entity=known.get(id),chip=document.createElement('div');chip.className='prof-chip';
        const button=document.createElement('button');button.type='button';button.textContent=entity.name;button.className='prof-chip-name';button.setAttribute('aria-pressed',String(id===state.selected));button.addEventListener('click',()=>choose(id));
        const remove=document.createElement('button');remove.type='button';remove.textContent='×';remove.className='prof-chip-remove';remove.setAttribute('aria-label','Remove '+entity.name+' from profiles');remove.disabled=state.ids.length===1;remove.addEventListener('click',()=>{state.ids=state.ids.filter(value=>value!==id);renderChips();draw();});
        chip.append(button,remove);$('prof-countries').append(chip);
      });updateAdd();
    }
    function choose(id) {state.selected=id;state.focus=id;updateSelection();renderChips();hideTip();if(typeof options.onSelect==='function')options.onSelect(id);}
    function summary(profile) {return profile.name+' ('+profile.id+'), '+profile.segments.map(segment=>segment.name+' '+fmt(segment.value)).join('; ')+', '+unit(state.basis)+'. Native total '+fmt(state.basis==='per_capita'?profile.nativePerPerson:profile.totalMean)+(state.basis==='per_capita'?' kg/person/year':' tonnes/year')+'.';}
    function updateSelection() {
      const row=state.atlas?.rows.find(item=>item.id===state.selected);
      $('prof-selection').textContent=row?row.name+' ('+row.id+')'+(state.ids.includes(row.id)?'':' · Not in current comparison'):'Select a country to inspect its profile';
      if(marks) {
        const focus=state.ids.includes(state.focus)?state.focus:state.ids.includes(state.selected)?state.selected:state.ids[0];
        marks.classed('prof-row-selected',profile=>profile.id===state.selected).attr('aria-pressed',profile=>String(profile.id===state.selected)).attr('tabindex',profile=>profile.id===focus?0:-1);
      }
    }
    function inspect(event,profile,segment) {
      const values=segment?[segment]:profile.segments;
      tip.innerHTML='<strong>'+esc(profile.name)+' ('+esc(profile.id)+')</strong>'+values.map(item=>'<p><i style="background:'+item.colour+'"></i>'+esc(item.name)+': <b>'+esc(fmt(item.value))+'</b> '+esc(unit(state.basis))+'</p>').join('')+(state.basis==='total'?'':'<p class="prof-tooltip-source">Derived from native source means'+(state.basis==='per_capita'?' and supplied population':' and native total mean')+'.</p>');
      tip.hidden=false;
      const box=plot.getBoundingClientRect(),anchor=event.currentTarget?.getBoundingClientRect(),pointer=event.type?.startsWith('pointer');
      const x=pointer?event.clientX-box.left:anchor?anchor.left-box.left+anchor.width/2:12,y=pointer?event.clientY-box.top:anchor?anchor.top-box.top:12;
      tip.style.left=Math.max(5,Math.min(x+12,box.width-tip.offsetWidth-5))+'px';tip.style.top=Math.max(5,Math.min(y+12,box.height-tip.offsetHeight-5))+'px';
    }
    function keyboard(event,profile) {
      if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(profile.id);return;}
      const index=state.ids.indexOf(profile.id);let id;
      if(event.key==='ArrowRight'||event.key==='ArrowDown')id=state.ids[(index+1)%state.ids.length];
      if(event.key==='ArrowLeft'||event.key==='ArrowUp')id=state.ids[(index-1+state.ids.length)%state.ids.length];
      if(event.key==='Home')id=state.ids[0];if(event.key==='End')id=state.ids.at(-1);
      if(id){event.preventDefault();state.focus=id;updateSelection();marks.filter(item=>item.id===id).node()?.focus();}
    }
    function updateData(selected) {
      const explanation=state.basis==='share'?'Shares are each origin’s Mean mass divided by the native total Mean mass. They are ratios of means, not mean percentages and not emissions divided by generation.':state.basis==='per_capita'?'Origin per-person values are derived as native Mean tonnes/year × 1000 ÷ supplied population. The released total per-person Mean is retained separately.':'Origin masses and total masses are the native released Mean values.';
      $('prof-data-explanation').textContent=explanation+' Missing remains unavailable; known zero remains zero.';
      $('prof-caption').textContent=selected.length+' selected countries / territories; five origins each. Mean estimates for 2020.';
      $('prof-display-heading').textContent='Display ('+unit(state.basis)+')';
      $('prof-table-body').innerHTML=selected.flatMap(row=>{
        const profile=profileValues(row,state.basis);
        return profile.segments.map(segment=>'<tr><th scope="row"><button type="button" data-prof-country="'+esc(row.id)+'">'+esc(row.name)+'</button></th><td>'+esc(row.id)+'</td><td>'+esc(segment.name)+'</td><td class="number">'+esc(fmt(segment.nativeMean))+'</td><td class="number">'+esc(fmt(profile.totalMean))+'</td><td class="number">'+esc(fmt(row.population))+'</td><td class="number">'+esc(fmt(profile.nativePerPerson))+'</td><td class="number">'+esc(fmt(segment.value))+'</td></tr>');
      }).join('');
      $('prof-table-body').querySelectorAll('[data-prof-country]').forEach(button=>button.addEventListener('click',()=>{choose(button.dataset.profCountry);$('prof-dialog').close();}));
      if(state.blob)URL.revokeObjectURL(state.blob);
      state.blob=URL.createObjectURL(new Blob([profilesCSV(selected,state.basis,state.atlas.release)],{type:'text/csv;charset=utf-8'}));
      $('prof-csv').href=state.blob;$('prof-csv').download='SPOT_2020_five_sources_'+state.basis+'_selected_countries.csv';
      $('prof-csv').title='The '+selected.length+' countries currently shown; source means and display calculations';
    }
    function draw() {
      if(!state.atlas)return;
      const selected=rows(),profiles=selected.map(row=>profileValues(row,state.basis));
      hideTip();updateData(selected);updateSelection();
      $('prof-context').textContent='Mean · 2020 · '+unit(state.basis);
      $('prof-legend').innerHTML=ORIGINS.map(origin=>'<span><i style="background:'+origin.colour+'"></i>'+esc(origin.name)+'</span>').join('');
      const incomplete=profiles.filter(profile=>!profile.complete).length,mismatch=profiles.some(profile=>profile.reconciles===false);
      $('prof-status').textContent=incomplete?incomplete+' profiles have unavailable source components or denominators.':mismatch?'Source components and the native total differ; inspect Data.':'';
      plot.setAttribute('aria-busy','false');
      const box=plot.getBoundingClientRect();if(box.width<100||box.height<100)return;
      plot.querySelector('svg')?.remove();
      const width=box.width,height=box.height,compact=width<600,left=compact?8:155,right=compact?12:100,top=18,bottom=46,space=Math.max(1,width-left-right),rowHeight=Math.max(1,(height-top-bottom)/Math.max(1,profiles.length));
      const values=profiles.filter(profile=>profile.complete).flatMap(profile=>state.layout==='stacked'?[profile.sum]:profile.segments.map(segment=>segment.value));
      const maximum=state.basis==='share'?100:d3.max(values)||1,x=d3.scaleLinear().domain([0,maximum*(state.basis==='share'?1:1.06)]).range([left,left+space]);
      const svg=d3.select(plot).insert('svg',':first-child').attr('viewBox','0 0 '+width+' '+height).attr('role','group').attr('aria-label','Five-source emissions profiles, Mean, modelled 2020, '+unit(state.basis)).attr('data-basis',state.basis).attr('data-layout',state.layout).attr('data-country-count',profiles.length);
      svg.append('g').attr('class','prof-axis').attr('transform','translate(0,'+(height-bottom+8)+')').call(d3.axisBottom(x).ticks(Math.max(3,Math.floor(space/100))).tickFormat(short));
      svg.append('text').attr('class','prof-axis-title').attr('x',left+space/2).attr('y',height-8).attr('text-anchor','middle').text(unit(state.basis));
      marks=svg.append('g').selectAll('g').data(profiles).join('g').attr('class','prof-country-row-mark').attr('data-country',profile=>profile.id).attr('role','button').attr('aria-label',summary).on('click',(event,profile)=>choose(profile.id)).on('keydown',keyboard).on('focus',(event,profile)=>inspect(event,profile)).on('blur',hideTip);
      marks.each(function(profile,index){
        const group=d3.select(this),y=top+index*rowHeight,labelY=y+(compact?11:rowHeight/2+4),barStart=compact?y+19:y+Math.max(5,rowHeight*.2),available=Math.max(2,rowHeight-(compact?27:12));
        group.append('rect').attr('class','prof-selection-band').attr('x',0).attr('y',y-1).attr('width',width).attr('height',Math.max(1,rowHeight-3)).attr('rx',4);
        const limit=compact?Math.max(10,Math.floor((space-110)/6)):23,name=profile.name.length>limit?profile.name.slice(0,limit-1)+'…':profile.name;
        group.append('text').attr('class','prof-country-name').attr('x',compact?left:4).attr('y',labelY).text(compact?profile.id+' · '+name:name).append('title').text(profile.name+' ('+profile.id+')');
        if(!compact)group.append('text').attr('class','prof-country-code').attr('x',4).attr('y',labelY+15).text(profile.id);
        const totalLabel=state.basis==='share'?(finite(profile.totalMean)?short(profile.totalMean)+' t/year':'Unavailable'):short(profile.total);
        group.append('text').attr('class','prof-total').attr('x',compact?left+space:left+space+10).attr('y',compact?labelY:labelY).attr('text-anchor',compact?'end':'start').text(totalLabel);
        if(!profile.complete){group.append('text').attr('class','prof-unavailable').attr('x',left).attr('y',barStart+Math.min(available,14)).text('Unavailable source component');return;}
        let cumulative=0;
        profile.segments.forEach((segment,originIndex)=>{
          let valueStart=0,valueEnd=segment.value,barY=barStart,barHeight=Math.max(2,Math.min(27,available));
          if(state.layout==='stacked'){valueStart=cumulative;valueEnd=cumulative+segment.value;cumulative=valueEnd;}
          else{const slot=available/ORIGINS.length;barY=barStart+originIndex*slot;barHeight=Math.max(.5,slot*.72);}
          group.append('rect').attr('class','prof-segment').attr('x',x(valueStart)).attr('y',barY).attr('width',Math.max(0,x(valueEnd)-x(valueStart))).attr('height',barHeight).attr('fill',segment.colour).attr('data-source',segment.id).attr('data-value',segment.value).on('pointerenter',event=>inspect(event,profile,segment)).on('pointermove',event=>inspect(event,profile,segment)).on('pointerleave',hideTip);
        });
        if(profile.sum===0)group.append('line').attr('x1',left).attr('x2',left).attr('y1',barStart).attr('y2',barStart+Math.max(2,Math.min(27,available))).attr('stroke','#526c69').attr('stroke-width',1.5);
      });updateSelection();
    }
    $('prof-basis').addEventListener('change',()=>{state.basis=$('prof-basis').value;draw();});
    $('prof-layout').addEventListener('change',()=>{state.layout=$('prof-layout').value;draw();});
    $('prof-country').addEventListener('change',updateAdd);
    $('prof-add').addEventListener('click',()=>{const id=$('prof-country').value;if(!known.has(id)||state.ids.includes(id))return;if(state.ids.length>=6)state.ids=state.ids.slice(0,5);state.ids.push(id);renderChips();draw();});
    ['prof-region','prof-income'].forEach(id=>$(id).addEventListener('change',()=>{state.region=$('prof-region').value;state.income=$('prof-income').value;fillChoices();}));
    $('prof-reset-filters').addEventListener('click',()=>{state.region='all';state.income='all';$('prof-region').value='all';$('prof-income').value='all';fillChoices();});
    $('prof-use-peers').addEventListener('click',()=>{if(!state.atlas)return;const allowed=new Set(choices().map(entity=>entity.id));state.ids=state.atlas.rows.filter(row=>allowed.has(row.id)).sort((a,b)=>(meanValue(b,'plas_em')??-Infinity)-(meanValue(a,'plas_em')??-Infinity)).slice(0,6).map(row=>row.id);renderChips();draw();});
    $('prof-data').addEventListener('click',()=>{lastFocus=document.activeElement;$('prof-dialog').showModal();});$('prof-close').addEventListener('click',()=>$('prof-dialog').close());
    $('prof-dialog').addEventListener('close',()=>lastFocus?.focus());
    $('prof-dialog').addEventListener('click',event=>{if(event.target===$('prof-dialog')){const box=event.target.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)event.target.close();}});
    const addOptions=(id,values,name)=>values.forEach(value=>{const option=document.createElement('option');option.value=value;option.textContent=name(value);$(id).append(option);});
    addOptions('prof-region',[...new Set(entities.map(entity=>entity.region))].filter(value=>value!=null).sort(),value=>value);
    addOptions('prof-income',[...new Set(entities.map(entity=>entity.income))].filter(value=>value!=null).sort((a,b)=>['LIC','LMC','UMC','HIC'].indexOf(a)-['LIC','LMC','UMC','HIC'].indexOf(b)),value=>incomeNames[value]||value);
    fillChoices();renderChips();
    fetch('/api/atlas?statistic=Mean',{headers:{Accept:'application/json'}}).then(response=>{if(!response.ok)throw Error('Source profiles could not be loaded.');return response.json();}).then(atlas=>{state.atlas=atlas;state.ids=state.ids.filter(id=>atlas.rows.some(row=>row.id===id));renderChips();draw();}).catch(error=>{$('prof-status').textContent=error.message;plot.setAttribute('aria-busy','false');});
    let timer;const resize=()=>{clearTimeout(timer);timer=setTimeout(draw,80);};window.addEventListener('resize',resize);
    if(window.ResizeObserver){const observer=new ResizeObserver(resize);observer.observe(plot);}
    return {resize:draw,select(id){if(!known.has(id))return;state.selected=id;state.focus=id;if(!state.ids.includes(id)){state.ids=[id,...state.ids].slice(0,6);renderChips();draw();}else updateSelection();}};
  }
  if(typeof window!=='undefined')window.SPOTProfiles={create};
  if(typeof module!=='undefined'&&module.exports)module.exports={ORIGINS,meanValue,profileValues,profilesCSV,unit};
})();
