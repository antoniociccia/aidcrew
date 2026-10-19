import { describe, expect, it } from 'bun:test'
import { parseDecision } from './parse.ts'

describe('parseDecision', () => {
  it('should_read_action_and_rationale', () => {
    expect(parseDecision('{"action":{"type":"wait"},"rationale":"tired"}')).toEqual({
      action: { type: 'wait' },
      rationale: 'tired',
    })
  })

  it('should_find_the_object_inside_fences_and_chatter', () => {
    const text =
      'Sure! Here it is:\n```json\n{"action": {"type": "say", "text": "a } in {text}"}, "rationale": "hi"}\n```\nand {"action":{"type":"wait"}}'
    expect(parseDecision(text)).toEqual({
      action: { type: 'say', text: 'a } in {text}' },
      rationale: 'hi',
    })
  })

  it('should_skip_a_broken_object_and_take_the_next_balanced_one', () => {
    expect(parseDecision('{not json} then {"action":{"type":"wait"}}')).toEqual({
      action: { type: 'wait' },
    })
  })

  it('should_take_a_bare_action_object', () => {
    expect(parseDecision('{"type":"move","dir":"N"}')).toEqual({
      action: { type: 'move', dir: 'N' },
    })
  })

  it('should_give_no_action_for_garbage', () => {
    for (const text of ['', 'just words', '{"action":', '[1,2]', '{"rationale":"no action"}']) {
      expect(parseDecision(text).action).toBeUndefined()
    }
  })

  it('should_ignore_a_rationale_that_is_not_text', () => {
    expect(parseDecision('{"action":{"type":"wait"},"rationale":5}')).toEqual({
      action: { type: 'wait' },
    })
  })
})
