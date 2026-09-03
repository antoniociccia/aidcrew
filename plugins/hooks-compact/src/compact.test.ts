import { describe, expect, test } from 'bun:test'
import type { Message, Provider, StreamDelta, TurnContext, Usage } from '@aidcrew/core'
import { DEFAULT_BUDGET, plan } from './decide.ts'
import { createCompactor, parseCompactWith } from './plugin.ts'

const said = (role: 'user' | 'assistant', text: string): Message => ({
  role,
  content: [{ type: 'text', text }],
})

const called = (id: string): Message => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 'bash', input: { command: 'ls' } }],
})

const answered = (id: string): Message => ({
  role: 'user',
  content: [{ type: 'tool_result', toolUseId: id, content: 'ok', isError: false }],
})

const usage = (inputTokens: number): Usage => ({ inputTokens, outputTokens: 100 })
const budget = { compactAt: 1000, keep: 2 }

describe('deciding whether to shorten', () => {
  test('leaves a conversation alone while it still fits', () => {
    const decided = plan([said('user', 'a'), said('assistant', 'b')], usage(10), budget)

    expect(decided).toEqual({ compact: false, because: 'it still fits' })
  })

  test('measures by what the last turn actually cost', () => {
    // Nothing tells a harness how much room is left, and estimating from the
    // text means using a tokeniser that is not the model's. What a request
    // cost, as the provider counted it, is the one true number available.
    const long = Array.from({ length: 20 }, (_, at) =>
      said(at % 2 === 0 ? 'user' : 'assistant', `line ${at}`),
    )

    expect(plan(long, usage(999), budget).compact).toBe(false)
    expect(plan(long, usage(1000), budget).compact).toBe(true)
  })

  test('counts what was read from a cache as part of the prompt', () => {
    // A cached read is a token the model saw. It is billed at a tenth of the
    // rate and reported apart from the rest for exactly that reason, and this
    // decision is not about money — it is about whether the conversation
    // still fits. Reading only the uncached part made a heavily cached
    // conversation look small and never shortened it, which is precisely the
    // long conversation caching produces.
    const long = Array.from({ length: 20 }, (_, at) =>
      said(at % 2 === 0 ? 'user' : 'assistant', `line ${at}`),
    )

    expect(
      plan(long, { inputTokens: 100, outputTokens: 0, cacheReadTokens: 900 }, budget).compact,
    ).toBe(true)
  })

  test('has nothing to do when everything is recent', () => {
    const decided = plan([said('user', 'a'), said('assistant', 'b')], usage(5000), budget)

    expect(decided).toMatchObject({ compact: false })
  })
})

describe('choosing where to cut', () => {
  test('keeps the most recent exchanges untouched', () => {
    // The end is what the model is reasoning from — the file it just read, the
    // error it just saw — and summarising that loses the thread it was holding.
    const history = [
      said('user', 'one'),
      said('assistant', 'two'),
      said('user', 'three'),
      said('assistant', 'four'),
    ]

    const decided = plan(history, usage(5000), { compactAt: 1000, keep: 2 })

    expect(decided.compact && decided.keep).toEqual([
      said('user', 'three'),
      said('assistant', 'four'),
    ])
  })

  test('never cuts between a tool call and its answer', () => {
    // A call in the summary whose result is in the kept part leaves the model
    // holding an answer to a question it can no longer see, which providers
    // reject outright.
    const history = [
      said('user', 'one'),
      called('t1'),
      answered('t1'),
      said('assistant', 'done'),
      said('user', 'next'),
      called('t2'),
      answered('t2'),
    ]

    const decided = plan(history, usage(5000), { compactAt: 1000, keep: 3 })
    if (!decided.compact) throw new Error('expected it to compact')

    const open = new Set<string>()
    for (const message of decided.summarise) {
      for (const block of message.content) {
        if (block.type === 'tool_use') open.add(block.id)
        if (block.type === 'tool_result') open.delete(block.toolUseId)
      }
    }

    expect([...open]).toEqual([])
  })

  test('starts what it keeps at a turn rather than mid-exchange', () => {
    const history = [
      said('user', 'one'),
      called('t1'),
      answered('t1'),
      said('user', 'two'),
      said('assistant', 'three'),
    ]

    const decided = plan(history, usage(5000), { compactAt: 1000, keep: 2 })

    expect(decided.compact && decided.keep[0]?.role).toBe('user')
  })

  test('does nothing rather than cutting badly when there is no safe place', () => {
    const decided = plan([called('t1'), answered('t1'), said('assistant', 'x')], usage(5000), {
      compactAt: 1000,
      keep: 1,
    })

    expect(decided.compact).toBe(false)
  })
})

function provider(id: string, answer: string | Error): Provider {
  return {
    id,
    async *send(): AsyncIterable<StreamDelta> {
      if (answer instanceof Error) throw answer
      yield { type: 'text_delta', text: answer }
      yield { type: 'done', stopReason: 'end_turn', usage: usage(1) }
    },
  }
}

/** A provider that answers, and writes down which model it was asked for. */
function recording(id: string, asked: string[]): Provider {
  return {
    id,
    async *send(request): AsyncIterable<StreamDelta> {
      asked.push(request.model)
      yield { type: 'text_delta', text: 'the notes' }
      yield { type: 'done', stopReason: 'end_turn', usage: usage(1) }
    },
  }
}

const context = (over: Partial<TurnContext> = {}): TurnContext => ({
  agentId: 'coder',
  model: 'a-model',
  lastUsage: usage(5000),
  turn: 9,
  signal: new AbortController().signal,
  ...over,
})

const history = Array.from({ length: 12 }, (_, at) =>
  said(at % 2 === 0 ? 'user' : 'assistant', `line ${at}`),
)

describe('writing the summary', () => {
  test('uses the cheaper model when one is named', () => {
    // Summarising is small and mechanical, and the expensive model should not
    // be spending its budget on housekeeping.
    const reports: string[] = []
    const hook = createCompactor({
      budgetFor: () => budget,
      summariserFor: () => provider('cheap', 'they were fixing the token'),
      providerFor: () => provider('expensive', 'should not be asked'),
      handlesItsOwn: () => false,
      onCompacted: (report) => reports.push(report.by),
    })

    return hook.preTurn?.(history, context()).then((replaced) => {
      expect(reports).toEqual(['cheap'])
      expect(replaced?.[0]?.content[0]).toMatchObject({
        text: expect.stringContaining('they were fixing the token'),
      })
    })
  })

  test('falls back to the agent, and says why', async () => {
    const reports: { by: string; why?: string | undefined }[] = []
    const hook = createCompactor({
      budgetFor: () => budget,
      summariserFor: () => provider('cheap', new Error('no credit')),
      providerFor: () => provider('expensive', 'the notes'),
      handlesItsOwn: () => false,
      onCompacted: (report) => reports.push({ by: report.by, why: report.fellBackBecause }),
    })

    await hook.preTurn?.(history, context())

    expect(reports).toEqual([{ by: 'expensive', why: 'no credit' }])
  })

  test("asks the cheaper provider for the model it was named with, not the agent's", async () => {
    // A cheaper provider was named to save the expensive model's budget, and
    // then asked for the expensive model's id — which it does not serve. So it
    // failed every time, the expensive one summarised anyway, and every
    // shortening carried a note saying the cheaper one had failed.
    const asked: string[] = []
    const hook = createCompactor({
      budgetFor: () => budget,
      summariserFor: () => recording('cheap', asked),
      summaryModelFor: () => 'small-1',
      providerFor: () => provider('expensive', 'should not be asked'),
      handlesItsOwn: () => false,
    })

    await hook.preTurn?.(history, context({ model: 'big-1' }))

    expect(asked).toEqual(['small-1'])
  })

  test("asks the agent's own provider for the agent's own model, even when a summary model is named", async () => {
    // The named model belongs to the cheaper provider. When that one fails
    // and the agent's own is asked instead, the model it serves is the
    // agent's, not the cheap one's.
    const asked: string[] = []
    const hook = createCompactor({
      budgetFor: () => budget,
      summariserFor: () => provider('cheap', new Error('no credit')),
      summaryModelFor: () => 'small-1',
      providerFor: () => recording('expensive', asked),
      handlesItsOwn: () => false,
    })

    await hook.preTurn?.(history, context({ model: 'big-1' }))

    expect(asked).toEqual(['big-1'])
  })

  test('says the summary is a summary, rather than passing it off as memory', async () => {
    // An agent that cannot tell its notes from its memory will defend a
    // summary it never wrote.
    const hook = createCompactor({
      budgetFor: () => budget,
      summariserFor: () => undefined,
      providerFor: () => provider('own', 'the notes'),
      handlesItsOwn: () => false,
    })

    const replaced = await hook.preTurn?.(history, context())
    const first = replaced?.[0]?.content[0]

    expect(first?.type === 'text' && first.text).toContain('summarised')
  })

  test('leaves the conversation alone when nothing can write a summary', async () => {
    // Too long still works more often than a conversation with a hole in it.
    const hook = createCompactor({
      budgetFor: () => budget,
      summariserFor: () => undefined,
      providerFor: () => undefined,
      handlesItsOwn: () => false,
    })

    expect(await hook.preTurn?.(history, context())).toBeUndefined()
  })

  test('leaves an agent that shortens its own history entirely alone', async () => {
    // Another coding program keeps its own conversation. Compacting here would
    // be shortening our copy of something we do not hold.
    let asked = false
    const hook = createCompactor({
      budgetFor: () => {
        asked = true
        return budget
      },
      summariserFor: () => undefined,
      providerFor: () => undefined,
      handlesItsOwn: () => true,
    })

    expect(await hook.preTurn?.(history, context())).toBeUndefined()
    expect(asked).toBe(false)
  })
})

describe('reading what compactWith names', () => {
  test('splits provider from model at the first slash, so a model id may hold one', () => {
    expect(parseCompactWith('zen/qwen/qwen3-8b')).toEqual({
      provider: 'zen',
      model: 'qwen/qwen3-8b',
    })
  })

  test("a bare provider names no model, and is asked for the agent's own", () => {
    expect(parseCompactWith('zen')).toEqual({ provider: 'zen' })
  })
})

describe('the default budget', () => {
  test('leaves room for the turn that discovers the conversation is too long', () => {
    // The measure lags by one turn, which is the price of not guessing.
    expect(DEFAULT_BUDGET.compactAt).toBeLessThan(200_000)
    expect(DEFAULT_BUDGET.keep).toBeGreaterThan(4)
  })
})
