import { agentInteractions, bubbleConnections, networkGraph, teamGraph } from './team-graph.js'
import { interactionPoints } from './team-interactions.js'
import { teamText } from './team-text.js'

const element = (tag, text, className) => {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}
const svgElement = (tag, attributes) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag)
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value))
  return node
}

export function initTeamViews({ host, avatar, choose }) {
  let signature = ''
  let zoom = 0
  let fitOverview = false
  let currentScale = 1
  let filterTag = ''
  let focusId = ''
  let showAllConnections = true
  let graphDirection = 'all'
  let inspectorOpen = false
  let sessionId = ''
  let focusEdge = ''
  let direction = 'outgoing'
  let resetInspector = false
  let latestArgs
  const redraw = () => { signature = ''; views.render(...latestArgs) }
  let resizeGraph = () => {}
  new ResizeObserver(() => resizeGraph()).observe(host)
  function card(agent, grid, selected) {
    const tile = element('button', undefined, `team-node ${agent.status}${selected === agent.id ? ' selected' : ''}`)
    tile.type = 'button'
    tile.dataset.agent = agent.id
    tile.title = `${agent.id} · ${agent.role} · ${agent.status}\n${agent.workKind === 'error' ? teamText.pastError + ': ' : teamText.latest + ': '}${agent.work || teamText.waiting}`
    tile.setAttribute('aria-label', grid ? teamText.open(agent.id) : teamText.focus(agent.id))
    tile.setAttribute('aria-pressed', String(!grid && focusId === agent.id))
    tile.onclick = () => { if (grid) choose(agent.id); else { focusId = agent.id; inspectorOpen = true; focusEdge = ''; resetInspector = true; redraw() } }
    if (!grid) tile.ondblclick = () => choose(agent.id)
    if (!grid) {
      const palette = ['#ff397c', '#36d8c6', '#f04c97', '#e54791']
      const color = palette[[...agent.role].reduce((sum, letter) => sum + letter.charCodeAt(0), 0) % palette.length]
      tile.style.setProperty('--node-color', color)
      tile.style.setProperty('--dot-size', `${agent.bubbleWidth}px`)
      tile.append(element('span', undefined, 'team-network-dot'), element('span', agent.id, 'team-network-label'))
      return tile
    }
    const heading = element('div', undefined, 'team-node-heading')
    const identity = element('div')
    identity.append(element('strong', agent.id), element('span', agent.role, 'team-role'))
    const portrait = avatar(agent.id)
    if (!grid) tile.style.setProperty('--core-voice', portrait.style.getPropertyValue('--voice') || '#b7e8db')
    heading.append(portrait, identity, element('i', undefined, 'team-status-dot'))
    tile.append(heading)
    const status = element('div', undefined, 'team-node-meta')
    status.append(element('span', agent.status, 'team-status'))
    if (grid || agent.queued) status.append(element('span', teamText.queued(agent.queued)))
    tile.append(status)
    const tags = element('div', undefined, 'team-node-tags')
    tags.setAttribute('aria-label', teamText.tags)
    for (const tag of agent.tags.filter((tag) => grid ? tag.kind !== 'role' : tag.kind === 'role')) {
      const badge = element('span', tag.label, `team-tag ${tag.kind}`)
      badge.title = `${tag.kind}: ${tag.label}`
      tags.append(badge)
    }
    tile.append(tags)
    if (grid) {
      tile.append(element('p', agent.model || '', 'team-model'))
      tile.append(element('small', teamText.assignment, 'team-section-label'))
      tile.append(element('p', agent.assignment || agent.task || teamText.waiting, 'team-assignment'))
      tile.append(element('small', teamText.latest, 'team-section-label'))
      const activity = element('div', undefined, 'team-tile-activity')
      for (const line of agent.recent) {
        activity.append(element('p', line.kind === 'error' ? `${teamText.pastError}: ${line.text}` : line.text, `team-activity-line ${line.kind}`))
      }
      if (!agent.recent.length) activity.append(element('p', teamText.waiting, 'quiet'))
      tile.append(activity)
    } else {
      tile.append(element('small', agent.workKind === 'error' ? teamText.pastError : teamText.latest, 'team-section-label'))
      tile.append(element('p', agent.workKind === 'error' ? `${teamText.pastError}: ${agent.work}` : agent.work || agent.assignment || teamText.waiting, 'team-work'))
    }
    return tile
  }
  const views = {
    render(state, mode, selected) {
      latestArgs = [state, mode, selected]
      host.hidden = !['graph', 'grid'].includes(mode)
      if (host.hidden) { resizeGraph = () => {}; return }
      if (sessionId !== state.sessionId) { focusId = ''; focusEdge = ''; filterTag = ''; showAllConnections = true; graphDirection = 'all'; inspectorOpen = false; sessionId = state.sessionId }
      const full = teamGraph(state.agents, state.lines)
      const availableTags = [...new Map(full.nodes.flatMap((agent) => agent.tags).map((tag) => [tag.key, tag])).values()].sort((a, b) => ['role', 'provider', 'task'].indexOf(a.kind) - ['role', 'provider', 'task'].indexOf(b.kind) || a.label.localeCompare(b.label))
      if (!availableTags.some((tag) => tag.key === filterTag)) filterTag = ''
      const visibleIds = new Set(full.nodes.filter((agent) => !filterTag || agent.tags.some((tag) => tag.key === filterTag)).map((agent) => agent.id))
      const filtered = teamGraph(state.agents.filter((agent) => visibleIds.has(agent.id)), state.lines)
      if (!visibleIds.has(focusId)) focusId = [state.target, 'architect', filtered.nodes[0]?.id].find(id=>visibleIds.has(id)) || ''
      const network = mode === 'graph' ? networkGraph(filtered) : filtered
      const data = showAllConnections ? network : {...network, edges: network.edges.filter(edge => graphDirection === 'incoming' ? edge.to === focusId : graphDirection === 'outgoing' ? edge.from === focusId : edge.from === focusId || edge.to === focusId)}
      const next = JSON.stringify([data, mode, selected, filterTag, focusId, focusEdge, direction, graphDirection, showAllConnections, inspectorOpen])
      if (next === signature) return
      signature = next
      const interactionsOpen = host.querySelector('.team-interactions')?.open || false
      const inspectorScroll = resetInspector ? 0 : host.querySelector('.team-inspector-messages')?.scrollTop || 0
      resetInspector = false
      const openDetails = new Set([...host.querySelectorAll('details[open][data-detail]')].map(node=>node.dataset.detail))
      const openMessages = new Set([...host.querySelectorAll('.team-message[open]')].map(node=>node.dataset.message))
      const focusedAction = document.activeElement?.dataset.graphAction
      const filtersOpen = host.querySelector('.team-filter-menu')?.open || false
      const focusedTag = document.activeElement?.closest('.team-filter-chip')?.title
      const focusedSummary = document.activeElement?.matches('.team-interactions summary')
      const focusedViewport = document.activeElement?.matches('.team-graph-scroll')
      const focused = document.activeElement?.closest('.team-node')?.getAttribute('aria-label')
      const oldScroll = host.querySelector('.team-graph-scroll')
      const scroll = { x: oldScroll?.scrollLeft || 0, y: oldScroll?.scrollTop || 0 }
      const header = element('div', undefined, 'team-map-header')
      const counts = element('div', undefined, 'team-map-counts')
      counts.append(element('b', showAllConnections ? teamText.agents(full.nodes.length) : teamText.focusedTitle(focusId)), element('span', teamText.handoffs(data.edges.reduce((total, edge) => total + edge.count, 0))))
      header.append(counts, element('p', teamText.scope, 'quiet small'))
      const filters = element('div', undefined, 'team-tag-filters')
      filters.setAttribute('aria-label', teamText.filterTags)
      for (const tag of [{key:'',label:teamText.allTags,kind:'all'}, ...availableTags]) {
        const chip = element('button', tag.label, `team-filter-chip ${tag.kind}`)
        chip.type = 'button'
        chip.setAttribute('aria-pressed', String(filterTag === tag.key))
        chip.title = tag.key || teamText.allTags
        chip.onclick = () => { filterTag = tag.key; zoom = 0; fitOverview = false; redraw() }
        filters.append(chip)
      }
      const filterMenu = element('details', undefined, 'team-filter-menu')
      filterMenu.open = filtersOpen
      filterMenu.append(element('summary', teamText.filters), filters)
      const focusControls = element('div', undefined, 'team-focus-controls')
      const picker = element('select', undefined, 'team-focus-picker')
      picker.setAttribute('aria-label', teamText.focusPicker)
      picker.dataset.graphAction = 'focus-picker'
      for (const agent of full.nodes) {
        const option = element('option', `${agent.id} · ${agent.role}`)
        option.value = agent.id
        option.selected = agent.id === focusId
        picker.append(option)
      }
      picker.onchange = () => { focusId = picker.value; filterTag = ''; focusEdge = ''; inspectorOpen = false; zoom = 0; fitOverview = false; redraw() }
      focusControls.append(picker)
      for (const [key,label] of [['all',teamText.bothDirections],['incoming',teamText.incoming],['outgoing',teamText.outgoing]]) {
        const control = element('button', label, `team-direction ${key}`)
        control.type = 'button'
        control.dataset.graphAction = `graph-direction:${key}`
        control.setAttribute('aria-pressed', String(!showAllConnections && graphDirection === key))
        control.onclick = () => { graphDirection = key; showAllConnections = false; focusEdge = ''; redraw() }
        focusControls.append(control)
      }
      const all = element('button', teamText.allConnections, 'team-show-all')
      all.type = 'button'
      all.dataset.graphAction = 'show-all'
      all.setAttribute('aria-pressed', String(showAllConnections))
      all.onclick = () => { showAllConnections = !showAllConnections; zoom = 0; fitOverview = false; redraw() }
      focusControls.append(all, filterMenu)
      header.append(focusControls)
      let pointerPreview
      let keyboardPreview
      const preview = () => {
        const match = pointerPreview || keyboardPreview
        const edges = data.edges.filter(edge => match && (match.edge ? edge.id === match.edge : match.agent ? edge.from === match.agent || edge.to === match.agent : match.direction === 'all' || (match.direction === 'incoming' ? edge.to === focusId : edge.from === focusId)))
        const ids = new Set(edges.map(edge => edge.id))
        const agents = new Set(edges.flatMap(edge => [edge.from, edge.to]))
        host.classList.toggle('team-previewing', Boolean(match))
        for (const node of host.querySelectorAll('.team-edge,.team-edge-button,.team-node')) {
          const lit = node.dataset.edge ? ids.has(node.dataset.edge) : agents.has(node.dataset.agent)
          node.classList.toggle('preview-lit', Boolean(match) && lit)
          node.classList.toggle('preview-dim', Boolean(match) && !lit)
        }
        for (const node of host.querySelectorAll('.team-message-point,.team-message')) {
          const lit = match?.message ? node.dataset.message === match.message : Boolean(match && node.classList.contains('team-message-point') && ids.has(node.dataset.edge))
          node.classList.toggle('preview-lit', lit)
          node.classList.toggle('preview-dim', Boolean(match?.message) && !lit)
        }
      }
      const bindPreview = (node, match) => {
        node.addEventListener('pointerenter', () => { pointerPreview = match; preview() })
        node.addEventListener('pointerleave', () => { pointerPreview = undefined; preview() })
        node.addEventListener('focusin', event => { if (node.classList.contains('team-exchange') && event.target.closest('.team-message')) return; keyboardPreview = match; preview() })
        node.addEventListener('focusout', event => { if (!node.contains(event.relatedTarget)) { keyboardPreview = undefined; preview() } })
      }
      for (const control of focusControls.querySelectorAll('.team-direction')) bindPreview(control, { direction: control.classList.contains('incoming') ? 'incoming' : control.classList.contains('outgoing') ? 'outgoing' : 'all' })
      const children = [header]
      if (!data.nodes.length) children.push(element('p', teamText.empty, 'empty'))
      else if (mode === 'grid') {
        resizeGraph = () => {}
        const grid = element('div', undefined, 'team-grid')
        for (const [active, label] of [[true, teamText.activeSection], [false, teamText.idleSection]]) {
          const agents = data.nodes.filter((agent) => (agent.status === 'working') === active)
          if (!agents.length) continue
          const section = element('section', undefined, active ? 'team-grid-active' : 'team-grid-idle')
          const title = element('h3', `${label} · ${agents.length}`, 'team-grid-section-title')
          grid.append(title)
          for (const agent of agents) section.append(card(agent, true, selected))
          grid.append(section)
        }
        children.push(grid)
      } else {
        const viewport = element('div', undefined, 'team-graph-scroll')
        viewport.tabIndex = 0
        viewport.setAttribute('aria-label', teamText.graph)
        const canvas = element('div', undefined, 'team-graph-canvas')
        const { width, height } = data
        canvas.style.width = `${width}px`
        canvas.style.height = `${height}px`
        const svg = svgElement('svg', { viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true', class: 'team-edges' })
        const defs = svgElement('defs', {})
        for (const [kind,color] of [['normal','#81969e'],['incoming','#b9c8eb'],['outgoing','#b3e3d3']]) {
          const marker = svgElement('marker', { id: `team-arrow-${kind}`, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 8, markerHeight: 8, orient: 'auto' })
          marker.append(svgElement('path', { d: 'M 1 1 L 9 5 L 1 9 z', fill: color }))
          defs.append(marker)
        }
        svg.append(defs)
        let messageRail
        for (const edge of bubbleConnections(data)) {
          const edgeDirection = focusId && edge.from === focusId ? 'outgoing' : focusId && edge.to === focusId ? 'incoming' : 'normal'
          const muted = false
          const path = svgElement('path', { d: `M ${edge.start.x} ${edge.start.y} Q ${edge.control.x} ${edge.control.y} ${edge.end.x} ${edge.end.y}`, class: `team-edge ${edgeDirection}${muted ? ' muted' : ''}`, 'marker-end': `url(#team-arrow-${edgeDirection})` })
          path.dataset.edge = edge.id
          path.dataset.from = edge.from
          path.dataset.to = edge.to
          const title = svgElement('title', {})
          title.textContent = `${teamText.edge(edge.from, edge.to, edge.count)}: ${edge.text}`
          path.append(title)
          svg.append(path)
          const badge = element('button', String(edge.count), `team-edge-button${muted ? ' muted' : ''}${focusEdge === edge.id ? ' selected' : ''}`)
          badge.type = 'button'
          badge.dataset.edge = edge.id
          bindPreview(badge, { edge: edge.id })
          badge.setAttribute('aria-label', teamText.inspectExchange(edge.from, edge.to, edge.count))
          badge.setAttribute('aria-pressed', String(focusEdge === edge.id))
          badge.dataset.graphAction = `edge:${edge.id}`
          badge.style.left = `${edge.label.x}px`
          badge.style.top = `${edge.label.y}px`
          badge.onclick = () => { if (edge.from !== focusId && edge.to !== focusId) focusId = edge.from; inspectorOpen = true; focusEdge = edge.id; direction = edge.to === focusId ? 'incoming' : 'outgoing'; resetInspector = true; redraw() }
          badge.hidden = Boolean(inspectorOpen && focusEdge === edge.id)
          canvas.append(badge)
          if (inspectorOpen && focusEdge === edge.id) {
            const points = interactionPoints(edge.messages, edge)
            const dense = points.length > 12
            let pointHost = canvas
            if (dense) {
              messageRail = element('section', undefined, 'team-message-rail')
              messageRail.setAttribute('aria-label', teamText.interactionRail(edge.from, edge.to, points.length))
              messageRail.append(element('strong', teamText.interactionRail(edge.from, edge.to, points.length)))
              pointHost = element('div', undefined, 'team-message-rail-points')
              messageRail.append(pointHost)
            }
            for (const point of points) {
              const message = edge.messages.find(message => message.id === point.id)
              const dot = element('button', String(point.label), 'team-message-point')
              dot.type = 'button'
              dot.dataset.message = point.id
              dot.dataset.edge = edge.id
              dot.dataset.graphAction = `interaction:${point.id}`
              dot.setAttribute('aria-label', teamText.interactionPoint(point.label, edge.from, edge.to))
              dot.title = `${point.label} · ${message?.text || ''}`
              if (!dense) { dot.style.left = `${point.x}px`; dot.style.top = `${point.y}px` }
              bindPreview(dot, { edge: edge.id, message: point.id })
              dot.onclick = () => {
                const entry = [...host.querySelectorAll('.team-message')].find(node => node.dataset.message === point.id)
                if (!entry) return
                entry.open = true
                const scroller = entry.closest('.team-inspector-messages')
                if (scroller) scroller.scrollTop += entry.getBoundingClientRect().top - scroller.getBoundingClientRect().top
                entry.querySelector('summary')?.focus({ preventScroll: true })
              }
              pointHost.append(dot)
            }
          }
        }
        canvas.append(svg)
        for (const agent of data.nodes) {
          const node = card(agent, false, focusId)
          bindPreview(node, { agent: agent.id })
          node.style.width = '36px'
          node.style.height = '36px'
          node.style.left = `${agent.x}%`
          node.style.top = `${agent.y}%`
          canvas.append(node)
        }
        const frame = element('div', undefined, 'team-graph-frame')
        frame.append(canvas)
        viewport.append(frame)
        if (messageRail) viewport.append(messageRail)
        const zoomTools = element('div', undefined, 'team-zoom')
        const zoomLabel = element('span', '', 'quiet small')
        const applyZoom = () => {
          const availableWidth = viewport.clientWidth || host.clientWidth || 850
          const fitted = Math.min(1, availableWidth / width)
          const scale = zoom || (availableWidth < 600 && !fitOverview ? Math.max(.65, fitted) : Math.max(.15, fitted))
          currentScale = scale
          canvas.style.setProperty('--graph-scale', String(scale))
          canvas.style.transformOrigin = 'top left'
          canvas.style.transform = `scale(${scale})`
          frame.style.width = `${width * scale}px`
          frame.style.height = `${height * scale}px`
          zoomLabel.textContent = `${Math.round(scale * 100)}%`
        }
        for (const [label, text, change] of [[teamText.zoomOut, '−', -.15], [teamText.zoomIn, '+', .15], [teamText.fit, teamText.fit, 0]]) {
          const control = element('button', text, 'subtle')
          control.type = 'button'
          control.setAttribute('aria-label', label)
          control.onclick = () => {
            zoom = change ? Math.min(1.6, Math.max(.25, currentScale + change)) : 0
            fitOverview = !change
            applyZoom()
          }
          zoomTools.append(control)
        }
        zoomTools.append(zoomLabel)
        header.append(zoomTools, element('small', teamText.panHint, 'team-pan-hint'))
        viewport.addEventListener('pointerdown', (event) => {
          if (event.target.closest('button') || event.button !== 0) return
          const start = { x: event.clientX, y: event.clientY, left: viewport.scrollLeft, top: viewport.scrollTop }
          viewport.setPointerCapture(event.pointerId)
          const move = (next) => { viewport.scrollLeft = start.left - next.clientX + start.x; viewport.scrollTop = start.top - next.clientY + start.y }
          const end = () => { viewport.removeEventListener('pointermove', move); viewport.removeEventListener('pointerup', end); viewport.removeEventListener('pointercancel', end) }
          viewport.addEventListener('pointermove', move)
          viewport.addEventListener('pointerup', end)
          viewport.addEventListener('pointercancel', end)
        })
        resizeGraph = applyZoom
        requestAnimationFrame(applyZoom)
        const stage = element('div', undefined, 'team-graph-stage')
        stage.append(viewport)
        if (focusId && inspectorOpen) {
          stage.classList.add('inspecting')
          const inspection = element('aside', undefined, 'team-focus-inspector')
          inspection.setAttribute('aria-label', teamText.focus(focusId))
          const head = element('div', undefined, 'team-inspector-head')
          head.append(avatar(focusId), element('strong', focusId))
          const clear = element('button', '×', 'subtle')
          clear.type = 'button'
          clear.setAttribute('aria-label', teamText.closeInspector)
          clear.onclick = () => { inspectorOpen = false; focusEdge = ''; redraw() }
          head.append(clear)
          inspection.append(head)
          const focused = data.nodes.find(agent => agent.id === focusId)
          if (focused) {
            inspection.append(element('p', `${focused.role} · ${focused.status}`, 'team-inspector-identity'))
            const detail = element('details', undefined, 'team-inspector-activity')
            detail.dataset.detail = `activity:${focusId}`
            detail.open = openDetails.has(detail.dataset.detail)
            detail.append(element('summary', focused.workKind === 'error' ? teamText.pastError : teamText.latest), element('p', focused.work || focused.assignment || teamText.waiting))
            inspection.append(detail)
          }
          const interactions = agentInteractions(full, focusId)
          const tabs = element('div', undefined, 'team-message-tabs')
          for (const [key, label] of [['incoming',teamText.incoming],['outgoing',teamText.outgoing]]) {
            const count = interactions[key].reduce((total,edge)=>total+edge.count,0)
            const control = element('button', `${label} ${count}`, key)
            control.type = 'button'
            control.dataset.graphAction = `direction:${key}`
            control.setAttribute('aria-pressed', String(direction === key))
            control.onclick = () => { direction = key; focusEdge = ''; resetInspector = true; redraw() }
            bindPreview(control, { direction: key })
            tabs.append(control)
          }
          inspection.append(tabs)
          const messages = element('div', undefined, 'team-inspector-messages')
          const edges = interactions[direction].filter(edge=>!focusEdge||edge.id===focusEdge)
          if (focusEdge) {
            const all = element('button', teamText.allExchanges, 'subtle team-all-exchanges')
            all.type = 'button'
            all.onclick = () => { focusEdge = ''; redraw() }
            messages.append(all)
          }
          if (!edges.length) messages.append(element('p', teamText.noMessages, 'quiet small'))
          for (const edge of edges) {
            const exchange = element('section', undefined, 'team-exchange')
            exchange.dataset.edge = edge.id
            bindPreview(exchange, { edge: edge.id })
            exchange.append(element('h3', `${edge.from} → ${edge.to}`, direction), element('small', teamText.handoffs(edge.count), 'quiet'))
            for (const [messageIndex, message] of edge.messages.entries()) {
              const entry = element('details', undefined, 'team-message')
              entry.dataset.message = message.id
              bindPreview(entry, { edge: edge.id, message: message.id })
              entry.open = openMessages.has(message.id) || Boolean(focusEdge && edge.messages.length === 1)
              const summary = element('summary', `${messageIndex + 1} · ${message.text.replace(/\s+/g,' ').slice(0,120)}`)
              summary.dataset.graphAction = `message:${message.id}`
              entry.append(summary, element('pre', message.text))
              if (message.source === 'outgoing') entry.append(element('small', teamText.previewOnly, 'quiet'))
              exchange.append(entry)
            }
            if (edge.currentTasks.length) {
              const tasks = element('details', undefined, 'team-exchange-tasks')
              tasks.dataset.detail = `tasks:${edge.id}`
              tasks.open = openDetails.has(tasks.dataset.detail)
              tasks.append(element('summary', teamText.currentTasks))
              for (const task of edge.currentTasks) tasks.append(element('p', `${task.agentId}: ${task.task}`))
              tasks.append(element('small', teamText.taskScope, 'quiet'))
              exchange.append(tasks)
            }
            messages.append(exchange)
          }
          messages.append(element('p', teamText.messagesScope, 'quiet small team-message-scope'))
          inspection.append(messages)
          const open = element('button', teamText.open(focusId), 'subtle team-open-conversation')
          open.type = 'button'
          open.onclick = () => choose(focusId)
          inspection.append(open)
          stage.append(inspection)
        }
        children.push(stage)
        if (!data.edges.length) children.push(element('p', teamText.noEdges, 'quiet small team-empty-edges'))
        const interactions = element('details', undefined, 'team-interactions')
        interactions.open = interactionsOpen
        interactions.append(element('summary', teamText.handoffs(data.edges.reduce((total, edge) => total + edge.count, 0))))
        for (const edge of data.edges.filter((edge) => !focusId || edge.from === focusId || edge.to === focusId)) interactions.append(element('p', `${teamText.edge(edge.from, edge.to, edge.count)} — ${edge.text}`))
        children.push(interactions)
      }
      host.classList.remove('team-previewing')
      host.replaceChildren(...children)
      const viewport = host.querySelector('.team-graph-scroll')
      if (viewport) { viewport.scrollLeft = scroll.x; viewport.scrollTop = scroll.y }
      const inspectorMessages = host.querySelector('.team-inspector-messages')
      if (inspectorMessages) inspectorMessages.scrollTop = inspectorScroll
      if (focusedAction) [...host.querySelectorAll('[data-graph-action]')].find(node=>node.dataset.graphAction === focusedAction)?.focus({preventScroll:true})
      if (focusedTag) [...host.querySelectorAll('.team-filter-chip')].find((node) => node.title === focusedTag)?.focus({preventScroll:true})
      if (focusedSummary) host.querySelector('.team-interactions summary')?.focus({ preventScroll: true })
      if (focusedViewport) viewport?.focus({ preventScroll: true })
      if (focused) [...host.querySelectorAll('.team-node')].find((node) => node.getAttribute('aria-label') === focused)?.focus({ preventScroll: true })
    },
  }
  return views
}
