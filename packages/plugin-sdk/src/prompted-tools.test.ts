import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest, Provider, StreamDelta } from '@aidcrew/core'
import { withPromptedTools } from './prompted-tools.ts'

const usage = { inputTokens: 1, outputTokens: 1 }

/** A provider that replays deltas and records what it was asked. */
function fake(deltas: StreamDelta[]) {
  const seen: CanonicalRequest[] = []
  const provider: Provider = {
    id: 'fake',
    async *send(request) {
      seen.push(request)
      for (const delta of deltas) yield delta
    },
  }
  return { provider, seen }
}

function text(...parts: string[]): StreamDelta[] {
  return [
    ...parts.map((t) => ({ type: 'text_delta' as const, text: t })),
    { type: 'done' as const, stopReason: 'end_turn' as const, usage },
  ]
}

const request: CanonicalRequest = {
  model: 'm',
  system: 'Be brief.',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [
    { name: 'read', description: 'Read a file.', inputSchema: { type: 'object' } },
    { name: 'bash', description: 'Run a command.', inputSchema: { type: 'object' } },
  ],
  maxTokens: 100,
}

async function run(deltas: StreamDelta[], req = request) {
  const { provider, seen } = fake(deltas)
  const out: StreamDelta[] = []
  for await (const delta of withPromptedTools(provider).send(req, new AbortController().signal)) {
    out.push(delta)
  }
  return { out, seen }
}

describe('withPromptedTools: the request', () => {
  test('moves the tools into the system prompt', async () => {
    const { seen } = await run(text('hello'))

    expect(seen[0]?.system).toContain('read')
    expect(seen[0]?.system).toContain('Read a file.')
  })

  test('strips the tools field, since the model cannot use it', async () => {
    const { seen } = await run(text('hello'))

    expect(seen[0]?.tools).toEqual([])
  })

  test('keeps the original system prompt', async () => {
    const { seen } = await run(text('hello'))

    expect(seen[0]?.system).toContain('Be brief.')
  })

  test('changes nothing when there are no tools', async () => {
    const { seen } = await run(text('hello'), { ...request, tools: [] })

    expect(seen[0]?.system).toBe('Be brief.')
  })
})

describe('withPromptedTools: the response', () => {
  test('passes ordinary text through untouched', async () => {
    const { out } = await run(text('Hello there.'))

    expect(out).toEqual([
      { type: 'text_delta', text: 'Hello there.' },
      { type: 'done', stopReason: 'end_turn', usage },
    ])
  })

  test('turns a tool call written as text into real tool deltas', async () => {
    const { out } = await run(
      text('<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>'),
    )

    expect(out.filter((d) => d.type !== 'done')).toEqual([
      { type: 'tool_use_start', id: expect.any(String), name: 'read' },
      { type: 'tool_use_delta', id: expect.any(String), partialInput: '{"path":"a.ts"}' },
      { type: 'tool_use_end', id: expect.any(String) },
    ])
  })

  test('reports the turn as a tool turn, not as a finished answer', async () => {
    // The model said end_turn because as far as it knows it just wrote text.
    const { out } = await run(text('<tool_call>{"name":"read","arguments":{}}</tool_call>'))

    expect(out.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })
  })

  test('keeps the prose that came before the call', async () => {
    const { out } = await run(
      text('Let me look. <tool_call>{"name":"read","arguments":{}}</tool_call>'),
    )

    const prose = out
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text)
      .join('')
    expect(prose.trim()).toBe('Let me look.')
  })

  test('reassembles a call split across many deltas', async () => {
    // The single most likely failure: the tag arrives one token at a time.
    const { out } = await run(
      text('<tool', '_call>{"na', 'me":"read","argum', 'ents":{"path":"a.ts"}}</tool', '_call>'),
    )

    const start = out.find((d) => d.type === 'tool_use_start')
    expect(start).toMatchObject({ name: 'read' })
    const input = out
      .filter((d) => d.type === 'tool_use_delta')
      .map((d) => d.partialInput)
      .join('')
    expect(JSON.parse(input)).toEqual({ path: 'a.ts' })
  })

  test('never leaks a partial tag as visible text', async () => {
    const { out } = await run(text('<tool', '_call>{"name":"read","arguments":{}}</tool_call>'))

    const prose = out
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text)
      .join('')
    expect(prose).not.toContain('<tool')
  })

  test('handles two calls in one turn', async () => {
    const { out } = await run(
      text(
        '<tool_call>{"name":"read","arguments":{"path":"a"}}</tool_call>',
        '<tool_call>{"name":"bash","arguments":{"command":"ls"}}</tool_call>',
      ),
    )

    expect(out.filter((d) => d.type === 'tool_use_start').map((d) => d.name)).toEqual([
      'read',
      'bash',
    ])
  })

  test('gives each call its own id', async () => {
    const { out } = await run(
      text(
        '<tool_call>{"name":"read","arguments":{}}</tool_call>',
        '<tool_call>{"name":"bash","arguments":{}}</tool_call>',
      ),
    )

    const ids = out.filter((d) => d.type === 'tool_use_start').map((d) => d.id)
    expect(new Set(ids).size).toBe(2)
  })

  test('shows a malformed call as text instead of guessing at it', async () => {
    // Inventing arguments for a half-written call would hand made-up input to
    // a tool that can write files.
    const { out } = await run(text('<tool_call>{"name": broken</tool_call>'))

    const prose = out
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text)
      .join('')
    expect(prose).toContain('broken')
    expect(out.some((d) => d.type === 'tool_use_start')).toBe(false)
  })

  test('shows a call with no name as text', async () => {
    const { out } = await run(text('<tool_call>{"arguments":{}}</tool_call>'))

    expect(out.some((d) => d.type === 'tool_use_start')).toBe(false)
  })

  test('leaves a text-only turn reported as end_turn', async () => {
    const { out } = await run(text('Just an answer.'))

    expect(out.at(-1)).toMatchObject({ stopReason: 'end_turn' })
  })

  test('flushes trailing text that never became a tag', async () => {
    const { out } = await run(text('done <too'))

    const prose = out
      .filter((d) => d.type === 'text_delta')
      .map((d) => d.text)
      .join('')
    expect(prose).toBe('done <too')
  })

  test('accepts a call whose arguments are missing entirely', async () => {
    const { out } = await run(text('<tool_call>{"name":"read"}</tool_call>'))

    expect(out.find((d) => d.type === 'tool_use_start')).toMatchObject({ name: 'read' })
  })
})

describe('withPromptedTools: the history', () => {
  /** The second turn: the model called a tool last time, and here is the result. */
  const history: CanonicalRequest = {
    ...request,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'what is in a.ts?' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me look.' },
          { type: 'tool_use', id: 'fake-prompted-0', name: 'read', input: { path: 'a.ts' } },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            toolUseId: 'fake-prompted-0',
            content: 'export {}',
            isError: false,
          },
        ],
      },
    ],
  }

  test('shows the model its own earlier call in the form it was taught to write', async () => {
    // Only the system prompt and the tools were rewritten. The transcript
    // still carried the call as a tool_use block, which the dialect rendered
    // as a native tool call — a shape this model has never seen, since the
    // whole point of the wrapper is that it cannot use one.
    const { seen } = await run(text('ok'), history)

    expect(seen[0]?.messages[1]?.content).toEqual([
      {
        type: 'text',
        text: 'Let me look.\n<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>',
      },
    ])
  })

  test('shows the result as text from the user, since the model has no tool role', async () => {
    // Rendered as a `tool` role it went to a server that was never told
    // about any tools, and the strict ones reject that outright.
    const { seen } = await run(text('ok'), history)

    expect(seen[0]?.messages[2]?.content).toEqual([
      { type: 'text', text: '<tool_result name="read">export {}</tool_result>' },
    ])
  })

  test('marks a result that was an error, so the model does not build on it', async () => {
    const failed: CanonicalRequest = {
      ...history,
      messages: [
        ...history.messages.slice(0, 2),
        {
          role: 'user',
          content: [
            { type: 'tool_result', toolUseId: 'fake-prompted-0', content: 'ENOENT', isError: true },
          ],
        },
      ],
    }

    const { seen } = await run(text('ok'), failed)

    expect(seen[0]?.messages[2]?.content).toEqual([
      { type: 'text', text: '<tool_result name="read" error="true">ENOENT</tool_result>' },
    ])
  })

  test('tells the model what a result will look like', async () => {
    const { seen } = await run(text('ok'), history)

    expect(seen[0]?.system).toContain('<tool_result name=')
  })

  test('leaves a history with no tool blocks in it exactly as it was', async () => {
    const { seen } = await run(text('ok'))

    expect(seen[0]?.messages).toEqual(request.messages)
  })

  test('never mints the same id twice, even on a later turn', async () => {
    // Every turn started counting from zero, so the second turn's call had
    // the first turn's id and its result answered the wrong call.
    const { provider } = fake(text('<tool_call>{"name":"read","arguments":{}}</tool_call>'))
    const wrapped = withPromptedTools(provider)
    const ids: string[] = []

    for (const _turn of [1, 2]) {
      for await (const delta of wrapped.send(request, new AbortController().signal)) {
        if (delta.type === 'tool_use_start') ids.push(delta.id)
      }
    }

    expect(new Set(ids).size).toBe(2)
  })
})
