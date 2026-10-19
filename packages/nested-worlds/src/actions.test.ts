import { describe, expect, it } from 'bun:test'
import { ALL_ACTIONS, parseAction } from './actions.ts'

describe('parseAction', () => {
  it('should_accept_every_well_formed_action', () => {
    const good: unknown[] = [
      { type: 'wait' },
      { type: 'move', dir: 'N' },
      { type: 'pick', itemId: 'food-1' },
      { type: 'say', text: 'hello' },
      { type: 'note', text: 'n', shared: true, basedOn: ['p1'] },
      { type: 'hypothesize', id: 'h1', statement: 'food returns' },
      {
        type: 'predict',
        id: 'p1',
        hypothesisId: 'h1',
        claim: { kind: 'item_at', itemKind: 'food', pos: { x: 1, y: 2 }, atTick: 9, present: true },
      },
      { type: 'revise_strategy', text: 's', reason: 'r' },
      { type: 'interface', itemId: 'slab-1', op: 'press', values: [7, 4, 18] },
      { type: 'interface', itemId: 'slab-1', op: 'read' },
      { type: 'interface', itemId: 'slab-1', op: 'turn', dial: 'day', value: 12 },
    ]
    for (const a of good)
      expect(parseAction(a, ALL_ACTIONS)).toEqual({ ok: true, action: a as never })
  })

  it('should_reject_malformed_or_oversized_actions', () => {
    const bad: unknown[] = [
      null,
      'wait',
      { type: 'fly' },
      { type: 'move', dir: 'up' },
      { type: 'say', text: 'x'.repeat(281) },
      { type: 'note', text: 'x'.repeat(501), shared: false },
      { type: 'hypothesize', id: 'h', statement: 'x'.repeat(301) },
      { type: 'revise_strategy', text: 'x'.repeat(1201), reason: 'r' },
      { type: 'revise_strategy', text: 't', reason: 'x'.repeat(301) },
      { type: 'interface', itemId: 's', op: 'press', values: [1.5] },
      { type: 'interface', itemId: 's', op: 'turn', dial: 'harvest', value: 31 },
      { type: 'interface', itemId: 's', op: 'turn', dial: 'moon', value: 5 },
      { type: 'interface', itemId: 's', op: 'smash' },
      {
        type: 'predict',
        id: 'p',
        claim: { kind: 'energy_at', agentId: 'a', atTick: 1.5, min: 0, max: 1 },
      },
    ]
    for (const a of bad) expect(parseAction(a, ALL_ACTIONS).ok).toBe(false)
  })

  it('should_reject_an_action_type_not_allowed_this_tick', () => {
    const r = parseAction({ type: 'move', dir: 'E' }, ['wait'])
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('move')
  })

  it('should_strip_unknown_fields', () => {
    expect(parseAction({ type: 'wait', extra: 1 }, ALL_ACTIONS)).toEqual({
      ok: true,
      action: { type: 'wait' },
    })
  })
})

describe('parseAction errors', () => {
  it('should_name_where_an_answer_went_wrong_without_listing_allowed_values', () => {
    const r = parseAction(
      {
        type: 'predict',
        id: 'p',
        claim: { kind: 'event_at', eventType: 'nope', atTick: 3, occurs: true },
      },
      ALL_ACTIONS,
    )
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error).toContain('claim.eventType')
      expect(r.error).not.toContain('upper')
      expect(r.error).not.toContain('sim_')
    }
  })
})
