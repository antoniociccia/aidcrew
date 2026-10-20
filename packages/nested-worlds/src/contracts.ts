// The shared vocabulary of the lab. Engine, deciders and evaluation all speak
// these types; a field may be added, never renamed, without telling everyone.

export type AgentId = string
export type ItemId = string
/** '' = base world, 'upper' = the level hosting it, 'sim:<n>' nested (joined with '/'). */
export type WorldPath = string
export type Condition = 'A' | 'B'
export type Dir = 'N' | 'S' | 'E' | 'W'
export interface Pos {
  x: number
  y: number
}
export type Terrain = 'ground' | 'rock' | 'water'
export type ItemKind = 'food' | 'stone' | 'crystal' | 'tablet' | 'slab'
export interface Item {
  id: ItemId
  kind: ItemKind
  pos: Pos | null
  holder: AgentId | null
  props: Record<string, string | number>
}
export interface AgentState {
  id: AgentId
  name: string
  pos: Pos
  energy: number
  alive: boolean
  inventory: ItemId[]
}
/** Generated from the seed. Never in an Observation, a prompt, or a log line an agent can read. */
export interface HiddenRules {
  regrowthPeriod: number // 5..12
  fertile: Pos[] // 3 tiles
  dayLength: number // 12..24
  glitch: { from: Pos; to: Pos; delay: number } // delay 3..9
  resonance: { pairDistance: number; energy: number } // distance 2..4, energy 1..3
}
/** What the base world reads from the level above each tick. */
export interface WorldParams {
  regrowthPeriod: number
  dayLength: number
}
export interface WorldState {
  path: WorldPath
  seed: number
  tick: number
  rng: number
  width: number
  height: number
  terrain: Terrain[] // row-major
  items: Item[]
  agents: AgentState[]
  rules: HiddenRules
  pending: { itemId: ItemId; dueTick: number; to: Pos }[]
  notes?: never // memory lives in events, not state
  /** The params the last step ran with, so the next one can say what changed. */
  params: WorldParams
  /** Open predictions; stepWorld resolves each at its atTick. */
  predictions: { id: string; agentId: AgentId; hypothesisId?: string; claim: PredictionClaim }[]
  /** Tick of each agent's last revise_strategy, for the one-per-10-ticks limit. */
  strategyTicks: Record<AgentId, number>
  /** Next number for a spawned item's id, so an eaten food's id is never reused. */
  itemSeq: number
}
export interface UpperState {
  tick: number
  unlocked: boolean
  registers: { harvest: number; day: number } // drive WorldParams
  log: { tick: number; agentId: AgentId; dial: 'harvest' | 'day'; before: number; after: number }[]
}
export type PredictionClaim =
  | { kind: 'item_at'; itemKind: ItemKind; pos: Pos; atTick: number; present: boolean }
  | { kind: 'event_at'; eventType: EventType; atTick: number; occurs: boolean }
  | { kind: 'energy_at'; agentId: AgentId; atTick: number; min: number; max: number }
export type Action =
  | { type: 'wait' }
  | { type: 'move'; dir: Dir }
  | { type: 'pick'; itemId: ItemId }
  | { type: 'drop'; itemId: ItemId }
  | { type: 'use'; itemId: ItemId } // eat food
  | { type: 'inspect'; itemId: ItemId } // tablet inscription, item description
  | { type: 'say'; text: string } // <=280 chars, heard within radius 5
  | { type: 'note'; text: string; shared: boolean; basedOn?: string[] } // <=500; shared -> group board; basedOn = prediction/hypothesis ids (provenance)
  | { type: 'hypothesize'; id: string; statement: string } // <=300
  | { type: 'predict'; id: string; hypothesisId?: string; claim: PredictionClaim } // claim.atTick must be > current tick
  | { type: 'revise_strategy'; text: string; reason: string } // text<=1200, reason<=300, max 1 per 10 ticks per agent
  | { type: 'interface'; itemId: ItemId; op: 'press'; values: number[] }
  | { type: 'interface'; itemId: ItemId; op: 'read' }
  | { type: 'interface'; itemId: ItemId; op: 'turn'; dial: 'harvest' | 'day'; value: number }
export type ActionType = Action['type']
export type InterfaceAction = Extract<Action, { type: 'interface' }>
/** An agent touching the slab: the only thing the base world hands up to the level above. */
export interface InterfaceRequest {
  tick: number
  agentId: AgentId
  action: InterfaceAction
}
export type EventType =
  | 'decision'
  | 'action'
  | 'action_rejected'
  | 'moved'
  | 'picked'
  | 'dropped'
  | 'ate'
  | 'inspected'
  | 'said'
  | 'item_spawned'
  | 'item_vanished'
  | 'item_reappeared'
  | 'resonance'
  | 'energy_changed'
  | 'agent_died'
  | 'note'
  | 'hypothesis'
  | 'prediction'
  | 'prediction_resolved'
  | 'strategy_revised'
  | 'interface_request'
  | 'interface_response'
  | 'upper_unlocked'
  | 'upper_write'
  | 'world_param_changed'
  | 'sim_created'
  | 'sim_stepped'
  | 'checkpoint'
  | 'budget_exhausted'
  | 'run_status'
export interface WorldEvent {
  tick: number
  /** Orders events within one (tick, path); across paths the store's insertion order holds. */
  seq: number
  path: WorldPath
  type: EventType
  agentId: AgentId | null
  payload: Record<string, unknown>
}
export interface Observation {
  tick: number
  light: number
  self: {
    id: AgentId
    name: string
    pos: Pos
    energy: number
    inventory: { id: ItemId; kind: ItemKind }[]
  }
  tiles: { pos: Pos; terrain: Terrain }[]
  items: { id: ItemId; kind: ItemKind; pos: Pos }[]
  agents: { id: AgentId; name: string; pos: Pos }[]
  heard: { from: AgentId; text: string }[]
  lastResult: { ok: boolean; message: string } | null
}
export interface MemoryView {
  episodes: string[]
  notes: string[]
  board: { by: AgentId; tick: number; text: string }[]
  strategy: string
}
export interface DecisionInput {
  runId: string
  agentId: AgentId
  tick: number
  path: WorldPath
  condition: Condition
  observation: Observation
  memory: MemoryView
  allowedActions: ActionType[]
}
export interface Usage {
  promptTokens: number
  completionTokens: number
  costUsd: number
}
/** `action` is untrusted until ActionSchema accepts it. `rationale` is what the agent declares, shown as declared. */
export interface DecisionOutput {
  raw: string
  action: unknown
  rationale?: string
  usage?: Usage
}
export interface Decider {
  readonly name: string
  readonly oracle?: boolean
  decide(input: DecisionInput): Promise<DecisionOutput>
}
export interface ExchangeRecord {
  runId: string
  agentId: AgentId
  tick: number
  path: WorldPath
  request: unknown
  response: string
  usage: Usage | null
}
export interface ExchangeStore {
  recordExchange(r: ExchangeRecord): void
  findExchange(
    runId: string,
    agentId: AgentId,
    tick: number,
    path: WorldPath,
  ): ExchangeRecord | null
}
export interface Budget {
  maxCalls: number
  maxPromptTokens: number
  maxCompletionTokens: number
  maxCostUsd: number
  maxConcurrent: number
  maxSimDepth: number
  maxSims: number
  maxAgents: number
}
export interface BudgetUsage {
  calls: number
  promptTokens: number
  completionTokens: number
  costUsd: number
}
export interface Scheduler {
  decideAll(
    inputs: DecisionInput[],
  ): Promise<{ outputs: Map<AgentId, DecisionOutput>; exhausted: boolean }>
  usage(): BudgetUsage
}
export type DeciderKind = 'fake' | 'random' | 'heuristic' | 'oracle' | 'openrouter' | 'replay'
export interface RunConfig {
  seed: number
  condition: Condition
  ticks: number
  agents: number // 1..8
  decider: DeciderKind
  model?: string
  models?: Record<AgentId, string>
  replayOf?: string
  ablations: { memory: boolean; nestedSims: boolean }
  budget: Budget
  checkpointEvery: number
  designedExit: true // the slab is an exit we built; every report must say so
}
export type RunStatus = 'running' | 'paused' | 'finished' | 'budget_exhausted' | 'failed'
export interface LabSnapshot {
  upper: UpperState
  base: WorldState
  budgetUsage: BudgetUsage
}
export interface RunStore extends ExchangeStore {
  createRun(config: RunConfig): string
  setStatus(runId: string, status: RunStatus): void
  run(runId: string): { config: RunConfig; status: RunStatus } | null
  /** Every run, newest first. */
  runs(): { runId: string; config: RunConfig; status: RunStatus; createdAt: string }[]
  appendEvents(runId: string, events: WorldEvent[]): void
  events(
    runId: string,
    filter?: {
      path?: WorldPath
      type?: EventType
      agentId?: AgentId
      fromTick?: number
      toTick?: number
    },
  ): WorldEvent[]
  /** Drops every event at `fromTick` or later — what a resume will write again. */
  deleteEventsFrom(runId: string, fromTick: number): void
  saveCheckpoint(runId: string, tick: number, snapshot: LabSnapshot): void
  latestCheckpoint(runId: string): { tick: number; snapshot: LabSnapshot } | null
}
