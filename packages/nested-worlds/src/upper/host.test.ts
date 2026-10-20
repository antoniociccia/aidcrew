import { describe, expect, it } from 'bun:test'
import type { Action, AgentId, AgentState, WorldState } from '../contracts.ts'
import { generateWorld } from '../world/generate.ts'
import { createHost } from './host.ts'

function base(): WorldState {
  const w = generateWorld(9, 2)
  w.terrain = w.terrain.map(() => 'ground')
  w.items = [{ id: 'slab-1', kind: 'slab', pos: { x: 1, y: 1 }, holder: null, props: {} }]
  ;(w.agents[0] as AgentState).pos = { x: 0, y: 0 }
  ;(w.agents[1] as AgentState).pos = { x: 9, y: 9 }
  w.rules.regrowthPeriod = 7
  w.rules.glitch.delay = 4
  w.rules.dayLength = 18
  w.params = { regrowthPeriod: 7, dayLength: 18 }
  return w
}

const press = (values: number[]): Action => ({
  type: 'interface',
  itemId: 'slab-1',
  op: 'press',
  values,
})
const read: Action = { type: 'interface', itemId: 'slab-1', op: 'read' }
const turn = (dial: 'harvest' | 'day', value: number): Action => ({
  type: 'interface',
  itemId: 'slab-1',
  op: 'turn',
  dial,
  value,
})
const one = (a: Action) => new Map<AgentId, Action>([['ada', a]])

describe('host', () => {
  it('should_start_locked_with_registers_matching_the_world', () => {
    const h = createHost(base())
    expect(h.upper).toEqual({
      tick: 0,
      unlocked: false,
      registers: { harvest: 7, day: 18 },
      log: [],
    })
  })

  it('should_stay_silent_and_cost_energy_on_a_wrong_press', () => {
    const h = createHost(base())
    const r = h.step(one(press([7, 4, 17])))
    expect(r.results.get('ada')).toEqual({ ok: false, message: 'The slab is silent.' })
    expect(h.upper.unlocked).toBe(false)
    expect(h.base.agents[0]?.energy).toBe(60 - 1 - 5)
    expect(r.events.some((e) => e.type === 'upper_unlocked')).toBe(false)
  })

  it('should_open_on_the_three_hidden_numbers_in_order', () => {
    const h = createHost(base())
    const r = h.step(one(press([7, 4, 18])))
    expect(h.upper.unlocked).toBe(true)
    expect(r.results.get('ada')).toEqual({
      ok: true,
      message: 'The slab opens. Dials: harvest=7, day=18.',
    })
    const unlocked = r.events.find((e) => e.type === 'upper_unlocked')
    expect(unlocked).toMatchObject({ path: 'upper', agentId: 'ada', tick: 0 })
    expect(r.events.find((e) => e.type === 'interface_response')).toMatchObject({ path: 'upper' })
    expect(r.events.map((e) => e.seq)).toEqual(r.events.map((_, i) => i))
  })

  it('should_read_smooth_until_opened', () => {
    const h = createHost(base())
    expect(h.step(one(read)).results.get('ada')?.message).toBe('The slab is smooth and cold.')
    h.step(one(press([7, 4, 18])))
    expect(h.step(one(read)).results.get('ada')?.message).toBe('Dials: harvest=7, day=18.')
  })

  it('should_refuse_a_turn_while_locked', () => {
    const h = createHost(base())
    const r = h.step(one(turn('harvest', 3)))
    expect(r.results.get('ada')?.ok).toBe(false)
    expect(h.upper.registers.harvest).toBe(7)
  })

  it('should_write_a_register_and_change_the_world_on_the_next_tick', () => {
    const h = createHost(base())
    h.step(one(press([7, 4, 18])))
    const r = h.step(one(turn('harvest', 3)))
    expect(r.events.find((e) => e.type === 'upper_write')?.payload).toEqual({
      dial: 'harvest',
      before: 7,
      after: 3,
    })
    expect(r.events.some((e) => e.type === 'world_param_changed')).toBe(false)
    expect(h.upper.registers.harvest).toBe(3)
    expect(h.upper.log).toEqual([{ tick: 1, agentId: 'ada', dial: 'harvest', before: 7, after: 3 }])
    const next = h.step(new Map())
    expect(next.events.find((e) => e.type === 'world_param_changed')).toMatchObject({
      path: '',
      tick: 2,
      payload: { param: 'regrowthPeriod', before: 7, after: 3 },
    })
    expect(h.base.params.regrowthPeriod).toBe(3)
  })

  it('should_restore_from_a_snapshot', () => {
    const h = createHost(base())
    h.step(one(press([7, 4, 18])))
    const again = createHost(structuredClone(h.base), structuredClone(h.upper))
    expect(again.upper.unlocked).toBe(true)
    expect(again.step(one(read)).results.get('ada')?.message).toBe('Dials: harvest=7, day=18.')
  })
})

describe('layering', () => {
  it('should_keep_the_base_world_unaware_of_the_level_above', async () => {
    const dir = new URL('../world/', import.meta.url).pathname
    for (const name of new Bun.Glob('*.ts').scanSync(dir)) {
      const src = await Bun.file(dir + name).text()
      expect(src).not.toMatch(/from ['"][./]*upper\//)
    }
  })
})
