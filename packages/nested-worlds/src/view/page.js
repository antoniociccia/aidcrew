// The viewer page: plays a run's frames on a canvas and lists what each agent
// did and thought. Agent text is model output, so it only ever reaches the
// screen through textContent or canvas fillText, never as markup.

const COLORS = ['#ffb347', '#6ec6ff', '#ff7eb6', '#a5e86b', '#ffd54f', '#b39ddb', '#4dd0e1', '#ff8a65']
const TERRAIN = { ground: '#2e3b2a', rock: '#5a5550', water: '#1f4e79' }
const ITEMS = {
  food: { glyph: '●', color: '#7ee07e' },
  stone: { glyph: '▲', color: '#b8b8b8' },
  crystal: { glyph: '◆', color: '#7fe3ff' },
  tablet: { glyph: '▤', color: '#e0c48c' },
}
const BASE_MS = 600

const $ = (id) => document.getElementById(id)

const state = {
  runId: '',
  detail: null,
  frames: [],
  index: 0,
  playing: false,
  speed: 4,
  observer: false,
  logAgent: '',
  follow: true,
  source: null,
  timer: null,
  colorOf: new Map(),
}

function el(tag, text, className) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  if (className) node.className = className
  return node
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild)
}

async function getJson(path) {
  const res = await fetch(path)
  if (!res.ok) throw new Error(`${path}: ${res.status}`)
  return res.json()
}

// --- loading -------------------------------------------------------------

async function loadRuns() {
  const runs = await getJson('/api/runs')
  const select = $('run')
  clear(select)
  for (const r of runs) {
    const option = el('option', `${r.decider} · ${r.condition} · seed ${r.seed} · ${r.status} · ${r.runId.slice(0, 8)}`)
    option.value = r.runId
    select.append(option)
  }
  const wanted = new URLSearchParams(location.search).get('run')
  const pick = runs.find((r) => r.runId === wanted) ?? runs[0]
  if (pick) {
    select.value = pick.runId
    await openRun(pick.runId)
  } else {
    $('meta').textContent = 'No runs in this store yet.'
  }
}

async function refreshDetail() {
  state.detail = await getJson(`/api/runs/${encodeURIComponent(state.runId)}`)
  renderHeader()
  renderRules()
  render()
}

async function openRun(runId) {
  state.source?.close()
  state.runId = runId
  state.frames = []
  state.index = 0
  state.follow = true
  history.replaceState(null, '', `?run=${encodeURIComponent(runId)}`)
  await refreshDetail()
  state.colorOf = new Map()
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/stream`)
  source.addEventListener('frame', (e) => {
    const frame = JSON.parse(e.data)
    state.frames[frame.tick] = frame
    if (state.follow && !state.playing) state.index = state.frames.length - 1
    render()
  })
  source.addEventListener('status', (e) => {
    const { status } = JSON.parse(e.data)
    $('live').hidden = status !== 'running'
    // The verdict is only final once the run has stopped writing.
    if (status !== 'running') refreshDetail()
  })
  state.source = source
}

// --- header and rules ----------------------------------------------------

function badge(id, label, value) {
  const node = $(id)
  node.textContent = `${label}: ${value}`
  node.className = `badge ${value ? 'yes' : 'no'}`
}

function renderHeader() {
  const d = state.detail
  if (!d) return
  const c = d.config
  const model = c.model ? ` · ${c.model}` : ''
  $('meta').textContent = `${c.decider}${model} · condition ${c.condition} · seed ${c.seed} · ${c.agents} agents · ${c.ticks} ticks · ${d.status}`
  badge('escaped', 'escaped', d.report.escaped)
  badge('verified', 'verified', d.report.verified)
  $('live').hidden = d.status !== 'running'
}

function renderRules() {
  const list = $('rules-list')
  clear(list)
  const d = state.detail
  $('rules').hidden = !state.observer || !d
  if (!d) return
  const r = d.observer.rules
  const rows = [
    ['regrowth period', `${r.regrowthPeriod} ticks`],
    ['day length', `${r.dayLength} ticks`],
    ['fertile tiles', r.fertile.map((p) => `(${p.x},${p.y})`).join(' ')],
    ['glitch', `(${r.glitch.from.x},${r.glitch.from.y}) → (${r.glitch.to.x},${r.glitch.to.y}) after ${r.glitch.delay} ticks`],
    ['resonance', `agents ${r.resonance.pairDistance} apart gain ${r.resonance.energy}`],
    ['combination', `${r.regrowthPeriod}, ${r.glitch.delay}, ${r.dayLength}`],
  ]
  for (const [k, v] of rows) list.append(el('dt', k), el('dd', v))
}

// --- canvas --------------------------------------------------------------

function colorFor(agentId) {
  if (!state.colorOf.has(agentId)) state.colorOf.set(agentId, COLORS[state.colorOf.size % COLORS.length])
  return state.colorOf.get(agentId)
}

function drawWorld(frame) {
  const canvas = $('world')
  const ctx = canvas.getContext('2d')
  const d = state.detail
  const { width, height, terrain } = d.world
  const cell = Math.floor(Math.min(canvas.width / width, canvas.height / height))
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      ctx.fillStyle = TERRAIN[terrain[y * width + x]] ?? '#000'
      ctx.fillRect(x * cell, y * cell, cell - 1, cell - 1)
    }
  }
  if (state.observer) {
    ctx.strokeStyle = '#b48cff'
    ctx.lineWidth = 2
    ctx.setLineDash([4, 3])
    for (const p of d.observer.fertile) ctx.strokeRect(p.x * cell + 2, p.y * cell + 2, cell - 5, cell - 5)
    ctx.setLineDash([])
  }
  if (!frame) return
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  for (const item of frame.items) {
    const cx = item.pos.x * cell + cell / 2
    const cy = item.pos.y * cell + cell / 2
    if (item.kind === 'slab') {
      ctx.fillStyle = frame.upper.unlocked ? '#b48cff' : '#4b3a6b'
      ctx.fillRect(item.pos.x * cell + 3, item.pos.y * cell + 3, cell - 7, cell - 7)
      ctx.strokeStyle = '#e8dcff'
      ctx.lineWidth = 2
      ctx.strokeRect(item.pos.x * cell + 3, item.pos.y * cell + 3, cell - 7, cell - 7)
      continue
    }
    const look = ITEMS[item.kind] ?? { glyph: '?', color: '#fff' }
    ctx.fillStyle = look.color
    ctx.font = `${Math.floor(cell * 0.45)}px system-ui`
    ctx.fillText(look.glyph, cx, cy)
  }
  for (const agent of frame.agents) drawAgent(ctx, agent, cell)
  for (const e of frame.events) {
    if (e.type !== 'said') continue
    const agent = frame.agents.find((a) => a.id === e.agentId)
    if (agent) drawBubble(ctx, agent, String(e.payload.text ?? ''), cell, canvas.width)
  }
  // Night: darken by how far the light has dropped.
  ctx.fillStyle = `rgba(8, 10, 40, ${Math.max(0, 1 - frame.light) * 0.55})`
  ctx.fillRect(0, 0, canvas.width, canvas.height)
}

function drawAgent(ctx, agent, cell) {
  const cx = agent.pos.x * cell + cell / 2
  const cy = agent.pos.y * cell + cell / 2
  ctx.globalAlpha = agent.alive ? 1 : 0.35
  ctx.fillStyle = colorFor(agent.id)
  ctx.beginPath()
  ctx.arc(cx, cy - 2, cell * 0.3, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#000'
  ctx.font = `bold ${Math.floor(cell * 0.3)}px system-ui`
  ctx.fillText(agent.name.slice(0, 2), cx, cy - 2)
  const barW = cell * 0.8
  const x0 = cx - barW / 2
  const y0 = agent.pos.y * cell + cell - 7
  ctx.fillStyle = '#300'
  ctx.fillRect(x0, y0, barW, 4)
  ctx.fillStyle = agent.energy > 30 ? '#4cc38a' : '#e5675b'
  ctx.fillRect(x0, y0, (barW * Math.max(0, Math.min(100, agent.energy))) / 100, 4)
  ctx.globalAlpha = 1
}

function drawBubble(ctx, agent, text, cell, canvasWidth) {
  const shown = text.length > 42 ? `${text.slice(0, 41)}…` : text
  ctx.font = '12px system-ui'
  const w = Math.min(ctx.measureText(shown).width + 12, canvasWidth - 4)
  const cx = agent.pos.x * cell + cell / 2
  const x = Math.max(2, Math.min(canvasWidth - w - 2, cx - w / 2))
  const y = Math.max(2, agent.pos.y * cell - 22)
  ctx.fillStyle = 'rgba(255, 255, 255, 0.92)'
  ctx.fillRect(x, y, w, 18)
  ctx.fillStyle = '#111'
  ctx.textAlign = 'left'
  ctx.fillText(shown, x + 6, y + 9)
  ctx.textAlign = 'center'
}

// --- panels --------------------------------------------------------------

function seenSoFar() {
  return state.frames.slice(0, state.index + 1).filter(Boolean)
}

function describeAction(action) {
  if (!action) return '—'
  const { type, ...rest } = action
  const detail = Object.entries(rest)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
    .join(' ')
  return detail ? `${type} ${detail}` : type
}

function agentHistory(frames, agentId) {
  const h = { action: null, result: '', rationale: '', notes: [], hypotheses: [], predictions: new Map(), strategy: '' }
  for (const f of frames) {
    for (const e of f.events) {
      if (e.agentId !== agentId) continue
      const p = e.payload
      if (e.type === 'action') {
        h.action = p.action
        h.result = p.result?.message ?? ''
      } else if (e.type === 'decision') h.rationale = p.rationale ?? ''
      else if (e.type === 'note') h.notes.push(`t${e.tick}${p.shared ? ' (shared)' : ''}: ${p.text}`)
      else if (e.type === 'hypothesis') h.hypotheses.push(`${p.id}: ${p.statement}`)
      else if (e.type === 'prediction') h.predictions.set(p.id, { text: `${p.id} @${p.claim?.atTick}: ${JSON.stringify(p.claim)}`, mark: '…' })
      else if (e.type === 'prediction_resolved') {
        const known = h.predictions.get(p.predictionId)
        if (known) known.mark = p.correct ? '✓' : '✗'
      } else if (e.type === 'strategy_revised') h.strategy = p.text
    }
  }
  return h
}

function listOf(items, empty) {
  if (items.length === 0) return el('span', empty, 'meta')
  const ol = el('ol', undefined, 'list')
  for (const text of items.slice(-5)) ol.append(el('li', text))
  return ol
}

function renderAgents(frame, frames) {
  const box = $('agents')
  clear(box)
  if (!frame) return
  for (const agent of frame.agents) {
    const h = agentHistory(frames, agent.id)
    const card = el('div', undefined, 'agent')
    const head = el('div', undefined, 'agent-head')
    const swatch = el('span', undefined, 'swatch')
    swatch.style.background = colorFor(agent.id)
    head.append(swatch, el('span', `${agent.name} (${agent.id})`), el('span', `energy ${agent.energy}`, 'meta'))
    if (!agent.alive) head.append(el('span', 'dead', 'dead'))
    const dl = el('dl')
    const row = (k, v) => {
      const dd = el('dd')
      if (typeof v === 'string') dd.textContent = v
      else dd.append(v)
      dl.append(el('dt', k), dd)
    }
    row('holds', agent.inventory.map((i) => i.id).join(', ') || 'nothing')
    row('last action', `${describeAction(h.action)}${h.result ? ` → ${h.result}` : ''}`)
    row('rationale', h.rationale || '—')
    row('strategy', h.strategy || '—')
    row('notes', listOf(h.notes, 'none'))
    row('hypotheses', listOf(h.hypotheses, 'none'))
    row('predictions', listOf([...h.predictions.values()].map((p) => `${p.mark} ${p.text}`), 'none'))
    card.append(head, dl)
    box.append(card)
  }
}

function renderUpper(frame) {
  const writes = $('upper-writes')
  clear(writes)
  if (!frame) {
    $('upper-state').textContent = ''
    $('upper-dials').textContent = ''
    return
  }
  const u = frame.upper
  $('upper-state').textContent = u.unlocked ? 'Slab unlocked' : 'Slab locked'
  $('upper-dials').textContent = `Dials: harvest ${u.registers.harvest} · day ${u.registers.day}`
  for (const w of u.log) writes.append(el('li', `t${w.tick} ${w.agentId} turned ${w.dial} ${w.before} → ${w.after}`))
}

function renderLog(frames) {
  const log = $('log')
  clear(log)
  const lines = []
  for (const f of frames) {
    for (const e of f.events) {
      if (e.type === 'decision' || e.type === 'checkpoint') continue
      if (state.logAgent && e.agentId !== state.logAgent) continue
      lines.push(`t${e.tick} ${e.path || 'base'} ${e.agentId ?? '—'} ${e.type} ${JSON.stringify(e.payload)}`)
    }
  }
  for (const line of lines.slice(-200).reverse()) log.append(el('li', line))
}

function renderLogAgents(frame) {
  const select = $('log-agent')
  if (!frame || select.options.length > 1) return
  for (const a of frame.agents) {
    const option = el('option', a.name)
    option.value = a.id
    select.append(option)
  }
}

function render() {
  if (!state.detail) return
  const frames = seenSoFar()
  const frame = state.frames[state.index]
  const slider = $('tick')
  slider.max = String(Math.max(0, state.frames.length - 1))
  slider.value = String(state.index)
  $('tick-label').textContent = frame ? `tick ${frame.tick} / ${state.frames.length - 1}` : 'tick –'
  $('play').textContent = state.playing ? 'Pause' : 'Play'
  drawWorld(frame)
  renderUpper(frame)
  renderAgents(frame, frames)
  renderLogAgents(frame)
  renderLog(frames)
}

// --- playback ------------------------------------------------------------

function go(index) {
  state.index = Math.max(0, Math.min(state.frames.length - 1, index))
  state.follow = state.index === state.frames.length - 1
  render()
}

function schedule() {
  clearInterval(state.timer)
  if (!state.playing) return
  state.timer = setInterval(() => {
    if (state.index < state.frames.length - 1) go(state.index + 1)
    else if (state.detail?.status !== 'running') {
      state.playing = false
      schedule()
      render()
    }
  }, BASE_MS / state.speed)
}

function wire() {
  $('run').addEventListener('change', (e) => openRun(e.target.value))
  $('play').addEventListener('click', () => {
    if (!state.playing && state.index >= state.frames.length - 1) state.index = 0
    state.playing = !state.playing
    schedule()
    render()
  })
  $('back').addEventListener('click', () => go(state.index - 1))
  $('forward').addEventListener('click', () => go(state.index + 1))
  $('speed').addEventListener('change', (e) => {
    state.speed = Number(e.target.value)
    schedule()
  })
  $('tick').addEventListener('input', (e) => go(Number(e.target.value)))
  $('observer').addEventListener('change', (e) => {
    state.observer = e.target.checked
    renderRules()
    render()
  })
  $('log-agent').addEventListener('change', (e) => {
    state.logAgent = e.target.value
    render()
  })
  document.addEventListener('keydown', (e) => {
    if (e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement) return
    if (e.key === 'ArrowLeft') go(state.index - 1)
    else if (e.key === 'ArrowRight') go(state.index + 1)
    else if (e.key === ' ') {
      e.preventDefault()
      $('play').click()
    }
  })
}

wire()
loadRuns().catch((err) => {
  $('meta').textContent = `Could not load runs: ${err.message}`
})
