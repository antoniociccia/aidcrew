import { describe, expect, test } from 'bun:test'
import type { Tool } from './loop.ts'
import { runAgentLoop } from './loop.ts'
import type { Hooks } from './plugins/types.ts'
import type { Message, StreamDelta } from './types.ts'

const usage = { inputTokens: 1, outputTokens: 1 }

function scripted(turns: StreamDelta[][]) {
  const seen: Message[][] = []
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

function callBash(command: string): StreamDelta[] {
  return [
    { type: 'tool_use_start', id: 't1', name: 'bash' },
    { type: 'tool_use_delta', id: 't1', partialInput: JSON.stringify({ command }) },
    { type: 'tool_use_end', id: 't1' },
    { type: 'done', stopReason: 'tool_use', usage },
  ]
}

const endTurn: StreamDelta[] = [
  { type: 'text_delta', text: 'ok' },
  { type: 'done', stopReason: 'end_turn', usage },
]

function fakeBash(record: string[]): Tool {
  return {
    name: 'bash',
    description: 'runs a command',
    inputSchema: { type: 'object' },
    execute: async (input) => {
      const command = (input as { command: string }).command
      record.push(command)
      return { content: `ran ${command}` }
    },
  }
}

async function run(hooks: Hooks[], turns: StreamDelta[][], executed: string[]) {
  const provider = scripted(turns)
  const generator = runAgentLoop({
    provider,
    model: 'm',
    system: '',
    tools: [fakeBash(executed)],
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    hooks,
  })
  for (;;) {
    const step = await generator.next()
    if (step.done) return { result: step.value, provider }
  }
}

describe('tool hooks', () => {
  test('runs the tool when no hook objects', async () => {
    const executed: string[] = []

    await run([], [callBash('ls'), endTurn], executed)

    expect(executed).toEqual(['ls'])
  })

  test('a hook that returns an output cancels the call', async () => {
    const executed: string[] = []
    const deny: Hooks = {
      preToolCall: async (call) => {
        if (call.name === 'bash') return { content: 'denied by policy', isError: true }
      },
    }

    const { provider } = await run([deny], [callBash('rm -rf /'), endTurn], executed)

    expect(executed).toEqual([])
    const result = provider.seen[1]?.at(-1)?.content[0] as { content: string; isError: boolean }
    expect(result.content).toBe('denied by policy')
    expect(result.isError).toBe(true)
  })

  test('a hook that returns nothing lets the call through', async () => {
    const executed: string[] = []
    const watch: Hooks = { preToolCall: async () => undefined }

    await run([watch], [callBash('ls'), endTurn], executed)

    expect(executed).toEqual(['ls'])
  })

  test('the first hook to object wins, and the rest are not consulted', async () => {
    const consulted: string[] = []
    const first: Hooks = {
      preToolCall: async () => {
        consulted.push('first')
        return { content: 'no', isError: true }
      },
    }
    const second: Hooks = {
      preToolCall: async () => {
        consulted.push('second')
      },
    }

    await run([first, second], [callBash('ls'), endTurn], [])

    expect(consulted).toEqual(['first'])
  })

  test('denies the call when an approval hook throws', async () => {
    // Fail closed: a policy that crashed did not approve anything, and
    // treating its failure as consent is how a permission system betrays you.
    const executed: string[] = []
    const broken: Hooks = {
      preToolCall: async () => {
        throw new Error('policy engine unreachable')
      },
    }

    const { provider } = await run([broken], [callBash('ls'), endTurn], executed)

    expect(executed).toEqual([])
    const result = provider.seen[1]?.at(-1)?.content[0] as { content: string; isError: boolean }
    expect(result.isError).toBe(true)
    expect(result.content).toMatch(/policy engine unreachable/)
  })

  test('a post hook can replace the result the model sees', async () => {
    const redact: Hooks = {
      postToolCall: async (_call, output) => ({
        content: output.content.replaceAll('secret', '[redacted]'),
      }),
    }

    const provider = scripted([callBash('cat secret'), endTurn])
    const generator = runAgentLoop({
      provider,
      model: 'm',
      system: '',
      tools: [
        {
          name: 'bash',
          description: '',
          inputSchema: { type: 'object' },
          execute: async () => ({ content: 'the secret is 42' }),
        },
      ],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hooks: [redact],
    })
    for (;;) {
      if ((await generator.next()).done) break
    }

    const result = provider.seen[1]?.at(-1)?.content[0] as { content: string }
    expect(result.content).toBe('the [redacted] is 42')
  })

  test('a post hook that throws leaves the original result intact', async () => {
    // Unlike approval, a failing post hook must not lose work already done.
    const broken: Hooks = {
      postToolCall: async () => {
        throw new Error('formatter crashed')
      },
    }
    const executed: string[] = []

    const { provider } = await run([broken], [callBash('ls'), endTurn], executed)

    expect(executed).toEqual(['ls'])
    const result = provider.seen[1]?.at(-1)?.content[0] as { content: string }
    expect(result.content).toBe('ran ls')
  })

  test('post hooks chain, each seeing the previous one output', async () => {
    const upper: Hooks = {
      postToolCall: async (_c, output) => ({ content: output.content.toUpperCase() }),
    }
    const exclaim: Hooks = {
      postToolCall: async (_c, output) => ({ content: `${output.content}!` }),
    }

    const { provider } = await run([upper, exclaim], [callBash('ls'), endTurn], [])

    const result = provider.seen[1]?.at(-1)?.content[0] as { content: string }
    expect(result.content).toBe('RAN LS!')
  })

  test('surfaces a hook failure as an event rather than swallowing it', async () => {
    const broken: Hooks = {
      postToolCall: async () => {
        throw new Error('formatter crashed')
      },
    }
    const provider = scripted([callBash('ls'), endTurn])
    const generator = runAgentLoop({
      provider,
      model: 'm',
      system: '',
      tools: [fakeBash([])],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hooks: [broken],
    })

    const events = []
    for (;;) {
      const step = await generator.next()
      if (step.done) break
      events.push(step.value)
    }

    const failure = events.find((e) => e.type === 'hook_error')
    expect(failure).toMatchObject({ hook: 'postToolCall', message: 'formatter crashed' })
  })

  test('sees the call the model actually asked for', async () => {
    const seen: unknown[] = []
    const spy: Hooks = {
      preToolCall: async (call) => {
        seen.push(call)
      },
    }

    await run([spy], [callBash('git push'), endTurn], [])

    expect(seen[0]).toEqual({ id: 't1', name: 'bash', input: { command: 'git push' } })
  })
})

/**
 * Several read-only calls in one turn are run together, which is what makes
 * four reads cost one round trip instead of four. They used to be run through
 * a path with no hooks on it at all, on the reasoning that a read has nothing
 * to guard — but `postToolCall` exists for redaction and audit, which are
 * read-side by definition, and a read-side `preToolCall` is how anybody writes
 * a path allowlist. Whether a hook ran depended on how many files the model
 * happened to ask for, which is not a property anybody can reason about.
 */
describe('tool hooks when a turn asks for several files at once', () => {
  function reader(record: string[]): Tool {
    return {
      name: 'read',
      description: 'reads a file',
      inputSchema: { type: 'object' },
      reads: true,
      execute: async (input) => {
        const path = (input as { path: string }).path
        record.push(path)
        return { content: `contents of ${path}` }
      },
    }
  }

  function callReads(...paths: string[]): StreamDelta[] {
    return [
      ...paths.flatMap((path, at) => [
        { type: 'tool_use_start' as const, id: `r${at}`, name: 'read' },
        { type: 'tool_use_delta' as const, id: `r${at}`, partialInput: JSON.stringify({ path }) },
        { type: 'tool_use_end' as const, id: `r${at}` },
      ]),
      { type: 'done' as const, stopReason: 'tool_use' as const, usage },
    ]
  }

  async function runReads(hooks: Hooks[], turns: StreamDelta[][], read: string[]) {
    const generator = runAgentLoop({
      provider: scripted(turns),
      model: 'm',
      system: '',
      tools: [reader(read)],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hooks,
    })
    const events = []
    for (;;) {
      const step = await generator.next()
      if (step.done) return { result: step.value, events }
      events.push(step.value)
    }
  }

  test('a preToolCall that refuses is asked about every read in the batch', async () => {
    const read: string[] = []
    const refusing: Hooks = {
      preToolCall: async () => ({ content: 'denied', isError: true }),
    }

    const { result } = await runReads([refusing], [callReads('a.ts', 'b.ts'), endTurn], read)

    expect(read).toEqual([])
    const results = result.messages.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_result'),
    )
    expect(results).toHaveLength(2)
    for (const block of results) expect(block).toMatchObject({ isError: true })
  })

  test('a preToolCall can refuse one read and let the other through', async () => {
    const read: string[] = []
    const picky: Hooks = {
      preToolCall: async (call) =>
        (call.input as { path: string }).path === 'secret.ts'
          ? { content: 'denied', isError: true }
          : undefined,
    }

    await runReads([picky], [callReads('secret.ts', 'fine.ts'), endTurn], read)

    expect(read).toEqual(['fine.ts'])
  })

  test('a postToolCall rewrites every read in the batch', async () => {
    const read: string[] = []
    const redacting: Hooks = {
      postToolCall: async () => ({ content: '[redacted]' }),
    }

    const { result } = await runReads([redacting], [callReads('a.ts', 'b.ts'), endTurn], read)

    const texts = result.messages
      .flatMap((message) => message.content)
      .filter((block) => block.type === 'tool_result')
      .map((block) => block.content)
    expect(texts).toEqual(['[redacted]', '[redacted]'])
  })

  test('a hook that throws is reported once per call, naming the plugin', async () => {
    const broken: Hooks = {
      preToolCall: async () => {
        throw new Error('guard crashed')
      },
    }

    const generator = runAgentLoop({
      provider: scripted([callReads('a.ts', 'b.ts'), endTurn]),
      model: 'm',
      system: '',
      tools: [reader([])],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hooks: [broken],
      hookNames: ['hooks-guard'],
    })
    const events = []
    for (;;) {
      const step = await generator.next()
      if (step.done) break
      events.push(step.value)
    }

    const failures = events.filter((event) => event.type === 'hook_error')
    expect(failures).toHaveLength(2)
    expect(failures[0]).toMatchObject({ hook: 'preToolCall', plugin: 'hooks-guard' })
  })

  test('the reads still go at once, which is why they are batched', async () => {
    let inFlight = 0
    let mostAtOnce = 0
    const slow: Tool = {
      name: 'read',
      description: 'reads a file',
      inputSchema: { type: 'object' },
      reads: true,
      execute: async () => {
        inFlight += 1
        mostAtOnce = Math.max(mostAtOnce, inFlight)
        await new Promise((resolve) => setTimeout(resolve, 5))
        inFlight -= 1
        return { content: 'ok' }
      },
    }

    const generator = runAgentLoop({
      provider: scripted([callReads('a.ts', 'b.ts', 'c.ts'), endTurn]),
      model: 'm',
      system: '',
      tools: [slow],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
      hooks: [{ preToolCall: async () => undefined }],
    })
    for (;;) {
      const step = await generator.next()
      if (step.done) break
    }

    expect(mostAtOnce).toBe(3)
  })
})
