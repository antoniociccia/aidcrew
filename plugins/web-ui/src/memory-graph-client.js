import { memoryGraph, memoryRelations } from './memory-graph.js'
import { memoryText as T } from './memory-text.js'

const el = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
const svg = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value))
  return node
}

export function initMemoryGraph({ toggle }) {
  const root = el('section', undefined, 'memory-universe')
  const heading = el('header', undefined, 'memory-heading')
  const intro = el('div')
  intro.append(el('span', '◈', 'memory-emblem'), el('h3', T.title), el('p', T.subtitle))
  const sharing = el('button', undefined, 'subtle')
  sharing.type = 'button'
  const status = el('p', undefined, 'memory-status')
  const search = el('input')
  search.type = 'search'
  search.placeholder = T.search
  search.setAttribute('aria-label', T.search)
  const stats = el('div', undefined, 'memory-stats')
  stats.setAttribute('aria-live', 'polite')
  const toolbar = el('div', undefined, 'memory-toolbar')
  toolbar.append(search)
  const legend=el('div',undefined,'memory-legend')
  const body = el('div', undefined, 'memory-body')
  const viewport = el('div', undefined, 'memory-viewport')
  viewport.tabIndex = 0
  viewport.setAttribute('aria-label', T.title)
  const canvas = el('div', undefined, 'memory-canvas')
  const inspector = el('aside', undefined, 'memory-inspector')
  inspector.setAttribute('aria-live', 'polite')
  const limit = el('p', undefined, 'memory-limit')
  heading.append(intro, sharing)
  viewport.append(canvas)
  body.append(viewport, inspector)
  root.append(heading, status, toolbar, stats, legend, limit, body, el('p', `${T.scope} ${T.navigation}`, 'memory-scope'))
  let memory = {}, enabled = true, selected = '', zoom = 1, fitted = true
  const zoomButton = (label, action) => {
    const button = el('button', label, 'subtle')
    button.type = 'button'
    button.onclick = action
    toolbar.append(button)
  }
  zoomButton(T.zoomOut, () => { fitted = false; zoom = Math.max(.35, zoom - .15); draw() })
  zoomButton(T.fit, () => { fitted = true; pan={x:0,y:0};viewport.scrollTo(0, 0);draw() })
  zoomButton(T.zoomIn, () => { fitted = false; zoom = Math.min(2, zoom + .15); draw() })
  let pan={x:0,y:0},drag
  const camera=()=>{canvas.style.translate=`${pan.x}px ${pan.y}px`}
  viewport.onpointerdown=(event)=>{
    if(event.button!==0||event.target.closest('button'))return
    drag={x:event.clientX,y:event.clientY,startX:pan.x,startY:pan.y}
    viewport.setPointerCapture(event.pointerId);viewport.classList.add('panning')
  }
  viewport.onpointermove=(event)=>{if(!drag)return;pan={x:drag.startX+event.clientX-drag.x,y:drag.startY+event.clientY-drag.y};camera()}
  const release=()=>{drag=undefined;viewport.classList.remove('panning')}
  viewport.onpointerup=release;viewport.onpointercancel=release
  viewport.addEventListener('wheel',(event)=>{
    if(!event.ctrlKey&&!event.metaKey)return
    event.preventDefault();fitted=false;zoom=Math.max(.35,Math.min(2.5,zoom*Math.exp(-event.deltaY*.002)));draw()
  },{passive:false})
  viewport.onkeydown=(event)=>{
    if(event.target!==viewport)return
    const movement={ArrowLeft:[30,0],ArrowRight:[-30,0],ArrowUp:[0,30],ArrowDown:[0,-30]}[event.key]
    if(!movement)return
    event.preventDefault();pan={x:pan.x+movement[0],y:pan.y+movement[1]};camera()
  }
  const labels=el('label',undefined,'memory-label-toggle'),checkbox=el('input')
  checkbox.type='checkbox';checkbox.onchange=()=>canvas.classList.toggle('show-labels',checkbox.checked)
  labels.append(checkbox,el('span',T.labels));toolbar.append(labels)
  sharing.onclick = () => toggle(!enabled)
  search.oninput = () => { selected = ''; draw() }
  let graphData, hoveredNode = '', hoveredEdge = ''
  function illuminate() {
    if (!graphData) return
    const focusId = hoveredNode || selected
    const edges = graphData.edges.filter(edge => hoveredEdge ? JSON.stringify([edge.from,edge.to]) === hoveredEdge : edge.from === focusId || edge.to === focusId)
    const litEdges = new Set(edges.map(edge=>JSON.stringify([edge.from,edge.to])))
    const litNodes = new Set(edges.flatMap(edge=>[edge.from,edge.to]))
    if (focusId && !hoveredEdge) litNodes.add(focusId)
    const active = Boolean(hoveredEdge || focusId)
    for (const path of canvas.querySelectorAll('.memory-synapse')) {
      const lit = litEdges.has(path.dataset.edge)
      path.classList.toggle('lit', lit)
      path.classList.toggle('dim', active && !lit)
    }
    for (const neuron of canvas.querySelectorAll('.memory-neuron')) neuron.classList.toggle('dim',active && !litNodes.has(neuron.dataset.memoryId))
    for (const relation of inspector.querySelectorAll('.memory-relation')) relation.classList.toggle('traced',relation.dataset.edge===hoveredEdge)
  }
  function trace(target, key, isEdge) {
    const activate=()=>{ if(isEdge){hoveredEdge=key;hoveredNode=''}else{hoveredNode=key;hoveredEdge=''} illuminate() }
    const clear=()=>{hoveredNode='';hoveredEdge='';illuminate()}
    target.onmouseenter=activate
    target.onmouseleave=()=>{if(document.activeElement!==target)clear()}
    target.onfocus=activate
    target.onblur=clear
  }
  function detail(node, data) {
    inspector.replaceChildren()
    if (!node) { inspector.append(el('div', '◌', 'memory-inspector-icon'), el('p', T.choose)); return }
    inspector.append(el('small', node.kind === 'summary' ? T.summary : T[node.kind]), el('h4', node.kind === 'note' ? T.note : node.text))
    if (node.task !== undefined) inspector.append(el('p', `${T.task}: ${node.task}`, 'memory-source'))
    if (node.author !== undefined) inspector.append(el('p', `${T.author}: ${node.author}`, 'memory-source'))
    if (node.kind === 'note') {
      const date = new Date(node.at)
      inspector.append(el('time', Number.isNaN(date.getTime()) ? T.unknownTime : date.toLocaleString()))
    }
    if (['note', 'summary'].includes(node.kind)) inspector.append(el('p', node.text, 'memory-full-text'))
    const relations = memoryRelations(data, node.id)
    inspector.append(el('p',T.relationHint,'memory-relation-hint'))
    for(const direction of ['incoming','outgoing']) {
      inspector.append(el('h5',T[direction],'memory-relation-heading'))
      if(!relations[direction].length) inspector.append(el('p',T.noRelations,'memory-relation-empty'))
      for(const edge of relations[direction]) {
        const label=`${edge.fromNode.text} → ${T[edge.relation]} → ${edge.toNode.text}`
        const button=el('button',undefined,'memory-relation')
        button.type='button'
        button.dataset.edge=edge.id
        button.setAttribute('aria-label',label)
        button.append(el('span',edge.fromNode.text,'memory-relation-endpoint'),el('small',`→ ${T[edge.relation]} →`),el('span',edge.toNode.text,'memory-relation-endpoint'))
        trace(button,edge.id,true)
        button.onclick=()=>{selected=direction==='incoming'?edge.from:edge.to;hoveredEdge='';hoveredNode='';draw();const counterpart=[...canvas.querySelectorAll('.memory-neuron')].find(button=>button.dataset.memoryId===selected);counterpart?.focus({preventScroll:true})}
        inspector.append(button)
      }
    }
  }

  function draw() {
    const data = memoryGraph(memory, search.value)
    graphData = data
    if(selected&&!data.nodes.some(node=>node.id===selected)) selected=''
    if (!data.edges.some(edge=>JSON.stringify([edge.from,edge.to])===hoveredEdge)) hoveredEdge=''
    if (!data.nodes.some(node=>node.id===hoveredNode)) hoveredNode=''
    const relationFocus=inspector.contains(document.activeElement)?document.activeElement.dataset.edge:undefined
    const inspectorScroll=inspector.scrollTop
    const focus = canvas.contains(document.activeElement) ? document.activeElement.dataset.memoryId : undefined
    const baseWidth = Math.max(640, viewport.clientWidth)
    const baseHeight = Math.max(480, viewport.clientHeight)
    if (fitted) zoom = Math.max(.15, Math.min(viewport.clientWidth / baseWidth, Math.max(280, viewport.clientHeight) / baseHeight))
    const width = fitted ? viewport.clientWidth : baseWidth * zoom
    const height = fitted ? Math.max(200, viewport.clientHeight) : baseHeight * zoom
    canvas.classList.toggle('fitted', fitted)
    canvas.style.setProperty('--fit', '1')
    canvas.style.width = `${width}px`
    canvas.style.height = `${height}px`
    camera()
    canvas.replaceChildren()
    stats.replaceChildren(el('b', T.count(data.shown, data.total)), el('span', T.sources(data.tasks, data.authors)))
    legend.replaceChildren(el('span',T.taskColors,'memory-legend-title'))
    for(const task of data.nodes.filter(node=>node.kind==='task')){const item=el('span',task.text,'memory-legend-item');item.style.setProperty('--task-color',task.color);legend.append(item)}
    legend.append(el('small',T.sourceLegend))
    limit.textContent = data.omitted ? T.limited(data.omitted) : ''
    limit.hidden = !data.omitted
    const current = data.nodes.find((node) => node.id === selected)
    const connected = new Set([selected])
    for (const edge of data.edges) if (edge.from === selected || edge.to === selected) { connected.add(edge.from); connected.add(edge.to) }
    const network = svg('svg', { viewBox: `0 0 ${width} ${height}`, class: 'memory-synapses', 'aria-hidden': 'true' })
    const defs=svg('defs',{})
    const marker=svg('marker',{id:'memory-arrow',viewBox:'0 0 10 10',refX:9,refY:5,markerWidth:5,markerHeight:5,orient:'auto'})
    marker.append(svg('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'context-stroke'}));defs.append(marker);network.append(defs)
    const span=Math.min(width,height)
    const nodeX = (node) => 50+(node.x-50)*span/width
    const nodeY = (node) => 50+(node.y-50)*span/height
    const positions = new Map(data.nodes.map((node) => [node.id, { x: nodeX(node) * width / 100, y: nodeY(node) * height / 100 }]))
    for (const edge of data.edges) {
      const from = positions.get(edge.from), to = positions.get(edge.to)
      const dx=to.x-from.x,dy=to.y-from.y,length=Math.hypot(dx,dy)||1
      const end={x:to.x-dx/length*10,y:to.y-dy/length*10}
      network.append(svg('path', { 'data-edge':JSON.stringify([edge.from,edge.to]), 'marker-end':'url(#memory-arrow)', d: `M ${from.x} ${from.y} L ${end.x} ${end.y}`, class: `memory-synapse${edge.from === selected || edge.to === selected ? ' lit' : ''}` }))
    }
    canvas.append(network)
    if (!data.nodes.length) canvas.append(el('p', search.value ? T.noMatches : T.empty, 'memory-empty'))
    for (const node of data.nodes) {
      const button = el('button', undefined, `memory-neuron ${node.kind}${selected === node.id ? ' selected' : ''}${current && !connected.has(node.id) ? ' dim' : ''}`)
      button.type = 'button'
      button.dataset.memoryId = node.id
      button.style.left = `${nodeX(node)}%`
      button.style.top = `${nodeY(node)}%`
      button.style.setProperty('--neuron', node.color)
      button.setAttribute('aria-label', `${node.kind === 'summary' ? T.summary : T[node.kind]}: ${node.text.slice(0, 180)}`)
      button.setAttribute('aria-pressed', String(node.id === selected))
      button.title = node.text.slice(0, 200)
      button.append(el('span', '', 'memory-neuron-core'))
      button.append(el('span', node.text.slice(0,60), 'memory-neuron-label'))
      trace(button,node.id,false)
      button.onclick = () => { selected = node.id; draw() }
      canvas.append(button)
    }
    detail(current, data)
    inspector.scrollTop=inspectorScroll
    if(relationFocus) [...inspector.querySelectorAll('.memory-relation')].find(button=>button.dataset.edge===relationFocus)?.focus({preventScroll:true})
    illuminate()
    if (focus) [...canvas.querySelectorAll('button')].find((button) => button.dataset.memoryId === focus)?.focus({ preventScroll: true })
  }
  let resizeFrame = 0
  const observer = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { if (root.isConnected) draw() })
  })
  observer.observe(viewport)
  let renderSignature=''
  return {
    render(host, value, on) {
      const nextSignature=JSON.stringify(value)
      const changed=nextSignature!==renderSignature || root.parentElement!==host
      renderSignature=nextSignature
      memory = value
      enabled = on
      if (root.parentElement !== host) host.replaceChildren(root)
      sharing.textContent = on ? T.pause : T.enable
      status.textContent = on ? T.active : T.paused
      root.classList.toggle('paused', !on)
      if(changed) draw()
    },
  }
}
