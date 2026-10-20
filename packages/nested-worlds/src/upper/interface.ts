// The slab, seen from above. This is the only channel from the base world up:
// a request comes in, a sentence goes back, and a register may change.
import type { HiddenRules, InterfaceRequest, UpperState, WorldEvent } from '../contracts.ts'
import type { ActionResult } from '../world/step.ts'

export const WRONG_PRESS_PENALTY = 5
export const UPPER_PATH = 'upper'

export interface Answer {
  upper: UpperState
  events: Omit<WorldEvent, 'seq'>[]
  result: ActionResult
  /** Energy the requesting agent loses for it. */
  penalty: number
}

export function initialUpper(rules: HiddenRules): UpperState {
  return {
    tick: 0,
    unlocked: false,
    registers: { harvest: rules.regrowthPeriod, day: rules.dayLength },
    log: [],
  }
}

function dials(upper: UpperState): string {
  return `Dials: harvest=${upper.registers.harvest}, day=${upper.registers.day}.`
}

/** The combination is the seed's hidden truth, not whatever the dials now say. */
export function combination(rules: HiddenRules): number[] {
  return [rules.regrowthPeriod, rules.glitch.delay, rules.dayLength]
}

export function answer(input: UpperState, rules: HiddenRules, req: InterfaceRequest): Answer {
  const upper = structuredClone(input)
  const events: Answer['events'] = []
  const emit = (type: WorldEvent['type'], payload: Record<string, unknown>) =>
    events.push({ tick: req.tick, path: UPPER_PATH, type, agentId: req.agentId, payload })
  const reply = (result: ActionResult, penalty = 0): Answer => {
    emit('interface_response', { op: req.action.op, ok: result.ok, message: result.message })
    return { upper, events, result, penalty }
  }
  const a = req.action
  switch (a.op) {
    case 'press': {
      const want = combination(rules)
      const right = a.values.length === want.length && a.values.every((v, i) => v === want[i])
      if (!right) return reply({ ok: false, message: 'The slab is silent.' }, WRONG_PRESS_PENALTY)
      if (!upper.unlocked) {
        upper.unlocked = true
        emit('upper_unlocked', { values: a.values })
      }
      return reply({ ok: true, message: `The slab opens. ${dials(upper)}` })
    }
    case 'read':
      return reply(
        upper.unlocked
          ? { ok: true, message: dials(upper) }
          : { ok: true, message: 'The slab is smooth and cold.' },
      )
    case 'turn': {
      if (!upper.unlocked) return reply({ ok: false, message: 'The slab does not move.' })
      if (!Number.isInteger(a.value) || a.value < 2 || a.value > 30) {
        return reply({ ok: false, message: 'The dial will not go there.' })
      }
      const before = upper.registers[a.dial]
      upper.registers[a.dial] = a.value
      upper.log.push({ tick: req.tick, agentId: req.agentId, dial: a.dial, before, after: a.value })
      emit('upper_write', { dial: a.dial, before, after: a.value })
      return reply({ ok: true, message: `The ${a.dial} dial turns. ${dials(upper)}` })
    }
  }
}
