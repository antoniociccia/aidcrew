import { describe, expect, it } from 'bun:test'
import type { AgentState, WorldState } from '../contracts.ts'
import { generateWorld } from './generate.ts'
import { observe } from './observe.ts'

function world(): WorldState {
  const w = generateWorld(5, 3)
  w.terrain = w.terrain.map(() => 'ground')
  w.items = [
    {
      id: 'stone-1',
      kind: 'stone',
      pos: { x: 6, y: 6 },
      holder: null,
      props: { description: 'd' },
    },
    {
      id: 'stone-2',
      kind: 'stone',
      pos: { x: 9, y: 9 },
      holder: null,
      props: { description: 'd' },
    },
    { id: 'tablet-1', kind: 'tablet', pos: null, holder: 'ada', props: { text: 'secret' } },
  ]
  const [ada, bo, cyr] = w.agents as [AgentState, AgentState, AgentState]
  ada.pos = { x: 5, y: 5 }
  ada.inventory = ['tablet-1']
  bo.pos = { x: 7, y: 7 }
  bo.energy = 13
  cyr.pos = { x: 11, y: 11 }
  w.params = { regrowthPeriod: 6, dayLength: 12 }
  return w
}

describe('observe', () => {
  it('should_see_three_tiles_around_by_day', () => {
    const w = world()
    w.tick = 2
    const o = observe(w, 'ada', [], null)
    expect(o.light).toBe(1)
    expect(o.tiles).toHaveLength(49)
    expect(o.items).toEqual([{ id: 'stone-1', kind: 'stone', pos: { x: 6, y: 6 } }])
    expect(o.agents).toEqual([{ id: 'bo', name: 'Bo', pos: { x: 7, y: 7 } }])
    expect(o.self).toEqual({
      id: 'ada',
      name: 'Ada',
      pos: { x: 5, y: 5 },
      energy: 60,
      inventory: [{ id: 'tablet-1', kind: 'tablet' }],
    })
  })

  it('should_see_one_tile_around_by_night', () => {
    const w = world()
    w.tick = 7
    const o = observe(w, 'ada', [], null)
    expect(o.light).toBe(0.2)
    expect(o.tiles).toHaveLength(9)
    expect(o.items).toEqual([{ id: 'stone-1', kind: 'stone', pos: { x: 6, y: 6 } }])
    expect(o.agents).toEqual([])
  })

  it('should_never_show_rules_props_or_another_agents_insides', () => {
    const w = world()
    const text = JSON.stringify(
      observe(w, 'ada', [{ from: 'bo', text: 'hi' }], { ok: true, message: 'm' }),
    )
    expect(text).not.toContain('secret')
    expect(text).not.toContain('regrowth')
    expect(text).not.toContain('glitch')
    expect(text).not.toContain('"energy":13')
  })

  it('should_clip_the_view_at_the_edges_and_pass_on_what_was_heard', () => {
    const w = world()
    const o = observe(w, 'cyr', [{ from: 'bo', text: 'hi' }], { ok: false, message: 'no' })
    expect(o.tiles).toHaveLength(16)
    expect(o.heard).toEqual([{ from: 'bo', text: 'hi' }])
    expect(o.lastResult).toEqual({ ok: false, message: 'no' })
  })
})
