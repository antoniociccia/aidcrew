import { describe, expect, it } from 'bun:test'
import { ALL_ACTIONS } from '../actions.ts'
import type { DecisionInput } from '../contracts.ts'
import { generateWorld } from '../world/generate.ts'
import { observe } from '../world/observe.ts'
import { B_PARAGRAPH, BANNED_IN_A, buildMessages } from './prompt.ts'

function input(condition: 'A' | 'B'): DecisionInput {
  const w = generateWorld(7, 3)
  return {
    runId: 'r',
    agentId: 'bo',
    tick: 4,
    path: '',
    condition,
    observation: observe(w, 'bo', [{ from: 'ada', text: 'food here' }], {
      ok: true,
      message: 'You wait.',
    }),
    memory: {
      episodes: ['t3: you moved to (1,2)'],
      notes: ['berries return'],
      board: [{ by: 'cyr', tick: 2, text: 'slab is cold (based on: h1)' }],
      strategy: 'stay near food',
    },
    allowedActions: ALL_ACTIONS,
  }
}

const text = (c: 'A' | 'B') =>
  buildMessages(input(c))
    .map((m) => m.content)
    .join('\n')

describe('buildMessages', () => {
  it('should_speak_to_the_agent_by_name_with_local_goals', () => {
    const msgs = buildMessages(input('A'))
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user'])
    const all = text('A')
    expect(all).toContain('You are Bo')
    expect(all).toMatch(/energy/i)
    expect(all).toContain('{"action":')
    for (const a of ALL_ACTIONS) expect(all).toContain(`"type":"${a}"`)
  })

  it('should_render_what_the_agent_sees_and_remembers', () => {
    const all = text('A')
    for (const s of [
      'food here',
      'You wait.',
      't3: you moved to (1,2)',
      'berries return',
      'slab is cold (based on: h1)',
      'stay near food',
    ]) {
      expect(all).toContain(s)
    }
  })

  it('should_show_only_the_allowed_action_shapes', () => {
    const i = input('A')
    i.allowedActions = ['wait', 'move']
    const all = buildMessages(i)
      .map((m) => m.content)
      .join('\n')
    expect(all).toContain('"type":"move"')
    expect(all).not.toContain('"type":"interface"')
  })

  it('should_add_exactly_one_paragraph_in_condition_b', () => {
    const a = text('A')
    const b = text('B')
    expect(b).toContain(B_PARAGRAPH)
    expect(a).not.toContain(B_PARAGRAPH)
    expect(b.replace(`${B_PARAGRAPH}\n\n`, '')).toBe(a)
  })

  it('should_never_say_a_banned_word_in_condition_a', () => {
    const all = text('A').toLowerCase()
    for (const w of BANNED_IN_A) expect(all).not.toContain(w.toLowerCase())
  })
})
