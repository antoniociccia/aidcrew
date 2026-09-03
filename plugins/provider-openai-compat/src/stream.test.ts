import { describe, expect, test } from 'bun:test'
import type { StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import { parseOpenAiStream } from './stream.ts'

const encoder = new TextEncoder()

function sse(payloads: (object | string)[]): AsyncIterable<Uint8Array> {
  const body = payloads
    .map((p) => `data: ${typeof p === 'string' ? p : JSON.stringify(p)}\n\n`)
    .join('')
  return (async function* () {
    yield encoder.encode(body)
  })()
}

/** A body exactly as sent, for the cases where it is not a stream at all. */
function raw(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield encoder.encode(text)
  })()
}

async function collect(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const delta of stream) out.push(delta)
  return out
}

function deltas(payloads: (object | string)[]): Promise<StreamDelta[]> {
  return collect(parseOpenAiStream(sse(payloads), 'test'))
}

const textChunk = (content: string) => ({ choices: [{ index: 0, delta: { content } }] })
const finish = (reason: string) => ({ choices: [{ index: 0, delta: {}, finish_reason: reason }] })
const usageChunk = { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3 } }

/**
 * A dialect that identifies a call by its position and never sends an id.
 *
 * The id is optional in the wire format, and several services leave it out:
 * the index is the identity, the name comes in the first chunk and the
 * arguments in the ones after it. Read as a continuation of a call that was
 * never opened, the whole turn died with "tool call at index 0 continued
 * before it was opened" — watched on qwen3.8-flash, on the first request of
 * a session, every time.
 */
/**
 * One call whose chunks are keyed two different ways.
 *
 * Watched on qwen3.8-flash through opencode-go: the chunk carrying the name
 * has an id and no index, and every chunk after it has an index and no id.
 * Keyed by whichever field is present, those are two slots, so the name
 * opened one call and the arguments opened another — `bash` arrived with no
 * arguments at all ("expected string, received undefined") and a second,
 * nameless call arrived carrying them ("unknown tool: ").
 *
 * A call is one call. Both keys point at it, and a chunk carrying either
 * finds it.
 */
/**
 * The chunks qwen3.8-flash sends, copied off the wire.
 *
 * Two calls in one turn. The chunk that opens each carries an index, a real
 * id and the name; every chunk after it carries the index and `id: ""` — an
 * empty string, not an absent field. Read as an id, that empty string became
 * a key of its own, so the first call was registered under it and every later
 * continuation of every later call resolved to the first: `bash` ended up
 * holding both calls' arguments — `{"command": "ls -la"}{"pattern": "**\/*"}`,
 * which is not JSON — and `glob` ended up holding none, which is what reached
 * the screen as "expected string, received undefined".
 */
describe('the stream a real model sends', () => {
  const opens = (index: number, id: string, name: string) => ({
    choices: [
      {
        delta: { tool_calls: [{ index, id, type: 'function', function: { name, arguments: '' } }] },
      },
    ],
  })
  const continues = (index: number, args: string) => ({
    choices: [
      {
        delta: { tool_calls: [{ index, id: '', type: 'function', function: { arguments: args } }] },
      },
    ],
  })

  test('keeps two calls apart when every continuation says id is empty', async () => {
    const said = await deltas([
      opens(0, 'call_a139', 'bash'),
      continues(0, '{"command": '),
      continues(0, '"ls -la'),
      continues(0, '"'),
      continues(0, '}'),
      opens(1, 'call_2573', 'glob'),
      continues(1, '{"pattern": "**'),
      continues(1, '/*'),
      continues(1, '"'),
      continues(1, '}'),
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const built = new Map<string, { name: string; args: string }>()
    for (const delta of said) {
      if (delta.type === 'tool_use_start') built.set(delta.id, { name: delta.name, args: '' })
      if (delta.type === 'tool_use_delta') {
        const held = built.get(delta.id)
        expect(held, `a delta for a call nobody opened: ${delta.id}`).toBeDefined()
        if (held) held.args += delta.partialInput
      }
    }

    expect([...built.values()]).toEqual([
      { name: 'bash', args: '{"command": "ls -la"}' },
      { name: 'glob', args: '{"pattern": "**/*"}' },
    ])
  })
})

describe('a tool call whose chunks are keyed inconsistently', () => {
  test('an id first, then indices, is one call with its arguments', async () => {
    const said = await deltas([
      { choices: [{ delta: { tool_calls: [{ id: 'call_x', function: { name: 'bash' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] } },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    expect(said.filter((delta) => delta.type === 'tool_use_start')).toEqual([
      { type: 'tool_use_start', id: 'call_x', name: 'bash' },
    ])
    expect(
      said
        .filter((delta) => delta.type === 'tool_use_delta')
        .map((delta) => ('partialInput' in delta ? delta.partialInput : ''))
        .join(''),
    ).toBe('{"command":"ls"}')
  })

  test('an index first, then ids, is one call too', async () => {
    const said = await deltas([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'glob' } }] } }] },
      {
        choices: [
          { delta: { tool_calls: [{ id: 'call_y', function: { arguments: '{"pattern":"*"}' } }] } },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    expect(said.filter((delta) => delta.type === 'tool_use_start')).toHaveLength(1)
    expect(
      said
        .filter((delta) => delta.type === 'tool_use_delta')
        .map((delta) => ('partialInput' in delta ? delta.partialInput : ''))
        .join(''),
    ).toBe('{"pattern":"*"}')
  })

  test('arguments with neither key join the call they are plainly part of', async () => {
    const said = await deltas([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ function: { arguments: '{"path":"a"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    expect(said.filter((delta) => delta.type === 'tool_use_start')).toHaveLength(1)
    expect(said.filter((delta) => delta.type === 'tool_use_delta')).toHaveLength(1)
  })
})

describe('a tool call with no id at all', () => {
  test('is opened on its index, which is the only identity it has', async () => {
    const said = await deltas([
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'read' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const started = said.find((delta) => delta.type === 'tool_use_start')
    expect(started).toMatchObject({ name: 'read' })
    const id = started && 'id' in started ? started.id : ''
    expect(id).not.toBe('')
    expect(
      said
        .filter((delta) => delta.type === 'tool_use_delta')
        .map((delta) => ('partialInput' in delta ? delta.partialInput : ''))
        .join(''),
    ).toBe('{"path":"a.ts"}')
    expect(said.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })
  })

  test('two of them in one turn stay two calls, by their two indices', async () => {
    const said = await deltas([
      {
        choices: [
          {
            delta: {
              tool_calls: [
                { index: 0, function: { name: 'read', arguments: '{"path":"a"}' } },
                { index: 1, function: { name: 'grep', arguments: '{"pattern":"x"}' } },
              ],
            },
          },
        ],
      },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])

    const opened = said.filter((delta) => delta.type === 'tool_use_start')
    expect(opened.map((delta) => ('name' in delta ? delta.name : ''))).toEqual(['read', 'grep'])
    const ids = opened.map((delta) => ('id' in delta ? delta.id : ''))
    expect(new Set(ids).size).toBe(2)
  })
})

describe('parseOpenAiStream', () => {
  test('turns content chunks into text deltas', async () => {
    const out = await deltas([textChunk('He'), textChunk('llo'), finish('stop'), '[DONE]'])

    expect(out).toEqual([
      { type: 'text_delta', text: 'He' },
      { type: 'text_delta', text: 'llo' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('reports usage from the final chunk, which arrives after finish_reason', async () => {
    const out = await deltas([textChunk('hi'), finish('stop'), usageChunk, '[DONE]'])

    expect(out.at(-1)).toEqual({
      type: 'done',
      stopReason: 'end_turn',
      usage: { inputTokens: 7, outputTokens: 3 },
    })
  })

  test('reads reasoning_content as thinking, the way deepseek and glm send it', async () => {
    const out = await deltas([
      { choices: [{ index: 0, delta: { reasoning_content: 'let me think' } }] },
      finish('stop'),
    ])

    expect(out[0]).toEqual({ type: 'thinking_delta', text: 'let me think' })
  })

  test('opens a tool call on the chunk that carries its name, then streams arguments', async () => {
    const out = await deltas([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'read', arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"p' } }] } },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '":1}' } }] } },
        ],
      },
      finish('tool_calls'),
    ])

    expect(out).toEqual([
      { type: 'tool_use_start', id: 'c1', name: 'read' },
      { type: 'tool_use_delta', id: 'c1', partialInput: '{"p' },
      { type: 'tool_use_delta', id: 'c1', partialInput: '":1}' },
      { type: 'tool_use_end', id: 'c1' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('keeps two concurrent tool calls apart by their index', async () => {
    const out = await deltas([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [
                { index: 0, id: 'a', function: { name: 'read', arguments: '' } },
                { index: 1, id: 'b', function: { name: 'bash', arguments: '' } },
              ],
            },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 1, function: { arguments: '{}' } }] } },
        ],
      },
      finish('tool_calls'),
    ])

    expect(out).toContainEqual({ type: 'tool_use_delta', id: 'b', partialInput: '{}' })
    expect(out.filter((d) => d.type === 'tool_use_end').map((d) => d.id)).toEqual(['a', 'b'])
  })

  test('opens a second call when a new id arrives at an index already in use', async () => {
    // Gemini's OpenAI-compatible endpoint, and some proxies, number every
    // call 0. Keyed by index alone, the second call was read as more of the
    // first: its name was dropped, its arguments were glued onto the other
    // call's, the accumulator refused the result as invalid JSON, and the
    // turn died — on exactly the turns where the model had the most to do.
    const out = await deltas([
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'a', function: { name: 'read', arguments: '{"p":1}' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            index: 0,
            delta: {
              tool_calls: [{ index: 0, id: 'b', function: { name: 'bash', arguments: '{"c":2}' } }],
            },
          },
        ],
      },
      finish('tool_calls'),
    ])

    expect(out).toEqual([
      { type: 'tool_use_start', id: 'a', name: 'read' },
      { type: 'tool_use_delta', id: 'a', partialInput: '{"p":1}' },
      { type: 'tool_use_end', id: 'a' },
      { type: 'tool_use_start', id: 'b', name: 'bash' },
      { type: 'tool_use_delta', id: 'b', partialInput: '{"c":2}' },
      { type: 'tool_use_end', id: 'b' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('keys a call by its id when it comes with no index at all', async () => {
    const out = await deltas([
      {
        choices: [
          {
            index: 0,
            delta: { tool_calls: [{ id: 'a', function: { name: 'read', arguments: '' } }] },
          },
        ],
      },
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ id: 'a', function: { arguments: '{}' } }] } },
        ],
      },
      finish('tool_calls'),
    ])

    expect(out).toEqual([
      { type: 'tool_use_start', id: 'a', name: 'read' },
      { type: 'tool_use_delta', id: 'a', partialInput: '{}' },
      { type: 'tool_use_end', id: 'a' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('maps the finish reasons the canonical model distinguishes', async () => {
    for (const [reason, expected] of [
      ['stop', 'end_turn'],
      ['tool_calls', 'tool_use'],
      ['length', 'max_tokens'],
      ['content_filter', 'refusal'],
    ] as const) {
      const out = await deltas([textChunk('x'), finish(reason)])
      expect(out.at(-1)).toMatchObject({ type: 'done', stopReason: expected })
    }
  })

  test('still ends the turn when the server never sends finish_reason', async () => {
    const out = await deltas([textChunk('hi')])

    expect(out.at(-1)).toMatchObject({ type: 'done', stopReason: 'end_turn' })
  })

  test('infers a tool turn when a truncated stream had opened a tool call', async () => {
    const out = await deltas([
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read' } }] } },
        ],
      },
    ])

    expect(out.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })
  })

  test('raises the error a gateway reports inside the stream', async () => {
    const failing = deltas([{ error: { message: 'rate limit exceeded', type: 'rate_limit' } }])

    expect(failing).rejects.toThrow(/rate limit exceeded/)
  })

  test('names the provider when a chunk is not valid json', async () => {
    expect(deltas(['{not json'])).rejects.toThrow(/test/)
  })

  test('ignores keep-alive chunks that carry no choices', async () => {
    const out = await deltas([{ choices: [] }, textChunk('hi'), finish('stop')])

    expect(out.filter((d) => d.type === 'text_delta')).toHaveLength(1)
  })
})

describe('a 200 that was not a stream', () => {
  async function failureOf(text: string): Promise<ProviderResponseError> {
    try {
      await collect(parseOpenAiStream(raw(text), 'test'))
    } catch (cause) {
      return cause as ProviderResponseError
    }
    throw new Error('expected the stream to fail')
  }

  test('raises what the body said when it was a json error', async () => {
    // Some gateways answer 200 to everything and put the refusal in the
    // body. With no `data:` lines in it the parser found no events, and an
    // empty turn that cost nothing came out — the model, apparently, had
    // chosen to say nothing, on every turn, and the reason was never shown.
    const failure = await failureOf('{"error":{"message":"model \\"gpt-9\\" not found"}}')

    expect(failure).toBeInstanceOf(ProviderResponseError)
    expect(failure.message).toContain('model "gpt-9" not found')
    expect(failure.retryable).toBe(false)
  })

  test('quotes the start of a body it cannot make sense of', async () => {
    const failure = await failureOf('<html><title>Sign in</title></html>')

    expect(failure.message).toContain('test')
    expect(failure.message).toContain('<html><title>Sign in')
  })

  test('says so when the body was empty', async () => {
    const failure = await failureOf('')

    expect(failure.message).toMatch(/empty/i)
  })

  test('reads a completion a gateway sent whole, having ignored stream:true', async () => {
    // Not a refusal: the answer is all there, in the non-streaming shape,
    // with `message` where a chunk has `delta`. Reading it is the difference
    // between such a gateway working and being unusable.
    const out = await collect(
      parseOpenAiStream(
        raw(
          JSON.stringify({
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: {
                  role: 'assistant',
                  content: 'Listing.',
                  tool_calls: [
                    {
                      id: 'c1',
                      type: 'function',
                      function: { name: 'bash', arguments: '{"c":"ls"}' },
                    },
                  ],
                },
                finish_reason: 'tool_calls',
              },
            ],
            usage: { prompt_tokens: 7, completion_tokens: 3 },
          }),
        ),
        'test',
      ),
    )

    expect(out).toEqual([
      { type: 'text_delta', text: 'Listing.' },
      { type: 'tool_use_start', id: 'c1', name: 'bash' },
      { type: 'tool_use_delta', id: 'c1', partialInput: '{"c":"ls"}' },
      { type: 'tool_use_end', id: 'c1' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 7, outputTokens: 3 } },
    ])
  })
})

describe('the part of the prompt the service did not read again', () => {
  test('is counted apart, and taken off the fresh input', () => {
    // Two million input tokens went into writing one plugin and the cached
    // figure read zero, because this dialect reported `prompt_tokens` and
    // nothing else. Services that cache report the cached part inside
    // `prompt_tokens_details`, billed at a fraction — so a session looked
    // like it paid full price for a conversation it was largely handed back
    // for free, and the one number that says whether caching is working at
    // all was invisible.
    //
    // Taken off rather than added: unlike Anthropic's, this dialect's
    // `prompt_tokens` is the whole prompt with the cached part inside it, and
    // counting both charges for it twice.
    return deltas([
      finish('stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 12_000,
          completion_tokens: 40,
          prompt_tokens_details: { cached_tokens: 11_500 },
        },
      },
      '[DONE]',
    ]).then((out) => {
      const done = out.find((delta) => delta.type === 'done')
      expect(done?.type === 'done' ? done.usage : undefined).toMatchObject({
        inputTokens: 500,
        outputTokens: 40,
        cacheReadTokens: 11_500,
      })
    })
  })

  test('says nothing about a cache the service did not mention', async () => {
    const out = await deltas([finish('stop'), usageChunk, '[DONE]'])
    const done = out.find((delta) => delta.type === 'done')

    expect(done?.type === 'done' ? done.usage.cacheReadTokens : 'x').toBeUndefined()
    expect(done?.type === 'done' ? done.usage.inputTokens : 0).toBe(7)
  })
})

describe('reasoning under its other name', () => {
  test('reads `reasoning` as thinking, the way openrouter-style gateways send it', async () => {
    // OpenCode Go streams `reasoning` (plus a `reasoning_details` array saying
    // the same thing), not the `reasoning_content` deepseek uses. Dropping it
    // was not merely a missing display: a free model spent its entire token
    // budget reasoning, emitted no visible text and never reached the tool
    // call, and from the outside the turn looked like the model had answered
    // with nothing. The tokens were charged either way.
    const out = await deltas([
      { choices: [{ index: 0, delta: { reasoning: 'weighing it up' } }] },
      { choices: [{ index: 0, delta: { content: 'done' } }] },
    ])

    expect(out).toContainEqual({ type: 'thinking_delta', text: 'weighing it up' })
    expect(out).toContainEqual({ type: 'text_delta', text: 'done' })
  })

  test('does not say the same thought twice when both names arrive', async () => {
    const out = await deltas([
      { choices: [{ index: 0, delta: { reasoning: 'once', reasoning_content: 'once' } }] },
    ])

    expect(out.filter((one) => one.type === 'thinking_delta')).toEqual([
      { type: 'thinking_delta', text: 'once' },
    ])
  })
})

describe('payloads that are legal but not chunks', () => {
  test('ignores a null, rather than crashing on it', async () => {
    // `data: null` is a legal event. Read as a chunk it threw a TypeError
    // from inside the parser — not a provider error, not a protocol error,
    // just a crash with a stack trace where the answer should have been.
    const out = await deltas(['null', textChunk('hi'), finish('stop')])

    expect(out).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('ignores an array, which is not a chunk either', async () => {
    const out = await deltas(['[1,2]', textChunk('hi'), finish('stop')])

    expect(out[0]).toEqual({ type: 'text_delta', text: 'hi' })
  })
})

describe('the cached part of the prompt under the name deepseek gives it', () => {
  test('is read from prompt_cache_hit_tokens when the standard field is absent', async () => {
    // DeepSeek reported its cache first, under its own names, and some of its
    // gateways still send only those. Unread, every cached token was billed
    // at the full input rate — on a long conversation, most of the bill.
    const out = await deltas([
      textChunk('hi'),
      finish('stop'),
      {
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 5,
          prompt_cache_hit_tokens: 80,
          prompt_cache_miss_tokens: 20,
        },
      },
    ])

    expect(out.at(-1)).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 },
    })
  })
})
