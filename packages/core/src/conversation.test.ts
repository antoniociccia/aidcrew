import { describe, expect, test } from 'bun:test'
import { closeOpenCalls, isWellFormed } from './conversation.ts'
import type { Message } from './types.ts'

const asked = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })
const called = (id: string, name = 'write'): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name, input: {} }],
})
const answered = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content: 'done', isError: false }],
})

describe('a conversation a provider will accept', () => {
  test('leaves a finished conversation exactly as it is', () => {
    const whole = [asked('write it'), called('c1'), answered('c1')]

    expect(closeOpenCalls(whole)).toEqual(whole)
  })

  test('answers a call the turn never got to run', () => {
    // Escape pressed between the model asking for a tool and the tool running.
    // One of these is enough to make every later turn fail, for good.
    const broken = [asked('write it'), called('c1')]

    const fixed = closeOpenCalls(broken)

    expect(isWellFormed(broken)).toBe(false)
    expect(isWellFormed(fixed)).toBe(true)
    expect(fixed.at(-1)).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'c1', isError: true }],
    })
  })

  test('says the call never ran, rather than inventing an outcome', () => {
    // A model told a command succeeded when it never ran builds on something
    // that is not there, which is worse than being told plainly.
    const [, , result] = closeOpenCalls([asked('go'), called('c1')])
    const block = result?.content[0]

    expect(block?.type === 'tool_result' && block.content).toMatch(/stopped before this ran/)
  })

  test('answers only the calls that were never answered', () => {
    const mixed: Message[] = [
      called('c1'),
      answered('c1'),
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c2', name: 'read', input: {} }] },
    ]

    const fixed = closeOpenCalls(mixed)

    expect(isWellFormed(fixed)).toBe(true)
    // c1 keeps its real answer; only c2 gets the manufactured one.
    expect(JSON.stringify(fixed)).toContain('"content":"done"')
  })

  test('answers two calls left open in the same turn', () => {
    const two: Message = {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 'a', name: 'read', input: {} },
        { type: 'tool_use', id: 'b', name: 'read', input: {} },
      ],
    }

    expect(isWellFormed(closeOpenCalls([asked('go'), two]))).toBe(true)
  })

  test('puts the answer with the reply that follows, when there is one', () => {
    // Results belong in the message after the call. A conversation where the
    // agent was interrupted and then told something else has both.
    const interrupted = [called('c1'), asked('actually, stop')]

    const fixed = closeOpenCalls(interrupted)

    expect(fixed).toHaveLength(2)
    expect(fixed[1]?.content.map((block) => block.type)).toEqual(['tool_result', 'text'])
  })

  test('an empty conversation is well formed and stays empty', () => {
    expect(closeOpenCalls([])).toEqual([])
    expect(isWellFormed([])).toBe(true)
  })
})
