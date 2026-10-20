// The level above, fully simulated: it owns the base world, feeds it params
// from its registers each tick, and answers what the base world asks of it.
import type {
  Action,
  AgentId,
  UpperState,
  WorldEvent,
  WorldParams,
  WorldState,
} from '../contracts.ts'
import { type ActionResult, killAgent, stepWorld } from '../world/step.ts'
import { answer, initialUpper } from './interface.ts'

export interface HostStep {
  events: WorldEvent[]
  results: Map<AgentId, ActionResult>
}

export interface Host {
  readonly base: WorldState
  readonly upper: UpperState
  params(): WorldParams
  step(actions: Map<AgentId, Action>): HostStep
}

export function createHost(base: WorldState, upper: UpperState = initialUpper(base.rules)): Host {
  let b = base
  let u = upper
  const params = (): WorldParams => ({
    regrowthPeriod: u.registers.harvest,
    dayLength: u.registers.day,
  })
  return {
    get base() {
      return b
    },
    get upper() {
      return u
    },
    params,
    step(actions) {
      const r = stepWorld(b, params(), actions)
      b = r.state
      const events: Omit<WorldEvent, 'seq'>[] = [...r.events]
      const results = new Map(r.results)
      for (const req of r.requests) {
        const a = answer(u, b.rules, req)
        u = a.upper
        events.push(...a.events)
        results.set(req.agentId, a.result)
        if (a.penalty > 0) penalise(b, req.agentId, a.penalty, req.tick, events)
      }
      u = { ...u, tick: b.tick }
      return { events: events.map((e, seq) => ({ ...e, seq })), results }
    },
  }
}

function penalise(
  base: WorldState,
  agentId: AgentId,
  amount: number,
  tick: number,
  events: Omit<WorldEvent, 'seq'>[],
): void {
  const agent = base.agents.find((a) => a.id === agentId)
  if (!agent?.alive) return
  const emit = (type: WorldEvent['type'], id: AgentId | null, payload: Record<string, unknown>) =>
    events.push({ tick, path: base.path, type, agentId: id, payload })
  const before = agent.energy
  agent.energy = Math.max(0, before - amount)
  emit('energy_changed', agent.id, { before, after: agent.energy, cause: 'slab' })
  if (agent.energy === 0) killAgent({ state: base, emit }, agent)
}
