'use strict';
(function () {
  const $ = id => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  const colours = {navy:'#1B3B39',teal:'#227c7b',orange:'#DF753F',sage:'#8ca99b',pale:'#d9e8df',line:'#e4e9e1',muted:'#65787a'};
  const state = {meta:null,profile:null,entity:'IND',compare:['IND','CHN','GBR','USA'],profileRevision:0,compareRevision:0,compareController:null,profileController:null};
  const titles = {plas_em:'Plastic emissions',plas_debris_em:'Plastic debris emissions',plas_burn_em:'Plastic openly burned',wg:'Municipal waste generation',pwg:'Plastic waste generation',open_burn_MSW:'Municipal waste openly burned',col_cov_pct_gen_exc_lit:'Collection service coverage',plas_em_pct_pwg:'Plastic emissions / plastic generated'};
  const perCapita = {plas_em:'plas_em_per_cap',plas_debris_em:'plas_debris_em_per_cap',plas_burn_em:'plas_burn_em_per_cap',wg:'wg_per_cap',pwg:'pwg_per_cap'};
  const sourceGroups = [
    {name:'Uncollected waste',debris:['P20a'],burn:['P21a']},
    {name:'Disposal',debris:['P19a'],burn:['P17a']},
    {name:'Collection',debris:['P6a'],burn:[]},
    {name:'Litter',debris:['P2a'],burn:[]},
    {name:'Recycling',debris:['P31aa','P31ab','P33aa','P33ab'],burn:['P30aa','P30ab','P32aa','P32ab']}
  ];
  const numeric = v => typeof v === 'number' && Number.isFinite(v);
  const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function fmt(v, digits) { return numeric(v) ? new Intl.NumberFormat('en-GB',{maximumFractionDigits:digits == null ? 1 : digits}).format(v) : 'Unavailable'; }
  function short(v) { if (!numeric(v)) return 'Unavailable'; if (v===0) return '0'; const a=Math.abs(v); if(a>=1e9)return fmt(v/1e9,2)+'bn'; if(a>=1e6)return fmt(v/1e6,2)+'m'; if(a>=1e3)return fmt(v/1e3,1)+'k'; return fmt(v,a<1?3:1); }
  function mass(v) { if(!numeric(v))return {value:'Unavailable',unit:'tonnes / year',scale:1}; if(Math.abs(v)>=1e6)return {value:fmt(v/1e6,2),unit:'million tonnes / year',scale:1e6}; if(Math.abs(v)>=1e3)return {value:fmt(v/1e3,1),unit:'thousand tonnes / year',scale:1e3}; return {value:fmt(v,1),unit:'tonnes / year',scale:1}; }
  function allEntities() { return state.meta ? (state.meta.entities || []).concat(state.meta.groups || []) : []; }
  function entityFor(id) { return allEntities().find(e=>e.id===id); }
  function entityLabel(e) { return e ? e.name+' ('+e.id+')' : ''; }
  function resolveEntity(text) { const value=text.trim().toLowerCase(); return allEntities().find(e=>e.id.toLowerCase()===value || e.name.toLowerCase()===value || entityLabel(e).toLowerCase()===value); }
  function metricFor(id,family) { return (state.meta.metrics || []).find(m=>m.id===id && (!family || m.family.toLowerCase()===family)); }
  function getStat(profile,family,id,stat) {
    const rec=profile && profile[family] && profile[family][id]; if(!rec)return null;
    if(numeric(rec[stat]))return rec[stat];
    const needle=stat.toLowerCase().replace(/[^a-z0-9]/g,'');
    const key=Object.keys(rec).find(k=>k.toLowerCase().replace(/[^a-z0-9]/g,'')===needle);
    return key && numeric(rec[key]) ? rec[key] : null;
  }
  function sumMean(ids) { if(!ids.length)return 0; const values=ids.map(id=>getStat(state.profile,'processes',id,'Mean')); return values.every(numeric)?values.reduce((a,b)=>a+b,0):null; }
  function node(tag,attrs,text) { const n=document.createElementNS(NS,tag); Object.entries(attrs||{}).forEach(([k,v])=>n.setAttribute(k,String(v))); if(text!=null)n.textContent=text; return n; }
  function svgRoot(width,height,title,description,id) {
    const svg=node('svg',{viewBox:'0 0 '+width+' '+height,role:'img','aria-labelledby':id+'-title '+id+'-desc'});
    svg.append(node('title',{id:id+'-title'},title),node('desc',{id:id+'-desc'},description)); return svg;
  }
  function text(svg,x,y,value,cls,extra) { const n=node('text',Object.assign({x,y,class:cls||''},extra||{}),value); svg.append(n); return n; }
  function emptyChart(id,message) { const p=document.createElement('p');p.className='chart-empty';p.textContent=message;$(id).replaceChildren(p);$(id).setAttribute('aria-busy','false'); }
  async function api(path,signal) { const r=await fetch(path,{headers:{Accept:'application/json'},signal});if(!r.ok){let message='Results could not be loaded. Please try again.';try{const body=await r.json();message=body.error?.message||(typeof body.error==='string'?body.error:message);}catch{}throw Error(message);}return r.json(); }
  function setStatus(id,message,error) {$(id).textContent=message;$(id).classList.toggle('error',Boolean(error));}
  function setRelease(release) {
    const version=release && (release.source_version||release.model_version||release.version);
    if(version)document.querySelectorAll('.release-version').forEach(n=>n.textContent=version);
  }
  function renderHeadlines() {
    const specs=[{id:'plas_em',label:'Plastic emissions'},{id:'plas_debris_em',label:'Plastic debris emissions'},{id:'plas_burn_em',label:'Plastic openly burned'},{id:'col_cov_pct_gen_exc_lit',label:'Collection service coverage',percent:true}];
    const wrap=$('headline-cards');wrap.replaceChildren();
    specs.forEach(s=>{
      const v=getStat(state.profile,'outputs',s.id,'Mean'), low=getStat(state.profile,'outputs',s.id,'5th percentile'), high=getStat(state.profile,'outputs',s.id,'95th percentile');
      const display=s.percent?{value:numeric(v)?fmt(v,1)+'%':'Unavailable',unit:'of generation excluding uncollected litter',scale:1}:mass(v);
      const card=document.createElement('article');card.className='headline-card';
      const p=document.createElement('p');p.textContent=s.label;const strong=document.createElement('strong');strong.textContent=display.value;
      const unit=document.createElement('span');unit.className='value-unit';unit.textContent=display.unit;
      const range=document.createElement('p');range.className='range';range.textContent=numeric(low)&&numeric(high)?'5th–95th: '+fmt(low/display.scale,s.percent?1:2)+'–'+fmt(high/display.scale,s.percent?1:2)+(s.percent?'%':''):'Uncertainty unavailable';
      card.append(p,strong,unit,range);wrap.append(card);
    });wrap.setAttribute('aria-busy','false');
  }
  function band(x0,y0,x1,y1,h) {const bend=(x1-x0)*.48;return 'M'+x0+','+y0+' C'+(x0+bend)+','+y0+' '+(x1-bend)+','+y1+' '+x1+','+y1+' L'+x1+','+(y1+h)+' C'+(x1-bend)+','+(y1+h)+' '+(x0+bend)+','+(y0+h)+' '+x0+','+(y0+h)+' Z';}
  function verticalBand(x0,y0,x1,y1,w) {const bend=(y1-y0)*.5;return 'M'+x0+','+y0+' C'+x0+','+(y0+bend)+' '+x1+','+(y1-bend)+' '+x1+','+y1+' L'+(x1+w)+','+y1+' C'+(x1+w)+','+(y1-bend)+' '+(x0+w)+','+(y0+bend)+' '+(x0+w)+','+y0+' Z';}
  function compactFlow(values) {
    const w=Math.max(270,$('flow-chart').clientWidth),rootW=100,scale=rootW/values.P1,rootX=(w-rootW)/2;
    const svg=svgRoot(w,445,'First collection stage: '+state.profile.entity.name+', 2020','Mean annual municipal waste masses. Generated waste splits into uncollected litter, other uncollected waste and collected waste, which splits into collection losses and delivered waste. The table provides all values.','flow');
    text(svg,w/2,24,'Municipal waste generated','flow-label',{'text-anchor':'middle'});text(svg,w/2,43,short(values.P1)+' t / year','flow-value',{'text-anchor':'middle'});svg.append(node('rect',{x:rootX,y:58,width:rootW,height:9,fill:colours.navy,rx:1}));
    const parts=[{id:'P2',label:['Uncollected','litter'],colour:colours.orange,centre:w/6},{id:'P4',label:['Uncollected','waste'],colour:colours.sage,centre:w/2},{id:'P5',label:['Collected','waste'],colour:colours.teal,centre:w*5/6}];let offset=rootX,collectedX=0;
    parts.forEach(p=>{const width=values[p.id]*scale,x=p.centre-width/2;svg.append(node('path',{d:verticalBand(offset,67,x,184,width),fill:p.colour,'fill-opacity':.25}));svg.append(node('rect',{x,y:184,width:Math.max(width,.35),height:8,fill:p.colour}));text(svg,p.centre,214,p.label[0],'flow-label',{'text-anchor':'middle'});text(svg,p.centre,230,p.label[1],'flow-label',{'text-anchor':'middle'});text(svg,p.centre,249,short(values[p.id])+' t/year','flow-value',{'text-anchor':'middle'});offset+=width;if(p.id==='P5')collectedX=x;});
    const lossW=values.P6*scale,deliverW=values.P7*scale;
    [{id:'P6',x:w*.56-lossW/2,width:lossW,label:['Collection','losses'],colour:colours.orange},{id:'P7',x:w*.84-deliverW/2,width:deliverW,label:['Collected &','delivered'],colour:colours.teal}].forEach((p,i)=>{const start=collectedX+(i?lossW:0);svg.append(node('path',{d:verticalBand(start,268,p.x,345,p.width),fill:p.colour,'fill-opacity':.22}));svg.append(node('rect',{x:p.x,y:345,width:Math.max(p.width,.35),height:8,fill:p.colour}));const centre=p.x+p.width/2;text(svg,centre,375,p.label[0],'flow-label',{'text-anchor':'middle'});text(svg,centre,391,p.label[1],'flow-label',{'text-anchor':'middle'});text(svg,centre,410,short(values[p.id])+' t/year','flow-value',{'text-anchor':'middle'});});
    text(svg,8,440,'Mean mass · 2020','svg-secondary');return svg;
  }
  function renderFlow() {
    const ids=['P1','P2','P4','P5','P6','P7'],values=Object.fromEntries(ids.map(id=>[id,getStat(state.profile,'processes',id,'Mean')]));
    if(!ids.every(id=>numeric(values[id]))||values.P1<=0){emptyChart('flow-chart','No complete collection-stage flow is available for this selection.');$('flow-table-body').replaceChildren();return;}
    const h=205,scale=h/values.P1,x0=65,x1=370,x2=705,rootY=77,top=28,gap=36;
    const parts=[{id:'P2',label:'Uncollected litter',colour:colours.orange},{id:'P4',label:'Uncollected waste',colour:colours.sage},{id:'P5',label:'Collected waste',colour:colours.teal}];
    const svg=svgRoot(930,380,'First collection stage: '+state.profile.entity.name+', 2020','Mean annual municipal waste masses. Generated waste splits into uncollected litter, other uncollected waste and collected waste. Collected waste splits into collection losses and delivered waste. Values are also provided in the collection stage table.','flow');
    text(svg,31,22,'GENERATED', 'flow-stage');text(svg,x1,14,'COLLECTION PATHWAYS','flow-stage');text(svg,x2,14,'DELIVERY','flow-stage');
    svg.append(node('rect',{x:x0,y:rootY,width:13,height:h,fill:colours.navy,rx:1}));
    text(svg,31,rootY-27,'Municipal waste','flow-label');text(svg,31,rootY-11,short(values.P1)+' t / year','flow-value');
    let start=rootY,target=top,collectedY=0;
    parts.forEach(p=>{
      const ph=values[p.id]*scale;
      const path=node('path',{d:band(x0+13,start,x1,target,ph),fill:p.colour,'fill-opacity':.24,class:'chart-bar'});path.append(node('title',{},p.label+': '+fmt(values[p.id],1)+' tonnes/year (mean, 2020)'));svg.append(path);
      svg.append(node('rect',{x:x1,y:target,width:12,height:Math.max(ph,.35),fill:p.colour}));
      const mid=target+ph/2;text(svg,x1+21,mid-4,p.label,'flow-label',{'paint-order':'stroke',stroke:'white','stroke-width':4});text(svg,x1+21,mid+12,short(values[p.id])+' t / year','flow-value',{'paint-order':'stroke',stroke:'white','stroke-width':3});
      if(p.id==='P5')collectedY=target;start+=ph;target+=ph+gap;
    });
    const lossH=values.P6*scale,deliveredH=values.P7*scale,deliveryY=collectedY+lossH+28;
    [{id:'P6',label:'Collection losses',y:collectedY,height:lossH,colour:colours.orange},{id:'P7',label:'Collected & delivered',y:deliveryY,height:deliveredH,colour:colours.teal}].forEach((p,i)=>{
      const sy=collectedY+(i===1?lossH:0);const path=node('path',{d:band(x1+12,sy,x2,p.y,p.height),fill:p.colour,'fill-opacity':.2,class:'chart-bar'});path.append(node('title',{},p.label+': '+fmt(values[p.id],1)+' tonnes/year (mean, 2020)'));svg.append(path);
      svg.append(node('rect',{x:x2,y:p.y,width:12,height:Math.max(p.height,.35),fill:p.colour}));
      const mid=p.y+p.height/2;text(svg,x2+21,mid-3,p.label,'flow-label');text(svg,x2+21,mid+13,short(values[p.id])+' t / year','flow-value');
    });
    text(svg,31,357,'Mean annual municipal waste · 2020 · band widths use a common mass scale','svg-secondary');
    $('flow-chart').replaceChildren(window.innerWidth<=760?compactFlow(values):svg);$('flow-chart').setAttribute('aria-busy','false');
    const collectionShare=values.P5/values.P1*100;
    $('flow-insight').textContent=fmt(collectionShare,1)+'% of the mean generated mass enters collection. This differs from service coverage, which excludes uncollected litter from its denominator.';
    const names={P1:'Municipal waste generated',P2:'Uncollected litter',P4:'Other uncollected waste',P5:'Collected waste',P6:'Collection system debris emissions',P7:'Collected and delivered waste'};
    $('flow-table-body').innerHTML=ids.map(id=>'<tr><th scope="row">'+esc(names[id])+'</th><td>'+esc(id)+'</td><td class="number">'+fmt(values[id],1)+'</td></tr>').join('');
  }
  function axis(svg,x,y,width,max,ticks) {
    const count=ticks||4;for(let i=0;i<=count;i++){const v=max*i/count,px=x+width*i/count;svg.append(node('line',{x1:px,x2:px,y1:30,y2:y,stroke:colours.line,'stroke-width':1,'stroke-dasharray':i?'3 5':'none'}));text(svg,px,y+21,short(v),'svg-axis',{'text-anchor':i===0?'start':i===count?'end':'middle'});}
  }
  function renderSources() {
    const rows=sourceGroups.map(s=>({name:s.name,debris:sumMean(s.debris),burn:sumMean(s.burn)}));
    if(!rows.every(r=>numeric(r.debris)&&numeric(r.burn))){emptyChart('source-chart','The complete source breakdown is unavailable for this selection.');$('source-table-body').replaceChildren();return;}
    const max=Math.max(...rows.map(r=>r.debris+r.burn));if(max<=0){emptyChart('source-chart','All five source mean emissions are zero for this selection.');}else{
      const compact=window.innerWidth<=760,w=compact?Math.max(260,$('source-chart').clientWidth-40):1100,h=compact?391:345,x=compact?0:204,plot=compact?w-55:765,bottom=compact?350:303;const svg=svgRoot(w,h,'Plastic emissions by source: '+state.profile.entity.name+', 2020','Stacked horizontal bars show mean plastic debris and openly burned plastic in tonnes per year for five sources. All values are in the source breakdown table.','sources');
      axis(svg,x,bottom,plot,max,4);
      rows.forEach((r,i)=>{const y=compact?39+i*66:44+i*53,debrisW=r.debris/max*plot,burnW=r.burn/max*plot;
        text(svg,0,compact?y-9:y+16,r.name,'svg-name');text(svg,compact?plot:0,compact?y-9:y+32,numeric(max)&&max>0?fmt((r.debris+r.burn)/rows.reduce((s,a)=>s+a.debris+a.burn,0)*100,1)+'% of mean emissions':'','svg-secondary',compact?{'text-anchor':'end'}:{});
        [[x,debrisW,colours.teal,r.debris,'Plastic debris'],[x+debrisW,burnW,colours.orange,r.burn,'Openly burned plastic']].forEach(p=>{const rect=node('rect',{x:p[0],y:y+3,width:Math.max(p[1],0),height:24,fill:p[2],class:'chart-bar',rx:1});rect.append(node('title',{},r.name+' · '+p[4]+': '+fmt(p[3],1)+' tonnes/year'));svg.append(rect);});
        text(svg,x+debrisW+burnW+12,y+19,short(r.debris+r.burn),'svg-value');
      });$('source-chart').replaceChildren(svg);$('source-chart').setAttribute('aria-busy','false');
    }
    $('source-table-body').innerHTML=rows.map(r=>'<tr><th scope="row">'+esc(r.name)+'</th><td class="number">'+fmt(r.debris,1)+'</td><td class="number">'+fmt(r.burn,1)+'</td><td class="number">'+fmt(r.debris+r.burn,1)+'</td></tr>').join('');
  }
  async function loadCountry(id,updateURL) {
    const entity=entityFor(id);if(!entity)return;state.profileController?.abort();const controller=new AbortController();state.profileController=controller;const revision=++state.profileRevision;
    setStatus('global-status','Loading '+entity.name+'…');$('headline-cards').setAttribute('aria-busy','true');['flow-chart','source-chart'].forEach(id=>$(id).setAttribute('aria-busy','true'));
    try{
      const profile=await api('/api/profile?entity='+encodeURIComponent(id),controller.signal);if(revision!==state.profileRevision)return;
      state.entity=id;state.profile=profile;profile.entity=profile.entity||entity;
      $('country-name').textContent=profile.entity.name||entity.name;$('country-code').textContent=id;$('country-code').hidden=false;$('country-search').value=entityLabel(entity);
      const pop=profile.entity.population??entity.population,region=profile.entity.region??entity.region;
      $('country-context').textContent=[region&&region!=='NA'?region:null,numeric(pop)?'Population '+fmt(pop,0):null,'Mean · 2020'].filter(Boolean).join(' · ');
      document.querySelectorAll('.entity-inline').forEach(n=>n.textContent=profile.entity.name||entity.name);
      document.querySelectorAll('.download-country').forEach(n=>n.textContent=profile.entity.name||entity.name);
      $('country-download').href='/api/download?entities='+encodeURIComponent(id)+'&family=all&metric=all&statistic=all';
      $('snapshot-download').href='/api/snapshot?entity='+encodeURIComponent(id);$('snapshot-download').download='SPOT_'+id+'_2020_snapshot.json';
      setRelease(profile.release);renderHeadlines();renderFlow();renderSources();setStatus('global-status','');document.body.classList.add('has-data');state.map?.select(id);state.relationships?.select(id);
      if(updateURL){const u=new URL(location.href);u.searchParams.set('entity',id);history.replaceState(null,'',u);}
      if(!state.compare.includes(id)){state.compare=[id].concat(state.compare).slice(0,6);renderChips();}
      loadComparison();
    }catch(e){if(e.name==='AbortError')return;setStatus('global-status',e.message,true);$('headline-cards').setAttribute('aria-busy','false');['flow-chart','source-chart'].forEach(id=>$(id).setAttribute('aria-busy','false'));}
  }
  function renderChips() {
    $('entity-chips').replaceChildren();
    state.compare.forEach(id=>{const e=entityFor(id);if(!e)return;const chip=document.createElement('span');chip.className='entity-chip';const label=document.createElement('span');label.textContent=e.name;const button=document.createElement('button');button.type='button';button.textContent='×';button.setAttribute('aria-label','Remove '+e.name+' from comparison');button.disabled=state.compare.length<=1;button.addEventListener('click',()=>{state.compare=state.compare.filter(code=>code!==id);renderChips();loadComparison();});chip.append(label,button);$('entity-chips').append(chip);});
    $('compare-search').disabled=state.compare.length>=6;document.querySelector('#add-entity-form button').disabled=state.compare.length>=6;
  }
  function updateBasis() {
    const key=$('compare-metric').value,isPercent=key==='col_cov_pct_gen_exc_lit'||key==='plas_em_pct_pwg';
    const total=$('compare-basis').options[0],per=$('compare-basis').options[1];
    total.textContent=isPercent?'Percentage':'Total annual mass';per.disabled=!perCapita[key];if(per.disabled)$('compare-basis').value='total';$('compare-basis').disabled=isPercent;
  }
  function compareSelection() {
    const base=$('compare-metric').value,basis=$('compare-basis').value,metric=basis==='per_capita'&&perCapita[base]?perCapita[base]:base;
    return {base,basis,metric,statistic:$('compare-statistic').value,entities:state.compare.slice()};
  }
  function humanUnit(metric) {
    const known={wg_per_cap:'kg / person / day',pwg_per_cap:'kg / person / day',plas_em_per_cap:'kg / person / year',plas_debris_em_per_cap:'kg / person / year',plas_burn_em_per_cap:'kg / person / year',col_cov_pct_gen_exc_lit:'% of generation excluding uncollected litter',plas_em_pct_pwg:'% of plastic waste generated'};
    const m=metricFor(metric,'outputs');return known[metric]||(m&&(m.display_unit||m.unit))||'tonnes / year';
  }
  async function loadComparison() {
    if(!state.meta||!state.compare.length)return;state.compareController?.abort();const controller=new AbortController();state.compareController=controller;const revision=++state.compareRevision,selection=compareSelection();
    $('comparison-chart').setAttribute('aria-busy','true');setStatus('compare-status','Loading comparison…');
    const params=new URLSearchParams({entities:selection.entities.join(','),metric:selection.metric,family:'outputs',statistic:selection.statistic});
    try{
      const payload=await api('/api/compare?'+params,controller.signal);if(revision!==state.compareRevision)return;
      const metric=payload.metric&&typeof payload.metric==='object'?payload.metric:metricFor(selection.metric,'outputs');
      const unit=humanUnit(selection.metric),title=titles[selection.base]||metric?.name||selection.metric;
      $('compare-chart-title').textContent=title;$('compare-chart-unit').textContent=unit+' · 2020';$('interval-key-text').textContent=selection.statistic+' and 5th–95th percentile range';$('central-column').textContent=selection.statistic;
      $('comparison-table-caption').textContent=title+', '+unit+', modelled 2020. Central value is '+selection.statistic+'.';
      const rows=payload.rows||[];renderComparison(rows,selection,title,unit);
      const dl=new URLSearchParams({entities:selection.entities.join(','),family:'outputs',metric:selection.metric,statistic:'all'});$('compare-download').href='/api/download?'+dl;$('compare-download').title='All six source statistics for the selected countries and metric';
      setStatus('compare-status','');
    }catch(e){if(revision!==state.compareRevision||e.name==='AbortError')return;setStatus('compare-status',e.message,true);$('comparison-chart').setAttribute('aria-busy','false');}
  }
  function renderComparison(rows,selection,title,unit) {
    state.lastComparison={rows,selection,title,unit};
    if(!rows.length){emptyChart('comparison-chart','No results match this selection.');$('comparison-table-body').replaceChildren();return;}
    const usable=rows.filter(r=>numeric(r.value)||numeric(r.high)||numeric(r.low)),max=usable.length?Math.max(...usable.flatMap(r=>[r.value,r.low,r.median,r.high].filter(numeric)),0):0;
    if(!usable.length){emptyChart('comparison-chart','These results are unavailable for the selected metric.');}else{
      const compact=window.innerWidth<=760,w=compact?Math.max(260,$('comparison-chart').clientWidth):1100,rowH=compact?73:62,height=rows.length*rowH+65,x=compact?0:205,plot=compact?w-60:750,bottom=rows.length*rowH+24,domain=max>0?max*1.08:1;
      const svg=svgRoot(w,height,title+', national comparison, 2020',selection.statistic+' shown by a dot, with a line from the 5th to 95th percentile. Values are '+unit+'. The accessible table below contains every displayed value.','comparison');
      axis(svg,x,bottom,plot,domain,4);
      rows.forEach((r,i)=>{
        const y=(compact?62:52)+i*rowH,isActive=r.id===state.entity,colour=isActive?colours.orange:colours.teal;
        if(isActive)svg.append(node('rect',{x:0,y:y-25,width:w,height:48,fill:'#f8f3ec',rx:2}));
        text(svg,0,compact?y-18:y-2,r.name||entityFor(r.id)?.name||r.id,'svg-name');text(svg,compact?w:0,compact?y-18:y+14,r.id+(isActive?' · selected profile':''),'svg-secondary',compact?{'text-anchor':'end'}:{});
        const X=v=>x+v/domain*plot;
        if(numeric(r.low)&&numeric(r.high)){svg.append(node('line',{x1:X(r.low),x2:X(r.high),y1:y,y2:y,stroke:colour,'stroke-width':3,'stroke-opacity':.45,'stroke-linecap':'round'}));[r.low,r.high].forEach(v=>svg.append(node('line',{x1:X(v),x2:X(v),y1:y-5,y2:y+5,stroke:colour,'stroke-width':1.2})));}
        if(numeric(r.value)){const point=node('circle',{cx:X(r.value),cy:y,r:5,fill:colour,stroke:'white','stroke-width':1.5});point.append(node('title',{},(r.name||r.id)+': '+selection.statistic+' '+fmt(r.value,2)+' '+unit+'; 5th–95th '+fmt(r.low,2)+'–'+fmt(r.high,2)));svg.append(point);text(svg,x+plot+20,y+4,short(r.value),'svg-value');}
        else text(svg,x+12,y+4,'Unavailable','svg-secondary');
      });$('comparison-chart').replaceChildren(svg);$('comparison-chart').setAttribute('aria-busy','false');
    }
    const number=v=>numeric(v)?fmt(v,Math.abs(v)<1?3:2):'Unavailable';
    $('comparison-table-body').innerHTML=rows.map(r=>'<tr><th scope="row" class="table-country">'+esc(r.name||entityFor(r.id)?.name||r.id)+'</th><td>'+esc(r.id)+'</td><td class="number">'+number(r.value)+'</td><td class="number">'+number(r.low)+'</td><td class="number">'+number(r.median)+'</td><td class="number">'+number(r.high)+'</td></tr>').join('');
  }
  function setupMethods() {
    const dialog=$('methods-dialog');let previous=null;
    document.querySelectorAll('[data-open-methods]').forEach(button=>button.addEventListener('click',()=>{previous=document.activeElement;dialog.showModal();document.body.style.overflow='hidden';}));
    const close=()=>dialog.close();$('close-methods').addEventListener('click',close);$('methods-done').addEventListener('click',close);
    dialog.addEventListener('close',()=>{document.body.style.overflow='';previous?.focus();});
    dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}});
  }
  function refreshVisibleView() {
    requestAnimationFrame(()=>{
      if(state.activeTab==='maps')state.map?.resize?.();
      if(state.activeTab==='relationships')state.relationships?.resize?.();
      if(state.activeTab==='country'&&state.profile){renderFlow();renderSources();}
      if(state.activeTab==='compare'&&state.lastComparison){const c=state.lastComparison;renderComparison(c.rows,c.selection,c.title,c.unit);}
      document.dispatchEvent(new CustomEvent('data-app-tabchange',{detail:{tab:state.activeTab}}));
    });
  }
  function showTab(name,focus) {
    const allowed=['maps','relationships','country','compare','data'];if(!allowed.includes(name))return;
    state.activeTab=name;
    document.querySelectorAll('[data-app-tab]').forEach(button=>{const active=button.dataset.appTab===name;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;if(active&&focus)button.focus();});
    allowed.forEach(tab=>{$('tab-'+tab).hidden=tab!==name;});
    const url=new URL(location.href);url.hash=name;history.replaceState(null,'',url);refreshVisibleView();
  }
  function showCountryView(name,focus) {
    if(!['flow','sources'].includes(name))return;
    document.querySelectorAll('[data-country-view]').forEach(button=>{const active=button.dataset.countryView===name;button.setAttribute('aria-selected',String(active));button.tabIndex=active?0:-1;if(active&&focus)button.focus();});
    $('country-view-flow').hidden=name!=='flow';$('country-view-sources').hidden=name!=='sources';refreshVisibleView();
  }
  function setupNavigation() {
    document.querySelectorAll('[data-app-tab]').forEach(button=>button.addEventListener('click',()=>showTab(button.dataset.appTab)));
    document.querySelectorAll('[data-country-view]').forEach(button=>button.addEventListener('click',()=>showCountryView(button.dataset.countryView)));
    function keyboardTabs(event,selector,key,show){const buttons=Array.from(document.querySelectorAll(selector)),index=buttons.indexOf(event.target);if(index<0)return;let target;if(event.key==='ArrowRight')target=(index+1)%buttons.length;if(event.key==='ArrowLeft')target=(index-1+buttons.length)%buttons.length;if(event.key==='Home')target=0;if(event.key==='End')target=buttons.length-1;if(target!==undefined){event.preventDefault();show(buttons[target].dataset[key],true);}}
    $('app-tabs').addEventListener('keydown',event=>keyboardTabs(event,'[data-app-tab]','appTab',showTab));
    document.querySelector('.country-tabs').addEventListener('keydown',event=>keyboardTabs(event,'[data-country-view]','countryView',showCountryView));
    const aliases={'world-map':'maps',downloads:'data'};const requested=location.hash.slice(1),target=aliases[requested]||requested;showTab(['maps','relationships','country','compare','data'].includes(target)?target:'maps');
  }
  window.SPOTApp={showTab,selectEntity:id=>loadCountry(id,true)};
  async function init() {
    let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>{if(state.profile){renderFlow();renderSources();}if(state.lastComparison){const c=state.lastComparison;renderComparison(c.rows,c.selection,c.title,c.unit);}},180);});
    setupNavigation();setupMethods();$('country-form').addEventListener('submit',event=>{event.preventDefault();const found=resolveEntity($('country-search').value);if(found)loadCountry(found.id,true);else setStatus('global-status','Choose a recognised country name or source code from the list.',true);});
    $('compare-form').addEventListener('submit',event=>{event.preventDefault();loadComparison();});
    $('compare-metric').addEventListener('change',()=>{updateBasis();loadComparison();});
    ['compare-basis','compare-statistic'].forEach(id=>$(id).addEventListener('change',loadComparison));
    $('add-entity-form').addEventListener('submit',event=>{event.preventDefault();const found=resolveEntity($('compare-search').value);if(!found){setStatus('compare-status','Choose a recognised country name or source code.',true);return;}if(state.compare.includes(found.id)){setStatus('compare-status',found.name+' is already in the comparison.');return;}if(state.compare.length>=6)return;state.compare.push(found.id);$('compare-search').value='';renderChips();loadComparison();});
    $('flow-table-link').addEventListener('click',event=>{event.preventDefault();$('flow-table').open=true;});
    try{
      state.meta=await api('/api/meta');setRelease(state.meta.release);$('entity-count').textContent=fmt((state.meta.entities||[]).length,0);
      const fragment=document.createDocumentFragment();allEntities().forEach(e=>{const o=document.createElement('option');o.value=entityLabel(e);fragment.append(o);});$('country-options').append(fragment);
      state.compare=state.compare.filter(id=>entityFor(id));if(!state.compare.length)state.compare=(state.meta.entities||[]).slice(0,3).map(e=>e.id);
      const fromURL=new URLSearchParams(location.search).get('entity');state.entity=entityFor(fromURL)?fromURL:entityFor('IND')?'IND':state.meta.entities[0]?.id;
      renderChips();updateBasis();if(window.SPOTMap&&window.d3){state.map=window.SPOTMap.create({entities:state.meta.entities,onSelect:id=>loadCountry(id,true)});state.map.select(state.entity);}if(window.SPOTRelationships&&window.d3){state.relationships=window.SPOTRelationships.create({meta:state.meta,onSelect:id=>loadCountry(id,true)});state.relationships.select(state.entity);}if(state.entity)await loadCountry(state.entity,false);else setStatus('global-status','No reporting entities were included in this data release.',true);refreshVisibleView();
    }catch(e){setStatus('global-status',e.message,true);['headline-cards','flow-chart','source-chart','comparison-chart'].forEach(id=>$(id).setAttribute('aria-busy','false'));}
  }
  init();
})();

