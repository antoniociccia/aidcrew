import { describe, expect, it } from 'bun:test'
import type { EventType, WorldEvent } from './contracts.ts'
import { memoryView } from './memory.ts'

let seq = 0
const ev = (
  tick: number,
  type: EventType,
  agentId: string | null,
  payload: Record<string, unknown>,
  path = '',
): WorldEvent => ({ tick, seq: seq++, path, type, agentId, payload })

const log: WorldEvent[] = [
  ev(0, 'decision', 'ada', { decider: 'fake', rationale: 'secret plan' }),
  ev(0, 'moved', 'ada', { from: { x: 0, y: 0 }, to: { x: 1, y: 0 } }),
  ev(0, 'moved', 'bo', { from: { x: 5, y: 5 }, to: { x: 5, y: 6 } }),
  ev(1, 'said', 'bo', { text: 'food north', heardBy: ['ada'] }),
  ev(1, 'said', 'cyr', { text: 'far away', heardBy: [] }),
  ev(2, 'inspected', 'ada', { itemId: 'tablet-1', kind: 'tablet', message: 'Inscription: "x"' }),
  ev(2, 'note', 'ada', { text: 'private thought', shared: false, basedOn: [] }),
  ev(3, 'note', 'bo', { text: 'slab is east', shared: true, basedOn: ['p1'] }),
  ev(3, 'note', 'bo', { text: 'bo private', shared: false, basedOn: [] }),
  ev(4, 'strategy_revised', 'ada', { text: 'first', reason: 'r' }),
  ev(14, 'strategy_revised', 'ada', { text: 'second', reason: 'r' }),
  ev(
    15,
    'interface_response',
    'ada',
    { op: 'read', ok: true, message: 'The slab is smooth and cold.' },
    'upper',
  ),
  ev(15, 'upper_unlocked', 'bo', { values: [1, 2, 3] }, 'upper'),
  ev(16, 'prediction_resolved', 'ada', { predictionId: 'p1', correct: true }),
]

describe('memoryView', () => {
  it('should_recall_what_the_agent_did_heard_and_was_told', () => {
    const m = memoryView(log, 'ada', { enabled: true })
    expect(m.episodes).toEqual([
      't0: you moved to (1,0)',
      't1: bo said "food north"',
      't2: you inspected tablet-1: Inscription: "x"',
      't15: the slab answered: "The slab is smooth and cold."',
      't16: your prediction p1 came true',
    ])
    expect(m.notes).toEqual(['private thought'])
    expect(m.board).toEqual([{ by: 'bo', tick: 3, text: 'slab is east (based on: p1)' }])
    expect(m.strategy).toBe('second')
  })

  it('should_never_recall_rationales_or_what_happened_out_of_earshot', () => {
    const text = JSON.stringify(memoryView(log, 'ada', { enabled: true }))
    expect(text).not.toContain('secret plan')
    expect(text).not.toContain('far away')
    expect(text).not.toContain('bo private')
    expect(text).not.toContain('5,6')
  })

  it('should_keep_only_the_last_twenty_episodes', () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      ev(i, 'moved', 'ada', { from: { x: 0, y: 0 }, to: { x: i, y: 0 } }),
    )
    const m = memoryView(many, 'ada', { enabled: true })
    expect(m.episodes).toHaveLength(20)
    expect(m.episodes[0]).toBe('t10: you moved to (10,0)')
  })

  it('should_forget_everything_when_memory_is_ablated', () => {
    expect(memoryView(log, 'ada', { enabled: false })).toEqual({
      episodes: [],
      notes: [],
      board: [],
      strategy: '',
    })
  })
})
