import { describe, expect, test } from 'bun:test'
import type { LoopEvent, Tool } from './loop.ts'
import { runAgentLoop } from './loop.ts'
import type { Hooks } from './plugins/types.ts'
import type { Message, StreamDelta } from './types.ts'

const usage = { inputTokens: 1, outputTokens: 1 }

function endTurn(text: string): StreamDelta[] {
  return [
    { type: 'text_delta', text },
    { type: 'done', stopReason: 'end_turn', usage },
  ]
}

function callTool(id: string, name: string, input: unknown): StreamDelta[] {
  return [
    { type: 'tool_use_start', id, name },
    { type: 'tool_use_delta', id, partialInput: JSON.stringify(input) },
    { type: 'tool_use_end', id },
    { type: 'done', stopReason: 'tool_use', usage },
  ]
}

/** A provider that replays one scripted response per turn, in order. */
function scripted(turns: StreamDelta[][]) {
  const seen: unknown[] = []
  return {
    id: 'scripted',
    seen,
    async *send(request: { messages: Message[] }) {
      seen.push(structuredClone(request.messages))
      const turn = turns.shift()
      if (!turn) throw new Error('the provider was called more times than scripted')
      for (const delta of turn) yield delta
    },
  }
}

const echo: Tool = {
  name: 'echo',
  description: 'Echoes its argument back.',
  inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
  execute: async (input) => ({ content: `echoed ${(input as { value: string }).value}` }),
}

async function drain<E, R>(gen: AsyncGenerator<E, R>): Promise<{ events: E[]; result: R }> {
  const events: E[] = []
  for (;;) {
    const step = await gen.next()
    if (step.done) return { events, result: step.value }
    events.push(step.value)
  }
}

function run(overrides: Partial<Parameters<typeof runAgentLoop>[0]> = {}) {
  return runAgentLoop({
    provider: scripted([endTurn('hi')]),
    model: 'test-model',
    system: 'You are a test.',
    tools: [],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
    ...overrides,
  })
}

describe('runAgentLoop', () => {
  test('stops after one turn when the model ends its turn', async () => {
    const { result } = await drain(run())

    expect(result.turns).toBe(1)
    expect(result.stopReason).toBe('end_turn')
    expect(result.messages.at(-1)).toEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'hi' }],
    })
  })

  test('runs the requested tool and sends its result back to the model', async () => {
    const provider = scripted([callTool('t1', 'echo', { value: 'ping' }), endTurn('done')])

    const { result } = await drain(run({ provider, tools: [echo] }))

    expect(result.turns).toBe(2)
    const secondCall = provider.seen[1] as Message[]
    expect(secondCall.at(-1)).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', toolUseId: 't1', content: 'echoed ping', isError: false }],
    })
  })

  test('collects every tool result of a turn into a single message', async () => {
    const provider = scripted([
      [
        { type: 'tool_use_start', id: 'a', name: 'echo' },
        { type: 'tool_use_delta', id: 'a', partialInput: '{"value":"1"}' },
        { type: 'tool_use_end', id: 'a' },
        { type: 'tool_use_start', id: 'b', name: 'echo' },
        { type: 'tool_use_delta', id: 'b', partialInput: '{"value":"2"}' },
        { type: 'tool_use_end', id: 'b' },
        { type: 'done', stopReason: 'tool_use', usage },
      ],
      endTurn('done'),
    ])

    await drain(run({ provider, tools: [echo] }))

    const results = (provider.seen[1] as Message[]).at(-1)
    expect(results?.content).toHaveLength(2)
    expect(results?.content.map((block) => (block as { content: string }).content)).toEqual([
      'echoed 1',
      'echoed 2',
    ])
  })

  test('reports an unknown tool to the model instead of crashing', async () => {
    const provider = scripted([callTool('t1', 'missing', {}), endTurn('sorry')])

    const { result } = await drain(run({ provider, tools: [echo] }))

    const sent = (provider.seen[1] as Message[]).at(-1)?.content[0] as {
      isError: boolean
      content: string
    }
    expect(sent.isError).toBe(true)
    expect(sent.content).toMatch(/missing/)
    expect(result.stopReason).toBe('end_turn')
  })

  test('turns a failing tool into an error result the model can recover from', async () => {
    const exploding: Tool = {
      ...echo,
      name: 'explode',
      execute: async () => {
        throw new Error('disk on fire')
      },
    }
    const provider = scripted([callTool('t1', 'explode', {}), endTurn('recovered')])

    const { result } = await drain(run({ provider, tools: [exploding] }))

    const sent = (provider.seen[1] as Message[]).at(-1)?.content[0] as {
      isError: boolean
      content: string
    }
    expect(sent.isError).toBe(true)
    expect(sent.content).toMatch(/disk on fire/)
    expect(result.stopReason).toBe('end_turn')
  })

  test('stops at the turn limit so a tool loop cannot run forever', async () => {
    const provider = scripted([
      callTool('a', 'echo', { value: '1' }),
      callTool('b', 'echo', { value: '2' }),
      callTool('c', 'echo', { value: '3' }),
    ])

    const { result } = await drain(run({ provider, tools: [echo], maxTurns: 3 }))

    expect(result.turns).toBe(3)
    expect(result.stopReason).toBe('max_turns')
  })

  test('sums usage across every turn', async () => {
    const provider = scripted([callTool('t1', 'echo', { value: 'x' }), endTurn('done')])

    const { result } = await drain(run({ provider, tools: [echo] }))

    expect(result.usage).toEqual({ inputTokens: 2, outputTokens: 2 })
  })

  test('adds up what the providers said each turn cost', async () => {
    // Counted once per turn and then dropped, the total showed the last turn's
    // cost as though it were the whole session's.
    const provider = scripted([
      [
        { type: 'tool_use_start', id: 't1', name: 'echo' },
        { type: 'tool_use_delta', id: 't1', partialInput: '{"value":"x"}' },
        { type: 'tool_use_end', id: 't1' },
        { type: 'done', stopReason: 'tool_use', usage: { ...usage, listedUsd: 0.1 } },
      ],
      [{ type: 'done', stopReason: 'end_turn', usage: { ...usage, listedUsd: 0.2 } }],
    ])

    const { result } = await drain(run({ provider, tools: [echo] }))

    expect(result.usage.listedUsd).toBeCloseTo(0.3, 10)
  })

  test('leaves the money alone entirely when nobody stated any', async () => {
    // Absent and zero are different facts: zero would tell the price table the
    // turn was free when nothing has priced it at all.
    const { result } = await drain(run())

    expect(result.usage.listedUsd).toBeUndefined()
    expect(result.usage.chargedUsd).toBeUndefined()
  })

  test('emits tool start and end events around each call', async () => {
    const provider = scripted([callTool('t1', 'echo', { value: 'x' }), endTurn('done')])

    const { events } = await drain(run({ provider, tools: [echo] }))

    const kinds = events.map((event: LoopEvent) => event.type)
    expect(kinds).toContain('tool_start')
    expect(kinds).toContain('tool_end')
    expect(kinds.indexOf('tool_start')).toBeLessThan(kinds.indexOf('tool_end'))
  })

  test('stops when the caller aborts', async () => {
    const controller = new AbortController()
    const provider = scripted([callTool('t1', 'echo', { value: 'x' }), endTurn('done')])

    const stopping: Tool = {
      ...echo,
      execute: async (input) => {
        controller.abort()
        return { content: `echoed ${(input as { value: string }).value}` }
      },
    }

    const { result } = await drain(run({ provider, tools: [stopping], signal: controller.signal }))

    expect(result.stopReason).toBe('aborted')
    expect(result.turns).toBe(1)
  })
})

describe('a hook that never answers', () => {
  test('stops when the turn is cancelled, rather than never', async () => {
    // A pre-tool hook is awaited with no escape, while the loop only checks
    // the signal at the top of a turn. A hook that waits on something that
    // never happens — a prompt on a screen that has gone, a network call with
    // no timeout — wedged the agent permanently, and Esc did not get you out.
    const control = new AbortController()
    const hooks: Hooks[] = [{ preToolCall: () => new Promise(() => {}) }]

    const events: LoopEvent[] = []
    const run = (async () => {
      for await (const event of runAgentLoop({
        signal: control.signal,
        provider: scripted([callTool('c1', 'echo', { value: 'hi' })]),
        model: 'test',
        system: '',
        tools: [echo],
        messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
        cwd: process.cwd(),
        agentId: 'coder',
        hooks,
      })) {
        events.push(event)
      }
    })()

    await new Promise((resolve) => setTimeout(resolve, 50))
    control.abort()
    await run

    // It came back at all, which is the whole point — and it said why the
    // tool did not run rather than pretending it had.
    const ended = events.find((event) => event.type === 'tool_end')
    expect(ended && 'output' in ended ? ended.output.content : '').toContain('cancelled')
  }, 5000)
})

describe('a hook that throws, with ten plugins installed', () => {
  test('the event says which plugin it was', async () => {
    // "hook preToolCall threw" is not actionable when ten plugins are
    // installed and any of them could be the one.
    const hooks: Hooks[] = [
      {
        preToolCall: () => {
          throw new Error('my fault')
        },
      },
    ]

    const events: LoopEvent[] = []
    for await (const event of runAgentLoop({
      signal: new AbortController().signal,
      provider: scripted([callTool('c1', 'echo', { value: 'hi' }), ...[endTurn('done')]]),
      model: 'test',
      system: '',
      tools: [echo],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      cwd: process.cwd(),
      agentId: 'coder',
      hooks,
      hookNames: ['the-guard'],
    })) {
      events.push(event)
    }

    const failed = events.find((event) => event.type === 'hook_error')
    expect(failed && 'plugin' in failed ? failed.plugin : undefined).toBe('the-guard')
  })
})

describe('how much room a turn gets to answer in', () => {
  /** A provider that answers, and keeps the request it was handed. */
  function watching(asked: { maxTokens?: number }[]) {
    return {
      id: 'watching',
      async *send(request: { maxTokens?: number }) {
        asked.push(request)
        for (const delta of endTurn('ok')) yield delta
      },
    }
  }

  test('is enough for an agent to write a source file', async () => {
    // 8192 was the ceiling for as long as this loop has existed, with no
    // reason written beside it, and it guillotined an agent halfway through
    // the third file of a task: the call it had started arrived empty, never
    // ran, and the team stopped with nothing on screen saying why. The cap is
    // not the spend control — the governor's token budgets are, and say so —
    // so it has no business being tight enough to cut an ordinary answer in
    // half.
    const asked: { maxTokens?: number }[] = []

    await drain(run({ provider: watching(asked) }))

    expect(asked[0]?.maxTokens).toBeGreaterThanOrEqual(32_000)
  })

  test('is settable, for a service that will not accept that much', async () => {
    // The escape hatch that makes the larger default safe: an endpoint that
    // refuses the number can be told a smaller one, per agent, rather than
    // everybody living at the lowest common ceiling.
    const asked: { maxTokens?: number }[] = []

    await drain(run({ provider: watching(asked), maxTokens: 4096 }))

    expect(asked[0]?.maxTokens).toBe(4096)
  })
})

describe('asking for several things at once', () => {
  /** A tool that takes a moment and says when it ran. */
  function slow(name: string, reads: boolean, order: string[]): Tool {
    return {
      name,
      description: 'for a test',
      inputSchema: { type: 'object' },
      ...(reads ? { reads: true } : {}),
      async execute() {
        await new Promise((resolve) => setTimeout(resolve, 30))
        order.push(name)
        return { content: name }
      },
    }
  }

  test('runs the ones that only read at the same time', async () => {
    // A turn that asks for four files waited for each in turn, so four
    // hundred milliseconds of reading took four hundred milliseconds of
    // waiting. Nothing about reading a file needs to happen after reading
    // another one.
    const order: string[] = []
    const tools = ['a', 'b', 'c', 'd'].map((name) => slow(name, true, order))
    const provider = scripted([
      [
        ...tools.flatMap((tool, at) => [
          { type: 'tool_use_start' as const, id: `t${at}`, name: tool.name },
          { type: 'tool_use_delta' as const, id: `t${at}`, partialInput: '{}' },
          { type: 'tool_use_end' as const, id: `t${at}` },
        ]),
        { type: 'done' as const, stopReason: 'tool_use' as const, usage },
      ],
      endTurn('done'),
    ])

    const started = Date.now()
    await drain(run({ provider, tools }))

    // Four thirty-millisecond reads, in one wait rather than four.
    expect(Date.now() - started).toBeLessThan(100)
    expect(order).toHaveLength(4)
  })

  test('keeps anything that changes something in the order it was asked for', async () => {
    // Two calls in one turn may touch the same file, and running those
    // concurrently makes the outcome depend on whichever finishes first.
    const order: string[] = []
    const tools = [
      slow('read-one', true, order),
      slow('write-it', false, order),
      slow('read-two', true, order),
    ]
    const provider = scripted([
      [
        ...tools.flatMap((tool, at) => [
          { type: 'tool_use_start' as const, id: `t${at}`, name: tool.name },
          { type: 'tool_use_delta' as const, id: `t${at}`, partialInput: '{}' },
          { type: 'tool_use_end' as const, id: `t${at}` },
        ]),
        { type: 'done' as const, stopReason: 'tool_use' as const, usage },
      ],
      endTurn('done'),
    ])

    await drain(run({ provider, tools }))

    expect(order).toEqual(['read-one', 'write-it', 'read-two'])
  })

  test('hands the results back in the order they were asked for', async () => {
    // Whatever order they finished in. A model matches results to calls by
    // id, and one that arrives out of order is a conversation providers
    // reject.
    const order: string[] = []
    const tools = ['a', 'b'].map((name) => slow(name, true, order))
    const provider = scripted([
      [
        ...tools.flatMap((tool, at) => [
          { type: 'tool_use_start' as const, id: `t${at}`, name: tool.name },
          { type: 'tool_use_delta' as const, id: `t${at}`, partialInput: '{}' },
          { type: 'tool_use_end' as const, id: `t${at}` },
        ]),
        { type: 'done' as const, stopReason: 'tool_use' as const, usage },
      ],
      endTurn('done'),
    ])

    const { result } = await drain(run({ provider, tools }))
    // The last user message, not the first: the first is the instruction.
    const results =
      result.messages.filter((message) => message.role === 'user').at(-1)?.content ?? []

    expect(results.map((block) => (block.type === 'tool_result' ? block.toolUseId : ''))).toEqual([
      't0',
      't1',
    ])
  })
})
