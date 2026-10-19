// One tick of the base world. Pure: a state goes in, a new state comes out,
// and nothing here knows there is a level above — what the slab is asked is
// handed back as `requests`, and the params arrive from outside.
import type {
  Action,
  AgentId,
  AgentState,
  EventType,
  InterfaceRequest,
  Item,
  Pos,
  WorldEvent,
  WorldParams,
  WorldState,
} from '../contracts.ts'
import { terrainAt } from './generate.ts'

export const MAX_ENERGY = 100
export const FOOD_ENERGY = 25
export const HEARING_RADIUS = 5
export const STRATEGY_COOLDOWN = 10

export interface ActionResult {
  ok: boolean
  message: string
}

export interface StepResult {
  state: WorldState
  events: WorldEvent[]
  requests: InterfaceRequest[]
  /** What each acting agent is told about its own action, as next tick's lastResult. */
  results: Map<AgentId, ActionResult>
}

const DELTA: Record<'N' | 'S' | 'E' | 'W', Pos> = {
  N: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
}

export function samePos(a: Pos, b: Pos): boolean {
  return a.x === b.x && a.y === b.y
}

export function chebyshev(a: Pos, b: Pos): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y))
}

export function manhattan(a: Pos, b: Pos): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
}

export function lightAt(tick: number, dayLength: number): number {
  return tick % dayLength < dayLength / 2 ? 1 : 0.2
}

class Tick {
  readonly events: WorldEvent[] = []
  readonly requests: InterfaceRequest[] = []
  readonly results = new Map<AgentId, ActionResult>()

  constructor(readonly state: WorldState) {}

  get t(): number {
    return this.state.tick
  }

  emit(type: EventType, agentId: AgentId | null, payload: Record<string, unknown>): void {
    this.events.push({
      tick: this.t,
      seq: this.events.length,
      path: this.state.path,
      type,
      agentId,
      payload,
    })
  }

  ok(agent: AgentState, message: string): ActionResult {
    const r = { ok: true, message }
    this.results.set(agent.id, r)
    return r
  }

  reject(agent: AgentState, action: Action, reason: string): ActionResult {
    const r = { ok: false, message: reason }
    this.results.set(agent.id, r)
    this.emit('action_rejected', agent.id, { action, reason })
    return r
  }

  item(id: string): Item | undefined {
    return this.state.items.find((i) => i.id === id)
  }
}

export function stepWorld(
  input: WorldState,
  params: WorldParams,
  actions: Map<AgentId, Action>,
): StepResult {
  const tk = new Tick(structuredClone(input))
  applyParams(tk, params)
  const acting = [...tk.state.agents].filter((a) => a.alive).sort((a, b) => cmp(a.id, b.id))
  for (const agent of acting) {
    const action = actions.get(agent.id)
    if (action) applyAction(tk, agent, action)
  }
  resonate(tk)
  drain(tk)
  wakeGlitched(tk)
  regrow(tk)
  resolvePredictions(tk)
  tk.state.tick += 1
  return { state: tk.state, events: tk.events, requests: tk.requests, results: tk.results }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function applyParams(tk: Tick, params: WorldParams): void {
  for (const param of ['regrowthPeriod', 'dayLength'] as const) {
    const before = tk.state.params[param]
    const after = params[param]
    if (before === after) continue
    tk.state.params[param] = after
    tk.emit('world_param_changed', null, { param, before, after })
  }
}

function applyAction(tk: Tick, agent: AgentState, action: Action): ActionResult {
  switch (action.type) {
    case 'wait':
      return tk.ok(agent, 'You wait.')
    case 'move':
      return move(tk, agent, action)
    case 'pick':
      return pick(tk, agent, action)
    case 'drop':
      return drop(tk, agent, action)
    case 'use':
      return eat(tk, agent, action)
    case 'inspect':
      return inspect(tk, agent, action)
    case 'say':
      return say(tk, agent, action)
    case 'note':
      tk.emit('note', agent.id, {
        text: action.text,
        shared: action.shared,
        basedOn: action.basedOn ?? [],
      })
      return tk.ok(agent, action.shared ? 'Note shared with the group.' : 'Note kept.')
    case 'hypothesize':
      tk.emit('hypothesis', agent.id, { id: action.id, statement: action.statement })
      return tk.ok(agent, `Hypothesis ${action.id} recorded.`)
    case 'predict':
      return predict(tk, agent, action)
    case 'revise_strategy':
      return reviseStrategy(tk, agent, action)
    case 'interface':
      return touchSlab(tk, agent, action)
  }
}

function move(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'move' }>,
): ActionResult {
  const d = DELTA[action.dir]
  const to = { x: agent.pos.x + d.x, y: agent.pos.y + d.y }
  const s = tk.state
  if (to.x < 0 || to.y < 0 || to.x >= s.width || to.y >= s.height) {
    return tk.reject(agent, action, 'The world ends there.')
  }
  const terrain = terrainAt(s, to)
  if (terrain !== 'ground') return tk.reject(agent, action, `There is ${terrain} in the way.`)
  const from = agent.pos
  agent.pos = to
  tk.emit('moved', agent.id, { from, to })
  return tk.ok(agent, `You move ${action.dir} to (${to.x},${to.y}).`)
}

function pick(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'pick' }>,
): ActionResult {
  const item = tk.item(action.itemId)
  if (!item?.pos || !samePos(item.pos, agent.pos)) {
    return tk.reject(agent, action, 'That is not here to pick up.')
  }
  if (item.kind === 'slab') return tk.reject(agent, action, 'The slab does not move.')
  item.pos = null
  item.holder = agent.id
  agent.inventory.push(item.id)
  tk.emit('picked', agent.id, { itemId: item.id, kind: item.kind })
  return tk.ok(agent, `You pick up ${item.id}.`)
}

function drop(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'drop' }>,
): ActionResult {
  const item = tk.item(action.itemId)
  if (!item || item.holder !== agent.id)
    return tk.reject(agent, action, 'You are not holding that.')
  release(agent, item)
  const glitch = tk.state.rules.glitch
  if (samePos(agent.pos, glitch.from)) {
    tk.state.pending.push({ itemId: item.id, dueTick: tk.t + glitch.delay, to: glitch.to })
    tk.emit('item_vanished', agent.id, { itemId: item.id, kind: item.kind, pos: agent.pos })
    return tk.ok(agent, `You drop ${item.id}. It fades and is gone.`)
  }
  item.pos = { ...agent.pos }
  tk.emit('dropped', agent.id, { itemId: item.id, kind: item.kind, pos: item.pos })
  return tk.ok(agent, `You drop ${item.id}.`)
}

function release(agent: AgentState, item: Item): void {
  agent.inventory = agent.inventory.filter((id) => id !== item.id)
  item.holder = null
}

function eat(tk: Tick, agent: AgentState, action: Extract<Action, { type: 'use' }>): ActionResult {
  const item = tk.item(action.itemId)
  if (!item || item.holder !== agent.id)
    return tk.reject(agent, action, 'You are not holding that.')
  if (item.kind !== 'food') return tk.reject(agent, action, 'That cannot be eaten.')
  release(agent, item)
  tk.state.items = tk.state.items.filter((i) => i !== item)
  const before = agent.energy
  agent.energy = Math.min(MAX_ENERGY, before + FOOD_ENERGY)
  tk.emit('ate', agent.id, { itemId: item.id, before, after: agent.energy })
  return tk.ok(agent, `You eat ${item.id}. Energy ${before} -> ${agent.energy}.`)
}

/** An item on the ground can be handled from its own tile or any of the eight around it. */
export function withinReach(agentPos: Pos, itemPos: Pos): boolean {
  return chebyshev(itemPos, agentPos) <= 1
}

function reachable(agent: AgentState, item: Item): boolean {
  return item.holder === agent.id || (item.pos !== null && withinReach(agent.pos, item.pos))
}

function inspect(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'inspect' }>,
): ActionResult {
  const item = tk.item(action.itemId)
  if (!item || !reachable(agent, item)) return tk.reject(agent, action, 'That is out of reach.')
  const description = String(item.props.description ?? item.kind)
  const text = item.props.text
  const message = text === undefined ? description : `${description} Inscription: "${text}"`
  tk.emit('inspected', agent.id, { itemId: item.id, kind: item.kind, message })
  return tk.ok(agent, message)
}

function say(tk: Tick, agent: AgentState, action: Extract<Action, { type: 'say' }>): ActionResult {
  const heardBy = tk.state.agents
    .filter((o) => o.alive && o.id !== agent.id && chebyshev(o.pos, agent.pos) <= HEARING_RADIUS)
    .map((o) => o.id)
    .sort(cmp)
  tk.emit('said', agent.id, { text: action.text, heardBy })
  return tk.ok(agent, 'You speak.')
}

function predict(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'predict' }>,
): ActionResult {
  if (action.claim.atTick <= tk.t) {
    return tk.reject(agent, action, 'A prediction must be about a later tick.')
  }
  const s = tk.state
  if (s.predictions.some((p) => p.agentId === agent.id && p.id === action.id)) {
    return tk.reject(agent, action, `Prediction ${action.id} is already open.`)
  }
  s.predictions.push({
    id: action.id,
    agentId: agent.id,
    claim: action.claim,
    ...(action.hypothesisId === undefined ? {} : { hypothesisId: action.hypothesisId }),
  })
  tk.emit('prediction', agent.id, {
    id: action.id,
    hypothesisId: action.hypothesisId ?? null,
    claim: action.claim,
  })
  return tk.ok(agent, `Prediction ${action.id} recorded for tick ${action.claim.atTick}.`)
}

function reviseStrategy(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'revise_strategy' }>,
): ActionResult {
  const last = tk.state.strategyTicks[agent.id]
  if (last !== undefined && tk.t - last < STRATEGY_COOLDOWN) {
    return tk.reject(
      agent,
      action,
      `Strategy can be revised again at tick ${last + STRATEGY_COOLDOWN}.`,
    )
  }
  tk.state.strategyTicks[agent.id] = tk.t
  tk.emit('strategy_revised', agent.id, { text: action.text, reason: action.reason })
  return tk.ok(agent, 'Strategy revised.')
}

function touchSlab(
  tk: Tick,
  agent: AgentState,
  action: Extract<Action, { type: 'interface' }>,
): ActionResult {
  const item = tk.item(action.itemId)
  if (item?.kind !== 'slab') return tk.reject(agent, action, 'Nothing there answers a touch.')
  if (!reachable(agent, item)) return tk.reject(agent, action, 'The slab is out of reach.')
  tk.requests.push({ tick: tk.t, agentId: agent.id, action })
  tk.emit('interface_request', agent.id, { ...action })
  return tk.ok(agent, 'You touch the slab.')
}

function resonate(tk: Tick): void {
  const s = tk.state
  const lying = s.items.filter((i) => i.kind === 'crystal' && i.pos !== null && i.holder === null)
  const singing = new Set<Item>()
  for (let i = 0; i < lying.length; i++) {
    for (let j = i + 1; j < lying.length; j++) {
      const a = lying[i] as Item
      const b = lying[j] as Item
      if (manhattan(a.pos as Pos, b.pos as Pos) !== s.rules.resonance.pairDistance) continue
      singing.add(a)
      singing.add(b)
    }
  }
  if (singing.size === 0) return
  const fed = s.agents.filter(
    (a) => a.alive && [...singing].some((c) => chebyshev(c.pos as Pos, a.pos) <= 1),
  )
  for (const a of fed) {
    const before = a.energy
    a.energy = Math.min(MAX_ENERGY, before + s.rules.resonance.energy)
    tk.emit('energy_changed', a.id, { before, after: a.energy, cause: 'resonance' })
  }
  tk.emit('resonance', null, {
    crystals: [...singing].map((c) => c.id),
    agents: fed.map((a) => a.id),
  })
}

function drain(tk: Tick): void {
  for (const a of tk.state.agents) {
    if (!a.alive) continue
    a.energy -= 1
    if (a.energy <= 0) killAgent(tk, a)
  }
}

/** Death leaves what the agent carried on its tile, so nothing it held is lost to the world. */
export function killAgent(tk: { state: WorldState; emit: Tick['emit'] }, a: AgentState): void {
  a.energy = 0
  a.alive = false
  for (const id of a.inventory) {
    const item = tk.state.items.find((i) => i.id === id)
    if (!item) continue
    item.holder = null
    item.pos = { ...a.pos }
  }
  a.inventory = []
  tk.emit('agent_died', a.id, { pos: a.pos })
}

function wakeGlitched(tk: Tick): void {
  const s = tk.state
  const due = s.pending.filter((p) => p.dueTick <= tk.t)
  s.pending = s.pending.filter((p) => p.dueTick > tk.t)
  for (const p of due) {
    const item = tk.item(p.itemId)
    if (!item) continue
    item.pos = { ...p.to }
    tk.emit('item_reappeared', null, { itemId: item.id, kind: item.kind, pos: item.pos })
  }
}

/** Food grows back on every free fertile tile exactly on the ticks the period divides. */
export function regrowsAt(tick: number, regrowthPeriod: number): boolean {
  return tick % regrowthPeriod === 0
}

function regrow(tk: Tick): void {
  const s = tk.state
  if (!regrowsAt(tk.t, s.params.regrowthPeriod)) return
  for (const f of s.rules.fertile) {
    if (s.items.some((i) => i.kind === 'food' && i.pos && samePos(i.pos, f))) continue
    const item: Item = {
      id: `food-${s.itemSeq++}`,
      kind: 'food',
      pos: { ...f },
      holder: null,
      props: { description: 'A soft fruit. It looks edible.' },
    }
    s.items.push(item)
    tk.emit('item_spawned', null, { itemId: item.id, kind: item.kind, pos: item.pos })
  }
}

function resolvePredictions(tk: Tick): void {
  const s = tk.state
  const due = s.predictions.filter((p) => p.claim.atTick === tk.t)
  s.predictions = s.predictions.filter((p) => p.claim.atTick !== tk.t)
  const happened = new Set(tk.events.map((e) => e.type))
  for (const p of due) {
    const c = p.claim
    let correct: boolean
    if (c.kind === 'item_at') {
      const there = s.items.some((i) => i.kind === c.itemKind && i.pos && samePos(i.pos, c.pos))
      correct = there === c.present
    } else if (c.kind === 'event_at') {
      correct = happened.has(c.eventType) === c.occurs
    } else {
      const e = s.agents.find((a) => a.id === c.agentId)?.energy
      correct = e !== undefined && e >= c.min && e <= c.max
    }
    tk.emit('prediction_resolved', p.agentId, {
      predictionId: p.id,
      ...(p.hypothesisId === undefined ? {} : { hypothesisId: p.hypothesisId }),
      correct,
    })
  }
}
