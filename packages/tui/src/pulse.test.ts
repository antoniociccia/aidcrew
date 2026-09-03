import { describe, expect, test } from 'bun:test'
import type { AgentSnapshot } from '@aidcrew/core'
import { marquee, pulseOf } from './pulse.ts'

const agent = (over: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
  id: 'coder',
  model: 'muse-spark',
  status: 'idle',
  usage: { inputTokens: 0, outputTokens: 0 },
  turns: 0,
  workspace: '/repo',
  isolated: true,
  yolo: false,
  role: 'coder',
  task: 'main',
  queued: 0,
  behind: 0,
  activity: [],
  ...over,
})

describe('what an agent is up to', () => {
  test('shows the tool in flight while it is working', () => {
    const pulse = pulseOf(agent({ status: 'working' }), [
      { kind: 'say', text: 'let me look' },
      { kind: 'tool', text: 'bash bun test' },
    ])

    expect(pulse).toEqual({ text: 'bash bun test', kind: 'working' })
  })

  test('says how many instructions are waiting behind this one', () => {
    // Sending three things and seeing one status is indistinguishable from
    // sending three things and having two of them lost.
    const pulse = pulseOf(agent({ status: 'working', queued: 2 }), [
      { kind: 'tool', text: 'bash bun test' },
    ])

    expect(pulse).toEqual({ text: '2 more waiting', kind: 'working' })
  })

  test('says thinking when it is working but has not done anything yet', () => {
    expect(pulseOf(agent({ status: 'working' }), [])).toEqual({ text: 'thinking', kind: 'working' })
  })

  test('shows the last thing it said once it has stopped', () => {
    const pulse = pulseOf(agent({ turns: 2 }), [
      { kind: 'say', text: 'the rotation was missing' },
      { kind: 'tool', text: 'edit guard.ts' },
    ])

    expect(pulse.text).toBe('the rotation was missing')
  })

  test('keeps a failure in view rather than the sentence before it', () => {
    const pulse = pulseOf(agent({ turns: 1 }), [
      { kind: 'say', text: 'done' },
      { kind: 'error', text: '1 test failed' },
    ])

    expect(pulse).toEqual({ text: '1 test failed', kind: 'said' })
  })

  test('flattens a paragraph, because the row it goes in is one row', () => {
    const pulse = pulseOf(agent({ turns: 1 }), [
      { kind: 'say', text: 'Quick orientation\n\n* one thing\n* another' },
    ])

    expect(pulse.text).toBe('Quick orientation * one thing * another')
  })

  test('tells a fresh agent apart from one that has finished', () => {
    expect(pulseOf(agent({ turns: 0 }), []).text).toBe('ready')
    expect(pulseOf(agent({ turns: 3 }), []).text).toBe('idle')
  })
})

describe('running a long line through a short row', () => {
  test('leaves a line that fits exactly where it is', () => {
    expect(marquee('short', 10, 99)).toBe('short')
  })

  test('starts at the beginning and holds there for a beat', () => {
    expect(marquee('abcdefghij', 4, 0)).toBe('abcd')
    expect(marquee('abcdefghij', 4, 7)).toBe('abcd')
  })

  test('travels along, one character per frame', () => {
    expect(marquee('abcdefghij', 4, 9)).toBe('bcde')
    expect(marquee('abcdefghij', 4, 10)).toBe('cdef')
  })

  test('stops at the end instead of wrapping mid-word', () => {
    expect(marquee('abcdefghij', 4, 14)).toBe('ghij')
    expect(marquee('abcdefghij', 4, 20)).toBe('ghij')
  })

  test('comes back round rather than sticking forever', () => {
    expect(marquee('abcdefghij', 4, 22)).toBe('abcd')
  })
})
