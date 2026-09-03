import { describe, expect, test } from 'bun:test'
import { accumulate } from './accumulator.ts'
import type { StreamDelta } from './types.ts'

async function* stream(deltas: StreamDelta[]): AsyncIterable<StreamDelta> {
  for (const delta of deltas) yield delta
}

const DONE: StreamDelta = {
  type: 'done',
  stopReason: 'end_turn',
  usage: { inputTokens: 10, outputTokens: 5 },
}

describe('accumulate', () => {
  test('joins consecutive text deltas into a single block', async () => {
    const turn = await accumulate(
      stream([
        { type: 'text_delta', text: 'Hello' },
        { type: 'text_delta', text: ', ' },
        { type: 'text_delta', text: 'world' },
        DONE,
      ]),
    )

    expect(turn.content).toEqual([{ type: 'text', text: 'Hello, world' }])
    expect(turn.stopReason).toBe('end_turn')
    expect(turn.usage).toEqual({ inputTokens: 10, outputTokens: 5 })
  })

  test('parses a tool input that arrives in arbitrary json fragments', async () => {
    const turn = await accumulate(
      stream([
        { type: 'tool_use_start', id: 'call_1', name: 'read' },
        { type: 'tool_use_delta', id: 'call_1', partialInput: '{"pa' },
        { type: 'tool_use_delta', id: 'call_1', partialInput: 'th": "a.ts"' },
        { type: 'tool_use_delta', id: 'call_1', partialInput: '}' },
        { type: 'tool_use_end', id: 'call_1' },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )

    expect(turn.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
    ])
    expect(turn.stopReason).toBe('tool_use')
  })

  test('treats a tool call with no input fragments as empty arguments', async () => {
    const turn = await accumulate(
      stream([
        { type: 'tool_use_start', id: 'call_1', name: 'list_skills' },
        { type: 'tool_use_end', id: 'call_1' },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )

    expect(turn.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'list_skills', input: {} },
    ])
  })

  test('keeps text and tool calls in the order the model emitted them', async () => {
    const turn = await accumulate(
      stream([
        { type: 'text_delta', text: 'Let me look.' },
        { type: 'tool_use_start', id: 'call_1', name: 'read' },
        { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path":"a.ts"}' },
        { type: 'tool_use_end', id: 'call_1' },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )

    expect(turn.content.map((block) => block.type)).toEqual(['text', 'tool_use'])
  })

  test('separates thinking from the visible answer', async () => {
    const turn = await accumulate(
      stream([
        { type: 'thinking_delta', text: 'The user wants ' },
        { type: 'thinking_delta', text: 'a file.' },
        { type: 'text_delta', text: 'Sure.' },
        DONE,
      ]),
    )

    expect(turn.content).toEqual([
      { type: 'thinking', text: 'The user wants a file.' },
      { type: 'text', text: 'Sure.' },
    ])
  })

  test('interleaves two tool calls streamed at the same time', async () => {
    const turn = await accumulate(
      stream([
        { type: 'tool_use_start', id: 'a', name: 'read' },
        { type: 'tool_use_start', id: 'b', name: 'bash' },
        { type: 'tool_use_delta', id: 'a', partialInput: '{"path":"x"}' },
        { type: 'tool_use_delta', id: 'b', partialInput: '{"cmd":"ls"}' },
        { type: 'tool_use_end', id: 'a' },
        { type: 'tool_use_end', id: 'b' },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )

    expect(turn.content).toEqual([
      { type: 'tool_use', id: 'a', name: 'read', input: { path: 'x' } },
      { type: 'tool_use', id: 'b', name: 'bash', input: { cmd: 'ls' } },
    ])
  })

  test('rejects a tool input that is not valid json rather than guessing', async () => {
    const failing = accumulate(
      stream([
        { type: 'tool_use_start', id: 'call_1', name: 'read' },
        { type: 'tool_use_delta', id: 'call_1', partialInput: '{"path": ' },
        { type: 'tool_use_end', id: 'call_1' },
        { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )

    expect(failing).rejects.toThrow(/call_1/)
  })

  test('keeps a call the output cap cut off, with no arguments, rather than rejecting the turn', async () => {
    // Half the JSON arrived, and then the cap. That is not a provider
    // speaking the protocol wrongly, it is a turn that stopped — which the
    // loop already knows how to report, but only if this returns rather than
    // throws. The call is kept so the report can name it, and given no
    // arguments so nothing can run it on a guess.
    const turn = await accumulate(
      stream([
        { type: 'text_delta', text: 'Writing the file now.' },
        { type: 'tool_use_start', id: 't1', name: 'write' },
        { type: 'tool_use_delta', id: 't1', partialInput: '{"path":"a.ts","content":"export ' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 } },
      ]),
    )

    expect(turn.stopReason).toBe('max_tokens')
    expect(turn.content).toEqual([
      { type: 'text', text: 'Writing the file now.' },
      { type: 'tool_use', id: 't1', name: 'write', input: {} },
    ])
  })

  test('rejects a stream that ends without a done delta', async () => {
    const failing = accumulate(stream([{ type: 'text_delta', text: 'truncated' }]))

    expect(failing).rejects.toThrow(/done/i)
  })
})
