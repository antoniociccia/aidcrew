import { optimalLayout, reconcileLayout, moveTile, resizeTile, parseTileLayout } from './tiling-layout.js'
import { tilingText as text } from './tiling-text.js'

const el = (tag, content, className) => {
  const node = document.createElement(tag)
  if (content !== undefined) node.textContent = content
  if (className) node.className = className
  return node
}
const button = (label, action, className) => {
  const node = el('button', label, className)
  node.type = 'button'
  node.onclick = action
  return node
}

export function initTiling({ host, avatar, choose, send }) {
  let state, tree = null, cwd, active = false, selected = '', externalSelected, maximized = '', gesture, pendingRender = false
  const panes = new Map(), splits = new Map()
  const toolbar = el('header', undefined, 'tiling-toolbar')
  const title = el('strong', text.title)
  const restoreButton = button(text.restoreLayout, () => {
    finish(true)
    maximized = ''
    tree = optimalLayout(state.agents.map(agent => agent.id), viewport.clientWidth, viewport.clientHeight)
    save(); rebuild()
    viewport.scrollTop = 0; viewport.scrollLeft = 0
  }, 'tiling-balance')
  restoreButton.title = text.restoreHint
  toolbar.append(title, el('span', text.hint, 'tiling-hint'), restoreButton)
  const status = el('div', '', 'tiling-status')
  status.setAttribute('role', 'status')
  const viewport = el('div', undefined, 'tiling-viewport'), stage = el('div', undefined, 'tiling-stage')
  viewport.append(stage)
  host.classList.add('tiling-surface')
  host.replaceChildren(toolbar, viewport, status)
  const key = () => `aidcrew:tiles:v1:${cwd}`
  function save() {
    try { localStorage.setItem(key(), JSON.stringify({ version: 1, layout: tree })) }
    catch { status.textContent = text.storage }
  }
  function restore(ids) {
    try {
      const saved = JSON.parse(localStorage.getItem(key()) || 'null')
      const parsed = saved?.version === 1 ? parseTileLayout(saved.layout) : null
      return reconcileLayout(parsed || optimalLayout(ids, viewport.clientWidth, viewport.clientHeight), ids)
    } catch { return optimalLayout(ids, viewport.clientWidth, viewport.clientHeight) }
  }
  function setRatio(id, ratio) {
    tree = resizeTile(tree, id, ratio)
    const visit = branch => {
      if (!branch || branch.kind === 'leaf') return
      const current = splits.get(branch.id)
      if (current) { current.first.style.flex = `${branch.ratio} 1 0`; current.second.style.flex = `${1 - branch.ratio} 1 0`; current.divider.setAttribute('aria-valuenow', String(Math.round(branch.ratio * 100))) }
      visit(branch.first); visit(branch.second)
    }
    visit(tree)
    sizeStage()
  }
  function finish(cancel = false) {
    const current = gesture
    if (!current) return
    current.controller.abort()
    current.preview?.remove()
    host.classList.remove('tiling-dragging')
    gesture = undefined
    if (cancel && current.original) { tree = current.original; rebuild() }
    else if (current.type === 'move' && current.destination) { tree = moveTile(tree, current.source, current.destination.id, current.destination.edge); save(); rebuild() }
    else if (!cancel && current.type === 'resize') save()
    if (pendingRender) { pendingRender = false; views.render(state, active, selected) }
  }
  function track(event, move) {
    const controller = new AbortController()
    gesture.controller = controller
    const options = { signal: controller.signal }
    document.addEventListener('pointermove', move, options)
    document.addEventListener('pointerup', () => finish(), options)
    document.addEventListener('pointercancel', () => finish(true), options)
    window.addEventListener('blur', () => finish(true), options)
    document.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); finish(true) } }, { ...options, capture: true })
    event.preventDefault()
  }
  function moveStart(event, id) {
    if (event.button !== 0 || maximized) return
    finish(true)
    gesture = { type: 'move', source: id }
    host.classList.add('tiling-dragging')
    track(event, pointer => {
      const target = document.elementFromPoint(pointer.clientX, pointer.clientY)?.closest('.tile-pane')
      gesture.preview?.remove(); gesture.destination = undefined
      if (!target || !stage.contains(target) || target.dataset.agent === id) return
      const bounds = target.getBoundingClientRect(), x = (pointer.clientX - bounds.left) / bounds.width, y = (pointer.clientY - bounds.top) / bounds.height
      const closest = Math.min(x, 1-x, y, 1-y)
      const edge = closest > .24 ? 'center' : closest === x ? 'left' : closest === 1-x ? 'right' : closest === y ? 'top' : 'bottom'
      const preview = el('div', text.positions[edge], `tile-drop-preview ${edge}`)
      target.append(preview)
      gesture.preview = preview; gesture.destination = { id: target.dataset.agent, edge }
    })
  }
  function resizeStart(event, branch, container) {
    if (event.button !== 0) return
    finish(true)
    const bounds = container.getBoundingClientRect()
    gesture = { type: 'resize', original: tree }
    track(event, pointer => {
      const ratio = branch.axis === 'horizontal' ? (pointer.clientX - bounds.left) / bounds.width : (pointer.clientY - bounds.top) / bounds.height
      setRatio(branch.id, ratio)
    })
  }
  function pane(agent) {
    const node = el('section', undefined, 'tile-pane')
    node.dataset.agent = agent.id; node.setAttribute('aria-label', agent.id)
    const header = el('header', undefined, 'tile-header')
    const drag = button('', () => { selected = agent.id; markSelection() }, 'tile-drag')
    drag.setAttribute('aria-label', text.drag(agent.id)); drag.title = text.drag(agent.id)
    drag.append(avatar(agent.id), el('strong', agent.id))
    drag.onpointerdown = event => moveStart(event, agent.id)
    const activity = el('span', '', 'tile-status')
    const zoom = button('⛶', () => { maximized = maximized === agent.id ? '' : agent.id; rebuild() }, 'tile-maximize')
    zoom.title = text.maximize; zoom.setAttribute('aria-label', `${text.maximize} ${agent.id}`)
    const menu = el('details', undefined, 'tile-menu'), summary = el('summary', '⋯')
    summary.setAttribute('aria-label', `${text.move}: ${agent.id}`)
    const settings = el('div', undefined, 'tile-menu-content')
    const target = el('select'); target.setAttribute('aria-label', text.target)
    const edge = el('select'); edge.setAttribute('aria-label', text.position)
    for (const [value, label] of Object.entries(text.positions)) { const option = el('option', label); option.value = value; edge.append(option) }
    settings.append(target, edge, button(text.move, () => { if (!target.value) return; tree = moveTile(tree, agent.id, target.value, edge.value); menu.open = false; maximized = ''; save(); rebuild() }), button(text.open, () => choose(agent.id)))
    menu.append(summary, settings); header.append(drag, activity, zoom, menu)
    const filters = el('div', undefined, 'tile-filters'), filter = el('select')
    filter.setAttribute('aria-label', `${text.filter}: ${agent.id}`)
    for (const [value, label] of Object.entries(text.filters)) { const option = el('option', label); option.value = value; filter.append(option) }
    const latest = button(text.latest, () => { transcript.scrollTop = transcript.scrollHeight; follow = true })
    filters.append(filter, latest)
    const transcript = el('div', undefined, 'tile-transcript')
    transcript.tabIndex = 0; transcript.setAttribute('aria-label', `${agent.id} activity`)
    let follow = true, signature = ''
    transcript.onscroll = () => { follow = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 36 }
    filter.onchange = () => { signature = ''; updateTranscript() }
    const updateTranscript = () => {
      const entries = state.lines.filter(line => line.agentId === agent.id && line.kind !== 'thinking' && (filter.value === 'all' || filter.value === 'messages' && ['ask', 'say', 'note'].includes(line.kind) || filter.value === 'tools' && ['tool', 'error', 'diff'].includes(line.kind)))
      const next = JSON.stringify(entries)
      if (next === signature) return
      signature = next
      const scroll = transcript.scrollTop
      if (transcript.isConnected) follow = transcript.scrollHeight - scroll - transcript.clientHeight < 36
      const fragment = document.createDocumentFragment()
      for (const entry of entries) { const line = el('div', undefined, `tile-entry ${['ask','say','note','tool','error','diff'].includes(entry.kind) ? entry.kind : 'note'}`); line.append(el('small', entry.kind), el('pre', entry.text)); fragment.append(line) }
      if (!entries.length) fragment.append(el('p', text.noActivity, 'tile-empty'))
      transcript.replaceChildren(fragment)
      transcript.scrollTop = follow ? transcript.scrollHeight : scroll
    }
    node.append(header, filters, transcript)
    if (send) {
      const form = el('form', undefined, 'tile-composer'), input = el('textarea'), submit = el('button', text.send)
      input.rows = 1; input.placeholder = text.message(agent.id); input.setAttribute('aria-label', text.message(agent.id)); input.maxLength = 100000
      submit.type = 'submit'
      let sending = false
      form.onsubmit = async event => {
        event.preventDefault()
        const message = input.value.trim()
        if (!message || !state.ready || sending) return
        sending = true; submit.disabled = true; submit.textContent = text.sending
        try { await send(agent.id, message); if (input.value.trim() === message) input.value = '' }
        catch { status.textContent = text.failed }
        finally { sending = false; submit.disabled = false; submit.textContent = text.send }
      }
      input.onkeydown = event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); form.requestSubmit() } }
      form.append(input, submit); node.append(form)
    }
    return { node, afterLayout() { if (follow) transcript.scrollTop = transcript.scrollHeight; zoom.title = maximized === agent.id ? text.restorePane : text.maximize; zoom.setAttribute('aria-label', `${zoom.title} ${agent.id}`) }, update(agent) {
      activity.textContent = `${agent.status}${agent.queued ? ` · ${text.queued(agent.queued)}` : ''}`
      node.dataset.status = agent.status
      const peers = state.agents.filter(peer => peer.id !== agent.id)
      const previous = target.value
      if (target.dataset.ids !== peers.map(peer => peer.id).join('\0')) {
        target.dataset.ids = peers.map(peer => peer.id).join('\0')
        target.replaceChildren(...peers.map(peer => { const option = el('option', peer.id); option.value = peer.id; return option }))
        if (peers.some(peer => peer.id === previous)) target.value = previous
      }
      zoom.title = maximized === agent.id ? text.restorePane : text.maximize
      zoom.setAttribute('aria-label', `${zoom.title} ${agent.id}`)
      updateTranscript()
    } }
  }
  function markSelection() { for (const [id, entry] of panes) entry.node.classList.toggle('focused', id === selected) }
  function minSize(branch) {
    if (!branch || branch.kind === 'leaf') return { width: 250, height: 200 }
    const a = minSize(branch.first), b = minSize(branch.second)
    return branch.axis === 'horizontal' ? { width: Math.max(a.width / branch.ratio, b.width / (1-branch.ratio)) + 6, height: Math.max(a.height,b.height) } : { width: Math.max(a.width,b.width), height: Math.max(a.height / branch.ratio, b.height / (1-branch.ratio)) + 6 }
  }
  function branchNode(branch) {
    if (branch.kind === 'leaf') return panes.get(branch.agentId)?.node || el('div')
    const container = el('div', undefined, `tile-split ${branch.axis}`)
    const first = el('div', undefined, 'tile-branch'), second = el('div', undefined, 'tile-branch')
    first.style.flex = `${branch.ratio} 1 0`; second.style.flex = `${1-branch.ratio} 1 0`
    first.append(branchNode(branch.first)); second.append(branchNode(branch.second))
    const divider = el('div', undefined, 'tile-divider')
    divider.tabIndex = 0; divider.setAttribute('role', 'separator'); divider.setAttribute('aria-label', text.resize)
    divider.setAttribute('aria-orientation', branch.axis === 'horizontal' ? 'vertical' : 'horizontal')
    divider.setAttribute('aria-valuemin', '15'); divider.setAttribute('aria-valuemax', '85'); divider.setAttribute('aria-valuenow', String(Math.round(branch.ratio * 100)))
    divider.onpointerdown = event => resizeStart(event, branch, container)
    divider.ondblclick = () => { setRatio(branch.id, .5); save() }
    divider.onkeydown = event => { const keys = branch.axis === 'horizontal' ? ['ArrowLeft','ArrowRight'] : ['ArrowUp','ArrowDown']; if (!keys.includes(event.key)) return; event.preventDefault(); event.stopPropagation(); setRatio(branch.id, Number(divider.getAttribute('aria-valuenow')) / 100 + (event.key === keys[0] ? -.05 : .05)); save() }
    container.append(first, divider, second); splits.set(branch.id, { first, second, divider }); return container
  }
  function sizeStage() {
    const layout = maximized && panes.has(maximized) ? { kind: 'leaf', agentId: maximized } : tree
    const minimum = minSize(layout)
    stage.style.minWidth = `${minimum.width}px`; stage.style.minHeight = `${minimum.height}px`
    stage.style.width = `${Math.max(viewport.clientWidth, minimum.width)}px`; stage.style.height = `${Math.max(viewport.clientHeight, minimum.height)}px`
  }
  function rebuild() {
    const focused = document.activeElement
    const scrolls = [...panes.values()].map(entry => [entry.node.querySelector('.tile-transcript'), entry.node.querySelector('.tile-transcript').scrollTop])
    splits.clear()
    const layout = maximized && panes.has(maximized) ? { kind: 'leaf', agentId: maximized } : tree
    const minimum = minSize(layout)
    stage.style.minWidth = `${minimum.width}px`; stage.style.minHeight = `${minimum.height}px`
    stage.style.width = `${Math.max(viewport.clientWidth, minimum.width)}px`; stage.style.height = `${Math.max(viewport.clientHeight, minimum.height)}px`
    stage.replaceChildren(layout ? branchNode(layout) : el('p', text.empty, 'tile-empty'))
    for (const [node, scroll] of scrolls) node.scrollTop = scroll
    for (const entry of panes.values()) entry.afterLayout()
    if (focused?.isConnected) focused.focus({ preventScroll: true })
    markSelection()
  }
  const observer = new ResizeObserver(() => { if (active) sizeStage() })
  observer.observe(viewport)
  const views = { render(next, enabled, target) {
    state = next; active = enabled; if (target !== externalSelected) { selected = target; externalSelected = target }
    host.hidden = !active
    if (!active) { finish(true); return }
    if (gesture) { pendingRender = true; return }
    const ids = state.agents.map(agent => agent.id)
    const previous = JSON.stringify(tree)
    const workspaceChanged = cwd !== state.cwd
    if (workspaceChanged) { cwd = state.cwd; panes.clear(); maximized = ''; tree = restore(ids) }
    else tree = reconcileLayout(tree, ids)
    for (const id of panes.keys()) if (!ids.includes(id)) panes.delete(id)
    for (const agent of state.agents) { if (!panes.has(agent.id)) panes.set(agent.id, pane(agent)); panes.get(agent.id).update(agent) }
    if (maximized && !ids.includes(maximized)) maximized = ''
    if (workspaceChanged || previous !== JSON.stringify(tree) || !stage.firstChild) rebuild()
    markSelection()
  }, destroy() { observer.disconnect(); finish(true); panes.clear(); splits.clear(); host.replaceChildren() } }
  return views
}
