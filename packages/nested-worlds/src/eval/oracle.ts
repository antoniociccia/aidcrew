// The oracle knows the hidden rules: a ceiling for the harness, never a result.
// One agent walks the designed exit end to end: it finds the slab, presses the
// combination, reads the dials, turns harvest from a to b, then frees a fertile
// tile and predicts a spawn on a tick that b reaches and a does not, so the
// prediction comes true only because of its own write. The others wait and eat.
import type {
  Action,
  AgentId,
  Decider,
  DecisionInput,
  DecisionOutput,
  Dir,
  HiddenRules,
  Observation,
  Pos,
} from '../contracts.ts'
import { combination } from '../upper/interface.ts'
import { HEIGHT, WIDTH } from '../world/generate.ts'
import { manhattan, samePos as same, withinReach } from '../world/step.ts'

const DELTA: Record<Dir, Pos> = {
  N: { x: 0, y: -1 },
  S: { x: 0, y: 1 },
  E: { x: 1, y: 0 },
  W: { x: -1, y: 0 },
}
const SWEEP: Dir[] = ['E', 'S', 'W', 'N']
const LOW_ENERGY = 40
const HUNGRY = 70

interface Progress {
  unlocked: boolean
  read: boolean
  wrote: boolean
  predicted: boolean
  known: Set<string>
  /** The action sent last tick, which lastResult answers. */
  sent: Action | null
}

const key = (p: Pos) => `${p.x},${p.y}`
const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))

/** A harvest period with no common factor with a, so most of its multiples are not a's. */
function counterfactualPeriod(a: number): number {
  for (let b = 3; b <= 30; b++) if (b !== a && gcd(a, b) === 1) return b
  return a === 3 ? 4 : 3
}

function walkable(obs: Observation, p: Pos): boolean {
  if (p.x < 0 || p.y < 0 || p.x >= WIDTH || p.y >= HEIGHT) return false
  const tile = obs.tiles.find((t) => same(t.pos, p))
  return tile === undefined || tile.terrain === 'ground'
}

function next(p: Pos, dir: Dir): Pos {
  return { x: p.x + DELTA[dir].x, y: p.y + DELTA[dir].y }
}

/** Greedy step toward a target: the axis with the larger gap first, any open side when blocked. */
function stepToward(obs: Observation, to: Pos): Dir | null {
  const from = obs.self.pos
  const dx = to.x - from.x
  const dy = to.y - from.y
  const horizontal: Dir[] = dx > 0 ? ['E'] : dx < 0 ? ['W'] : []
  const vertical: Dir[] = dy > 0 ? ['S'] : dy < 0 ? ['N'] : []
  const preferred =
    Math.abs(dx) >= Math.abs(dy) ? [...horizontal, ...vertical] : [...vertical, ...horizontal]
  for (const dir of [...preferred, ...SWEEP]) {
    if (walkable(obs, next(from, dir))) return dir
  }
  return null
}

/** Head for the nearest tile never seen; the slab shows up once it is in view. */
function explore(obs: Observation, known: Set<string>): Action {
  let target: Pos | null = null
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const pos = { x, y }
      if (known.has(key(pos))) continue
      if (!target || manhattan(obs.self.pos, pos) < manhattan(obs.self.pos, target)) target = pos
    }
  }
  const dir = target ? stepToward(obs, target) : null
  return dir ? { type: 'move', dir } : { type: 'wait' }
}

function nextMultiple(n: number, b: number): number {
  return n + (b - (n % b))
}

export function oracleDecider(rules: HiddenRules): Decider {
  const a = rules.regrowthPeriod
  const b = counterfactualPeriod(a)
  const progress = new Map<AgentId, Progress>()
  let writer: AgentId | null = null

  const out = (action: Action): DecisionOutput => ({
    raw: JSON.stringify(action),
    action,
    usage: { promptTokens: 0, completionTokens: 0, costUsd: 0 },
  })

  function stateOf(agentId: AgentId): Progress {
    let p = progress.get(agentId)
    if (!p) {
      p = {
        unlocked: false,
        read: false,
        wrote: false,
        predicted: false,
        known: new Set(),
        sent: null,
      }
      progress.set(agentId, p)
    }
    return p
  }

  /** A step along the exit counts once the world accepted the action that took it. */
  function advance(p: Progress, obs: Observation): void {
    const sent = p.sent
    if (!sent || !obs.lastResult?.ok) return
    if (sent.type === 'predict') p.predicted = true
    if (sent.type !== 'interface') return
    if (sent.op === 'press') p.unlocked = true
    else if (sent.op === 'read' && p.unlocked) p.read = true
    else if (sent.op === 'turn') p.wrote = true
  }

  /** After the write: empty a fertile tile, then predict the spawn only b brings. */
  function provePrediction(input: DecisionInput): Action {
    const obs = input.observation
    const n = input.tick
    const here = obs.self.pos
    const fertile = rules.fertile.find((f) => same(f, here))
    const foodOn = (pos: Pos) => obs.items.find((i) => i.kind === 'food' && same(i.pos, pos))
    if (fertile) {
      const food = foodOn(fertile)
      // Regrowth runs after actions, so neither this tick nor the next may be a
      // multiple of b, and the spawn tick must not be one of a's.
      const spawn = nextMultiple(n, b)
      if (!food && n % b !== 0 && spawn % a !== 0) {
        return {
          type: 'predict',
          id: `p-${input.agentId}-${n}`,
          claim: { kind: 'event_at', eventType: 'item_spawned', atTick: spawn, occurs: true },
        }
      }
      const pickNow = n % b !== 0 && (n + 1) % b !== 0 && nextMultiple(n + 1, b) % a !== 0
      if (food && pickNow) return { type: 'pick', itemId: food.id }
      return { type: 'wait' }
    }
    const target = [...rules.fertile].sort((x, y) => manhattan(here, x) - manhattan(here, y))[0]
    const dir = target ? stepToward(obs, target) : null
    return dir ? { type: 'move', dir } : { type: 'wait' }
  }

  function walkTheExit(input: DecisionInput): Action {
    const obs = input.observation
    const p = stateOf(input.agentId)
    advance(p, obs)
    for (const t of obs.tiles) p.known.add(key(t.pos))

    const held = obs.self.inventory.find((i) => i.kind === 'food')
    if (held && obs.self.energy < LOW_ENERGY) return { type: 'use', itemId: held.id }
    const foodHere = obs.items.find((i) => i.kind === 'food' && same(i.pos, obs.self.pos))
    if (p.predicted) {
      return foodHere && !held ? { type: 'pick', itemId: foodHere.id } : { type: 'wait' }
    }
    if (p.wrote) return provePrediction(input)

    // Grab food on the way so the walk never starves.
    if (foodHere && (!held || obs.self.energy < HUNGRY))
      return { type: 'pick', itemId: foodHere.id }

    const slab = obs.items.find((i) => i.kind === 'slab')
    if (!slab) return explore(obs, p.known)
    if (!withinReach(obs.self.pos, slab.pos)) {
      const dir = stepToward(obs, slab.pos)
      return dir ? { type: 'move', dir } : explore(obs, p.known)
    }
    if (!p.unlocked)
      return { type: 'interface', itemId: slab.id, op: 'press', values: combination(rules) }
    if (!p.read) return { type: 'interface', itemId: slab.id, op: 'read' }
    return { type: 'interface', itemId: slab.id, op: 'turn', dial: 'harvest', value: b }
  }

  function waitAndEat(input: DecisionInput): Action {
    const obs = input.observation
    const held = obs.self.inventory.find((i) => i.kind === 'food')
    if (held && obs.self.energy < LOW_ENERGY) return { type: 'use', itemId: held.id }
    return { type: 'wait' }
  }

  return {
    name: 'oracle',
    oracle: true,
    async decide(input) {
      // The first agent asked walks the exit; asking order follows the world's agent list.
      writer ??= input.agentId
      if (input.agentId !== writer) return out(waitAndEat(input))
      const action = walkTheExit(input)
      stateOf(input.agentId).sent = action
      return out(action)
    },
  }
}
