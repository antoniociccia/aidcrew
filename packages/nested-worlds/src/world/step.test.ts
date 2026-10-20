import { describe, expect, it } from 'bun:test'
import type {
  Action,
  AgentId,
  AgentState,
  Item,
  ItemKind,
  Pos,
  WorldParams,
  WorldState,
} from '../contracts.ts'
import { generateWorld } from './generate.ts'
import { lightAt, stepWorld } from './step.ts'

/** A flat world with known rules: everything a test needs is placed by hand. */
function blank(agents = 2): WorldState {
  const w = generateWorld(1, agents)
  w.terrain = w.terrain.map(() => 'ground')
  w.items = []
  w.agents.forEach((a, i) => {
    a.pos = { x: i, y: 0 }
  })
  w.rules = {
    regrowthPeriod: 6,
    fertile: [
      { x: 10, y: 10 },
      { x: 11, y: 10 },
      { x: 10, y: 11 },
    ],
    dayLength: 12,
    glitch: { from: { x: 5, y: 5 }, to: { x: 8, y: 8 }, delay: 4 },
    resonance: { pairDistance: 3, energy: 2 },
  }
  w.params = { regrowthPeriod: 6, dayLength: 12 }
  w.tick = 1
  return w
}

function put(
  w: WorldState,
  id: string,
  kind: ItemKind,
  pos: Pos | null,
  holder: AgentId | null = null,
): Item {
  const item: Item = { id, kind, pos, holder, props: { description: 'd' } }
  w.items.push(item)
  if (holder) w.agents.find((a) => a.id === holder)?.inventory.push(id)
  return item
}

const params = (w: WorldState): WorldParams => ({ ...w.params })
const act = (entries: [AgentId, Action][]) => new Map(entries)
const agent = (w: WorldState, id: AgentId) => w.agents.find((a) => a.id === id) as AgentState

describe('stepWorld', () => {
  it('should_not_mutate_its_input_and_should_advance_the_tick', () => {
    const w = blank()
    const before = structuredClone(w)
    const r = stepWorld(w, params(w), act([['ada', { type: 'move', dir: 'S' }]]))
    expect(w).toEqual(before)
    expect(r.state.tick).toBe(2)
    expect(agent(r.state, 'ada').pos).toEqual({ x: 0, y: 1 })
    expect(r.events.every((e) => e.tick === 1 && e.path === '')).toBe(true)
  })

  it('should_block_moves_into_rock_water_and_edges', () => {
    const w = blank()
    w.terrain[0 * 12 + 1] = 'ground'
    w.terrain[1 * 12 + 0] = 'water'
    const r = stepWorld(w, params(w), act([['ada', { type: 'move', dir: 'N' }]]))
    expect(agent(r.state, 'ada').pos).toEqual({ x: 0, y: 0 })
    expect(r.results.get('ada')?.ok).toBe(false)
    const r2 = stepWorld(w, params(w), act([['ada', { type: 'move', dir: 'S' }]]))
    expect(agent(r2.state, 'ada').pos).toEqual({ x: 0, y: 0 })
    expect(r2.events.some((e) => e.type === 'action_rejected')).toBe(true)
  })

  it('should_drain_one_energy_per_tick_and_kill_at_zero', () => {
    const w = blank()
    agent(w, 'bo').energy = 1
    put(w, 'stone-1', 'stone', null, 'bo')
    const r = stepWorld(w, params(w), new Map())
    expect(agent(r.state, 'ada').energy).toBe(59)
    expect(agent(r.state, 'bo').alive).toBe(false)
    expect(r.events.some((e) => e.type === 'agent_died' && e.agentId === 'bo')).toBe(true)
    // what the dead carried falls where they stood, so no stone is lost
    expect(r.state.items.find((i) => i.id === 'stone-1')?.pos).toEqual({ x: 1, y: 0 })
    const r2 = stepWorld(r.state, params(w), act([['bo', { type: 'move', dir: 'S' }]]))
    expect(agent(r2.state, 'bo').pos).toEqual({ x: 1, y: 0 })
  })

  it('should_pick_eat_and_cap_energy', () => {
    const w = blank()
    put(w, 'food-1', 'food', { x: 0, y: 0 })
    put(w, 'food-2', 'food', null, 'bo')
    agent(w, 'bo').energy = 90
    const r = stepWorld(
      w,
      params(w),
      act([
        ['ada', { type: 'pick', itemId: 'food-1' }],
        ['bo', { type: 'use', itemId: 'food-2' }],
      ]),
    )
    expect(agent(r.state, 'ada').inventory).toEqual(['food-1'])
    expect(r.state.items.find((i) => i.id === 'food-1')).toMatchObject({ pos: null, holder: 'ada' })
    expect(agent(r.state, 'bo').energy).toBe(99) // capped at 100, then the tick's drain
    expect(r.state.items.some((i) => i.id === 'food-2')).toBe(false)
    expect(r.events.map((e) => e.type)).toContain('ate')
    const r2 = stepWorld(r.state, params(w), act([['ada', { type: 'use', itemId: 'food-1' }]]))
    expect(agent(r2.state, 'ada').energy).toBe(58 + 25)
  })

  it('should_refuse_to_pick_what_is_not_on_your_tile_or_the_slab', () => {
    const w = blank()
    put(w, 'stone-1', 'stone', { x: 3, y: 3 })
    put(w, 'slab-1', 'slab', { x: 0, y: 0 })
    const r = stepWorld(w, params(w), act([['ada', { type: 'pick', itemId: 'stone-1' }]]))
    expect(r.results.get('ada')?.ok).toBe(false)
    const r2 = stepWorld(w, params(w), act([['ada', { type: 'pick', itemId: 'slab-1' }]]))
    expect(r2.results.get('ada')?.ok).toBe(false)
  })

  it('should_regrow_food_on_empty_fertile_tiles_every_period', () => {
    const w = blank()
    w.tick = 6
    put(w, 'food-1', 'food', { x: 10, y: 10 })
    const r = stepWorld(w, params(w), new Map())
    const foodAt = (p: Pos) =>
      r.state.items.filter((i) => i.kind === 'food' && i.pos?.x === p.x && i.pos?.y === p.y)
    for (const f of w.rules.fertile) expect(foodAt(f)).toHaveLength(1)
    expect(r.events.filter((e) => e.type === 'item_spawned')).toHaveLength(2)
    w.tick = 7
    expect(stepWorld(w, params(w), new Map()).events.some((e) => e.type === 'item_spawned')).toBe(
      false,
    )
  })

  it('should_follow_the_params_from_above_not_the_hidden_rules', () => {
    const w = blank()
    w.tick = 4
    const r = stepWorld(w, { regrowthPeriod: 4, dayLength: 12 }, new Map())
    expect(r.events.some((e) => e.type === 'item_spawned')).toBe(true)
    const changed = r.events.find((e) => e.type === 'world_param_changed')
    expect(changed?.payload).toEqual({ param: 'regrowthPeriod', before: 6, after: 4 })
    expect(r.state.params.regrowthPeriod).toBe(4)
  })

  it('should_light_the_first_half_of_each_day', () => {
    expect(lightAt(0, 12)).toBe(1)
    expect(lightAt(5, 12)).toBe(1)
    expect(lightAt(6, 12)).toBe(0.2)
    expect(lightAt(13, 12)).toBe(1)
  })

  it('should_make_a_dropped_item_vanish_on_the_glitch_and_return_after_the_delay', () => {
    const w = blank()
    agent(w, 'ada').pos = { x: 5, y: 5 }
    put(w, 'stone-1', 'stone', null, 'ada')
    let r = stepWorld(w, params(w), act([['ada', { type: 'drop', itemId: 'stone-1' }]]))
    expect(r.state.items.find((i) => i.id === 'stone-1')).toMatchObject({ pos: null, holder: null })
    expect(r.events.some((e) => e.type === 'item_vanished')).toBe(true)
    expect(r.state.pending).toEqual([{ itemId: 'stone-1', dueTick: 5, to: { x: 8, y: 8 } }])
    for (let t = 2; t < 5; t++) {
      r = stepWorld(r.state, params(w), new Map())
      expect(r.events.some((e) => e.type === 'item_reappeared')).toBe(false)
    }
    r = stepWorld(r.state, params(w), new Map())
    expect(r.events.some((e) => e.type === 'item_reappeared' && e.tick === 5)).toBe(true)
    expect(r.state.items.find((i) => i.id === 'stone-1')?.pos).toEqual({ x: 8, y: 8 })
    expect(r.state.pending).toEqual([])
  })

  it('should_feed_agents_next_to_a_resonating_crystal_pair', () => {
    const w = blank(3)
    put(w, 'crystal-1', 'crystal', { x: 2, y: 2 })
    put(w, 'crystal-2', 'crystal', { x: 5, y: 2 }) // Manhattan 3
    agent(w, 'ada').pos = { x: 1, y: 1 }
    agent(w, 'bo').pos = { x: 5, y: 3 }
    agent(w, 'cyr').pos = { x: 9, y: 9 }
    const r = stepWorld(w, params(w), new Map())
    expect(agent(r.state, 'ada').energy).toBe(61)
    expect(agent(r.state, 'bo').energy).toBe(61)
    expect(agent(r.state, 'cyr').energy).toBe(59)
    expect(r.events.filter((e) => e.type === 'resonance')).toHaveLength(1)
    const second = w.items[1] as Item
    second.pos = { x: 6, y: 2 } // Manhattan 4: silent
    expect(agent(stepWorld(w, params(w), new Map()).state, 'ada').energy).toBe(59)
  })

  it('should_conserve_stones_through_any_sequence', () => {
    let w = generateWorld(11, 4)
    const stones = () => w.items.filter((i) => i.kind === 'stone').length
    const dirs = ['N', 'S', 'E', 'W'] as const
    for (let t = 0; t < 60; t++) {
      const actions = new Map<AgentId, Action>()
      w.agents.forEach((a, i) => {
        const here = w.items.find(
          (it) => it.kind === 'stone' && it.pos?.x === a.pos.x && it.pos?.y === a.pos.y,
        )
        const held = a.inventory[0]
        if (here) actions.set(a.id, { type: 'pick', itemId: here.id })
        else if (held && t % 3 === 0) actions.set(a.id, { type: 'drop', itemId: held })
        else actions.set(a.id, { type: 'move', dir: dirs[(t + i) % 4] as (typeof dirs)[number] })
      })
      w = stepWorld(w, w.params, actions).state
      expect(stones()).toBe(6)
    }
  })

  it('should_tell_who_heard_a_word_within_five_tiles', () => {
    const w = blank(3)
    agent(w, 'bo').pos = { x: 5, y: 0 }
    agent(w, 'cyr').pos = { x: 6, y: 0 }
    const r = stepWorld(w, params(w), act([['ada', { type: 'say', text: 'hi' }]]))
    const said = r.events.find((e) => e.type === 'said')
    expect(said?.payload).toEqual({ text: 'hi', heardBy: ['bo'] })
  })

  it('should_record_notes_hypotheses_and_resolve_predictions_at_their_tick', () => {
    const w = blank()
    put(w, 'food-1', 'food', { x: 3, y: 3 })
    let r = stepWorld(
      w,
      params(w),
      act([
        ['ada', { type: 'hypothesize', id: 'h1', statement: 'food stays' }],
        ['bo', { type: 'note', text: 'look south', shared: true, basedOn: ['h1'] }],
      ]),
    )
    expect(r.events.find((e) => e.type === 'hypothesis')?.payload).toEqual({
      id: 'h1',
      statement: 'food stays',
    })
    expect(r.events.find((e) => e.type === 'note')?.payload).toEqual({
      text: 'look south',
      shared: true,
      basedOn: ['h1'],
    })
    r = stepWorld(
      r.state,
      params(w),
      act([
        [
          'ada',
          {
            type: 'predict',
            id: 'p1',
            hypothesisId: 'h1',
            claim: {
              kind: 'item_at',
              itemKind: 'food',
              pos: { x: 3, y: 3 },
              atTick: 4,
              present: true,
            },
          },
        ],
        [
          'bo',
          {
            type: 'predict',
            id: 'p2',
            claim: { kind: 'energy_at', agentId: 'bo', atTick: 3, min: 0, max: 10 },
          },
        ],
      ]),
    )
    expect(r.state.predictions).toHaveLength(2)
    r = stepWorld(r.state, params(w), new Map()) // tick 3
    expect(r.events.find((e) => e.type === 'prediction_resolved')).toMatchObject({
      agentId: 'bo',
      payload: { predictionId: 'p2', correct: false },
    })
    r = stepWorld(r.state, params(w), new Map()) // tick 4
    expect(r.events.find((e) => e.type === 'prediction_resolved')).toMatchObject({
      agentId: 'ada',
      payload: { predictionId: 'p1', hypothesisId: 'h1', correct: true },
    })
    expect(r.state.predictions).toEqual([])
  })

  it('should_resolve_an_event_prediction_against_that_ticks_events', () => {
    const w = blank()
    w.predictions = [
      {
        id: 'p1',
        agentId: 'ada',
        claim: { kind: 'event_at', eventType: 'item_spawned', atTick: 6, occurs: true },
      },
      {
        id: 'p2',
        agentId: 'bo',
        claim: { kind: 'event_at', eventType: 'item_spawned', atTick: 7, occurs: true },
      },
    ]
    w.tick = 6
    let r = stepWorld(w, params(w), new Map())
    expect(r.events.find((e) => e.type === 'prediction_resolved')?.payload).toMatchObject({
      correct: true,
    })
    r = stepWorld(r.state, params(w), new Map())
    expect(r.events.find((e) => e.type === 'prediction_resolved')?.payload).toMatchObject({
      correct: false,
    })
  })

  it('should_reject_a_prediction_about_the_past_or_now', () => {
    const w = blank()
    const r = stepWorld(
      w,
      params(w),
      act([
        [
          'ada',
          {
            type: 'predict',
            id: 'p',
            claim: { kind: 'energy_at', agentId: 'ada', atTick: 1, min: 0, max: 99 },
          },
        ],
      ]),
    )
    expect(r.results.get('ada')?.ok).toBe(false)
    expect(r.state.predictions).toEqual([])
  })

  it('should_allow_one_strategy_revision_per_ten_ticks', () => {
    const w = blank()
    const revise: Action = { type: 'revise_strategy', text: 'gather', reason: 'hungry' }
    let r = stepWorld(w, params(w), act([['ada', revise]]))
    expect(r.events.some((e) => e.type === 'strategy_revised')).toBe(true)
    for (let i = 0; i < 9; i++) {
      r = stepWorld(r.state, params(w), act([['ada', revise]]))
      expect(r.results.get('ada')?.ok).toBe(false)
    }
    r = stepWorld(r.state, params(w), act([['ada', revise]]))
    expect(r.results.get('ada')?.ok).toBe(true)
  })

  it('should_hand_a_slab_touch_upward_only_within_reach', () => {
    const w = blank()
    put(w, 'slab-1', 'slab', { x: 1, y: 1 })
    put(w, 'stone-1', 'stone', { x: 0, y: 1 })
    const press: Action = { type: 'interface', itemId: 'slab-1', op: 'press', values: [1, 2, 3] }
    const r = stepWorld(w, params(w), act([['ada', press]]))
    expect(r.requests).toEqual([{ tick: 1, agentId: 'ada', action: press }])
    expect(r.events.some((e) => e.type === 'interface_request')).toBe(true)
    agent(w, 'ada').pos = { x: 3, y: 3 }
    expect(stepWorld(w, params(w), act([['ada', press]])).requests).toEqual([])
    expect(
      stepWorld(w, params(w), act([['ada', { type: 'interface', itemId: 'stone-1', op: 'read' }]]))
        .requests,
    ).toEqual([])
  })

  it('should_read_a_tablet_on_inspect', () => {
    const w = blank()
    const t = put(w, 'tablet-1', 'tablet', { x: 0, y: 1 })
    t.props.text = 'words'
    const r = stepWorld(w, params(w), act([['ada', { type: 'inspect', itemId: 'tablet-1' }]]))
    expect(r.results.get('ada')).toEqual({ ok: true, message: 'd Inscription: "words"' })
  })
})
