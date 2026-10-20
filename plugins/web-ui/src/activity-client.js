import { activityLog } from './activity.js'
import { activityText as T } from './activity-text.js'
const element=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node}

export function initActivity({host,avatar,choose}) {
 const root=element('section',undefined,'activity-log')
 const heading=element('header',undefined,'activity-log-heading')
 heading.append(element('h2',T.title),element('p',T.description))
 const controls=element('div',undefined,'activity-log-controls')
 const agents=element('select');agents.setAttribute('aria-label',T.agent)
 const search=element('input');search.type='search';search.placeholder=T.search;search.setAttribute('aria-label',T.search)
 const filters=element('div',undefined,'activity-log-filters');filters.setAttribute('aria-label',T.eventType)
 const stats=element('div',undefined,'activity-log-stats')
 const count=element('span');count.setAttribute('aria-live','polite')
 const follow=element('span',T.live)
 const latest=element('button',T.latest,'subtle');latest.type='button'
 stats.append(count,follow,latest)
 const viewport=element('div',undefined,'activity-log-viewport');viewport.tabIndex=0;viewport.setAttribute('aria-label',T.title)
 const scope=element('p',T.scope,'activity-log-scope')
 controls.append(agents,search);root.append(heading,controls,filters,stats,viewport,scope)
 let state,filter='all',following=true,signature='',agentSignature='',session=''
 const selectFilter=(value)=>{filter=value;following=false;draw(true)}
 for(const [value,label] of Object.entries(T.filters)){
  const button=element('button',label);button.type='button';button.dataset.filter=value;button.onclick=()=>selectFilter(value);filters.append(button)
 }
 agents.onchange=()=>{following=false;draw(true)}
 search.oninput=()=>{following=false;draw(true)}
 viewport.onscroll=()=>{following=viewport.scrollHeight-viewport.clientHeight-viewport.scrollTop<28;follow.textContent=following?T.live:T.paused}
 latest.onclick=()=>{following=true;viewport.scrollTop=viewport.scrollHeight;follow.textContent=T.live}
 function draw(reset=false){
  if(!state)return
  const currentSignature=JSON.stringify([state.lines,agents.value,search.value,filter])
  if(currentSignature===signature&&!reset)return
  signature=currentSignature
  const open=new Set([...viewport.querySelectorAll('details[open]')].map(node=>node.dataset.event))
  const focus=document.activeElement?.closest('.activity-log-row')?.dataset.event
  const scroll=viewport.scrollTop
  const result=activityLog(state.lines,{agent:agents.value,query:search.value,filter})
  count.textContent=T.result(result.entries.length,result.total)
  for(const button of filters.children)button.setAttribute('aria-pressed',String(button.dataset.filter===filter))
  const rows=[]
  if(result.omitted)rows.push(element('p',T.omitted(result.omitted),'activity-log-warning'))
  for(const entry of result.entries){
   const row=element('details',undefined,`activity-log-row ${entry.category}`);row.dataset.event=entry.id;row.open=open.has(entry.id)
   const summary=element('summary')
   summary.append(element('span',`#${entry.index+1}`,'activity-log-order'),element('span',entry.category==='handoffs'?T.handoff:T.kinds[entry.kind],'activity-log-kind'))
   const actor=element('span',undefined,'activity-log-actor')
   actor.append(avatar(entry.agentId),element('span',entry.from?`${entry.from} → ${entry.to}`:entry.agentId))
   summary.append(actor,element('span',entry.text.replace(/\s+/g,' '),'activity-log-preview'))
   const detail=element('div',undefined,'activity-log-detail');detail.append(element('pre',entry.text))
   for(const id of new Set([entry.from||entry.agentId,...(entry.to?[entry.to]:[])])){
    if(!state.agents.some(agent=>agent.id===id))continue
    const openAgent=element('button',T.open(id),'subtle');openAgent.type='button';openAgent.onclick=()=>choose(id);detail.append(openAgent)
   }
   row.append(summary,detail);rows.push(row)
  }
  if(!result.entries.length)rows.push(element('p',state.lines.length?T.noMatches:T.empty,'activity-log-empty'))
  viewport.replaceChildren(...rows)
  viewport.scrollTop=reset?0:following?viewport.scrollHeight:scroll
  if(focus)[...viewport.querySelectorAll('.activity-log-row')].find(node=>node.dataset.event===focus)?.querySelector('summary')?.focus({preventScroll:true})
  follow.textContent=following?T.live:T.paused
 }
 return {render(next,active){
  host.hidden=!active;if(!active)return
  state=next
  if(root.parentElement!==host)host.replaceChildren(root)
  if(session!==state.sessionId){session=state.sessionId;signature='';agentSignature='';agents.value='';search.value='';filter='all';following=true}
  const ids=[...new Set([...state.agents.map(agent=>agent.id),...state.lines.filter(line=>line.kind!=='thinking').map(line=>line.agentId)])].sort()
  const nextAgents=JSON.stringify(ids)
  if(nextAgents!==agentSignature){const value=agents.value;agentSignature=nextAgents;const all=element('option',T.allAgents);all.value='';agents.replaceChildren(all,...ids.map(id=>{const option=element('option',id);option.value=id;return option}));agents.value=ids.includes(value)?value:''}
  draw()
 }}
}
