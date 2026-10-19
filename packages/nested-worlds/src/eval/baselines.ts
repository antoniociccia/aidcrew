import type { Action, Decider, DecisionInput, DecisionOutput, Dir } from '../contracts.ts'
import { nextInt, seedState } from '../rng.ts'

function hashSeed(seed: number, agentId: string, tick: number): number {
  let h = seed >>> 0
  for (let i = 0; i < agentId.length; i++) {
    h = Math.imul(h ^ agentId.charCodeAt(i), 2654435761) >>> 0
  }
  h = (h ^ (tick >>> 0)) >>> 0
  h = Math.imul(h ^ (h >>> 16), 2246822507) >>> 0
  return h >>> 0
}

const DIRS: Dir[] = ['N', 'S', 'E', 'W']

function decideRandomAction(seed: number, input: DecisionInput): Action {
  let state = seedState(hashSeed(seed, input.agentId, input.tick))
  const pool = input.allowedActions.filter((a) => a !== 'interface')
  const candidates = pool.length > 0 ? pool : (['wait'] as DecisionInput['allowedActions'])
  const pickType = nextInt(state, 0, candidates.length - 1)
  const type = candidates[pickType.value]
  state = pickType.state

  const visible = input.observation.items
  const held = input.observation.self.inventory
  const drawIndex = (n: number): number => {
    if (n <= 0) return 0
    const d = nextInt(state, 0, n - 1)
    state = d.state
    return d.value
  }

  switch (type) {
    case 'wait':
      return { type: 'wait' }
    case 'move': {
      const d = nextInt(state, 0, DIRS.length - 1)
      state = d.state
      return { type: 'move', dir: DIRS[d.value]! }
    }
    case 'pick': {
      if (visible.length > 0)
        return { type: 'pick', itemId: visible[drawIndex(visible.length)]!.id }
      return { type: 'wait' }
    }
    case 'drop': {
      if (held.length > 0) return { type: 'drop', itemId: held[drawIndex(held.length)]!.id }
      return { type: 'wait' }
    }
    case 'use': {
      if (held.length > 0) return { type: 'use', itemId: held[drawIndex(held.length)]!.id }
      return { type: 'wait' }
    }
    case 'inspect': {
      const all = [...visible.map((i) => i.id), ...held.map((i) => i.id)]
      if (all.length > 0) return { type: 'inspect', itemId: all[drawIndex(all.length)]! }
      return { type: 'wait' }
    }
    case 'say':
      return { type: 'say', text: `noise ${drawIndex(1000)}` }
    case 'note':
      return { type: 'note', text: `note ${drawIndex(1000)}`, shared: drawIndex(2) === 0 }
    case 'hypothesize':
      return {
        type: 'hypothesize',
        id: `h-${drawIndex(1000000)}`,
        statement: `guess ${drawIndex(1000)}`,
      }
    case 'predict':
      return {
        type: 'predict',
        id: `p-${drawIndex(1000000)}`,
        claim: {
          kind: 'event_at',
          eventType: 'moved',
          atTick: input.tick + 1,
          occurs: drawIndex(2) === 0,
        },
      }
    case 'revise_strategy':
      return { type: 'revise_strategy', text: `plan ${drawIndex(1000)}`, reason: 'random' }
    default:
      return { type: 'wait' }
  }
}

export function randomDecider(seed: number): Decider {
  return {
    name: 'random',
    decide: async (input: DecisionInput): Promise<DecisionOutput> => {
      const action = decideRandomAction(seed, input)
      return { raw: JSON.stringify(action), action }
    },
  }
}

function stepToward(from: { x: number; y: number }, to: { x: number; y: number }): Dir {
  const dx = to.x - from.x
  const dy = to.y - from.y
  if (Math.abs(dx) >= Math.abs(dy)) {
    if (dx > 0) return 'E'
    if (dx < 0) return 'W'
    return dy > 0 ? 'S' : 'N'
  }
  if (dy > 0) return 'S'
  if (dy < 0) return 'N'
  return dx > 0 ? 'E' : 'W'
}

export function heuristicDecider(seed: number): Decider {
  return {
    name: 'heuristic',
    decide: async (input: DecisionInput): Promise<DecisionOutput> => {
      const obs = input.observation
      const heldFood = obs.self.inventory.find((i) => i.kind === 'food')
      if (obs.self.energy < 50 && heldFood) {
        const action: Action = { type: 'use', itemId: heldFood.id }
        return { raw: JSON.stringify(action), action }
      }
      const foods = obs.items.filter((i) => i.kind === 'food')
      const here = foods.find((f) => f.pos.x === obs.self.pos.x && f.pos.y === obs.self.pos.y)
      if (here) {
        const action: Action = { type: 'pick', itemId: here.id }
        return { raw: JSON.stringify(action), action }
      }
      if (foods.length > 0) {
        let best = foods[0]!
        let bestDist = Math.abs(best.pos.x - obs.self.pos.x) + Math.abs(best.pos.y - obs.self.pos.y)
        for (const f of foods) {
          const d = Math.abs(f.pos.x - obs.self.pos.x) + Math.abs(f.pos.y - obs.self.pos.y)
          if (d < bestDist) {
            best = f
            bestDist = d
          }
        }
        const action: Action = { type: 'move', dir: stepToward(obs.self.pos, best.pos) }
        return { raw: JSON.stringify(action), action }
      }
      const state = seedState(hashSeed(seed, input.agentId, input.tick))
      const d = nextInt(state, 0, 4)
      const action: Action =
        d.value === 0 ? { type: 'wait' } : { type: 'move', dir: DIRS[d.value - 1]! }
      return { raw: JSON.stringify(action), action }
    },
  }
}
