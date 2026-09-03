import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import plugin from './plugin.ts'
import { createAnthropicProvider, listAnthropicModels } from './provider.ts'
import { buildRequestBody } from './request.ts'
import { parseAnthropicStream } from './stream.ts'

const encoder = new TextEncoder()

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'claude-opus-5',
    system: 'Be brief.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  }
}

function events(list: object[]): AsyncIterable<Uint8Array> {
  const body = list.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
  return (async function* () {
    yield encoder.encode(body)
  })()
}

async function deltas(list: object[]): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const delta of parseAnthropicStream(events(list), 'anthropic')) out.push(delta)
  return out
}

/** What a stream produced before it failed, and what it failed with. */
async function outcome(
  stream: AsyncIterable<StreamDelta>,
): Promise<{ seen: StreamDelta[]; error: unknown }> {
  const seen: StreamDelta[] = []
  try {
    for await (const delta of stream) seen.push(delta)
    return { seen, error: undefined }
  } catch (error) {
    return { seen, error }
  }
}

const config = { apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', version: '2023-06-01' }

describe('buildRequestBody', () => {
  test('sends the system prompt as a top-level field, not a message', () => {
    const body = buildRequestBody(request())

    // A block rather than a string since it carries a cache marker; still a
    // top-level field, which is the thing this test is about.
    expect(body.system?.[0]?.text).toBe('Be brief.')
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
  })

  test('drops a system message from the conversation, which this API rejects', () => {
    const body = buildRequestBody(
      request({
        messages: [
          { role: 'system', content: [{ type: 'text', text: 'stray' }] },
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        ],
      }),
    )

    expect(body.messages).toHaveLength(1)
    expect(body.messages[0]?.role).toBe('user')
  })

  test('omits system entirely when there is none', () => {
    expect(buildRequestBody(request({ system: '' })).system).toBeUndefined()
  })

  test('keeps tool results inside a user message, where this API wants them', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok', isError: false }],
          },
        ],
      }),
    )

    expect(body.messages[0]).toEqual({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'ok', is_error: false }],
    })
  })

  test('declares tools with input_schema', () => {
    const body = buildRequestBody(
      request({
        tools: [{ name: 'read', description: 'Read.', inputSchema: { type: 'object' } }],
      }),
    )

    // The cache marker rides on the last one; the shape this test is about is
    // the rest of it.
    expect(body.tools?.[0]).toMatchObject({
      name: 'read',
      description: 'Read.',
      input_schema: { type: 'object' },
    })
  })

  test('drops thinking blocks, which cannot be sent back', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'hmm' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    )

    expect(body.messages[0]?.content).toEqual([{ type: 'text', text: 'answer' }])
  })

  test('never sends an assistant turn with nothing in it, which this API rejects', () => {
    // A turn that was only thinking has nothing left once thinking is
    // dropped, and this service answers 400 to an empty content list — not
    // when the thinking happened, but on every request after it, so a whole
    // conversation is stuck on one silent turn in its past.
    const body = buildRequestBody(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }] },
          { role: 'user', content: [{ type: 'text', text: 'still there?' }] },
        ],
      }),
    )

    expect(body.messages.map((message) => message.role)).toEqual(['user', 'user'])
  })
})

describe('parseAnthropicStream', () => {
  test('reads text from typed block events', async () => {
    const out = await deltas([
      { type: 'message_start', message: { usage: { input_tokens: 12 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 3 },
      },
    ])

    expect(out).toEqual([
      { type: 'text_delta', text: 'Hi' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 12, outputTokens: 3 } },
    ])
  })

  test('counts the cached halves of the bill, which are billed at their own rates', async () => {
    // A read costs about a tenth of plain input and a write costs more than
    // it, so a turn missing them is mis-costed in both directions at once.
    // No subtraction here: this dialect already reports the three as disjoint
    // counts rather than as a prompt total with a cached part inside it.
    const out = await deltas([
      {
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 12,
            cache_read_input_tokens: 9000,
            cache_creation_input_tokens: 400,
          },
        },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    ])

    expect(out).toEqual([
      {
        type: 'done',
        stopReason: 'end_turn',
        usage: {
          inputTokens: 12,
          outputTokens: 3,
          cacheReadTokens: 9000,
          cacheWriteTokens: 400,
        },
      },
    ])
  })

  test('reads a tool call from its block, with json arriving in fragments', async () => {
    const out = await deltas([
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'read' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path"' },
      },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: ':"a.ts"}' },
      },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ])

    expect(out.slice(0, 4)).toEqual([
      { type: 'tool_use_start', id: 'toolu_1', name: 'read' },
      { type: 'tool_use_delta', id: 'toolu_1', partialInput: '{"path"' },
      { type: 'tool_use_delta', id: 'toolu_1', partialInput: ':"a.ts"}' },
      { type: 'tool_use_end', id: 'toolu_1' },
    ])
    expect(out.at(-1)).toMatchObject({ stopReason: 'tool_use' })
  })

  test('keeps blocks apart by index when text and a tool call interleave', async () => {
    const out = await deltas([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Looking' } },
      { type: 'content_block_stop', index: 0 },
      {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_2', name: 'bash' },
      },
      {
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      },
      { type: 'content_block_stop', index: 1 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
    ])

    expect(out.map((d) => d.type)).toEqual([
      'text_delta',
      'tool_use_start',
      'tool_use_delta',
      'tool_use_end',
      'done',
    ])
  })

  test('reads extended thinking as thinking, not as the answer', async () => {
    const out = await deltas([
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'let me see' },
      },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])

    expect(out[0]).toEqual({ type: 'thinking_delta', text: 'let me see' })
  })

  test('does not end a text block as if it were a tool call', async () => {
    const out = await deltas([
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
    ])

    expect(out.some((d) => d.type === 'tool_use_end')).toBe(false)
  })

  test('raises an overload as retryable', async () => {
    const failing = deltas([
      { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } },
    ])

    expect(failing).rejects.toThrow(/Overloaded/)
  })

  test('ignores ping and message_stop events', async () => {
    const out = await deltas([
      { type: 'ping' },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'x' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ])

    expect(out).toHaveLength(2)
  })
})

describe('when the service cannot be spoken to', () => {
  test('treats an overload as worth trying again, which it nearly always is', async () => {
    // 529 is this service's own word for "not right now" — the transient
    // failure it answers with most — and it was the one status in the 5xx
    // range the retry list did not know. So the one failure most worth
    // waiting out was the one that ended the turn for good.
    const fetchImpl = async () =>
      new Response('{"type":"error","error":{"type":"overloaded_error"}}', {
        status: 529,
        statusText: 'Overloaded',
      })
    const provider = createAnthropicProvider({ ...config, fetchImpl })

    const { error } = await outcome(provider.send(request(), new AbortController().signal))

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as ProviderResponseError).retryable).toBe(true)
  })

  test('says which address could not be reached, and that it is worth trying again', async () => {
    // A refused connection, a name that will not resolve, a certificate the
    // machine does not trust: `fetch` reports all of them as a bare
    // "TypeError: fetch failed", with the actual reason tucked under `cause`
    // where nothing prints it. And since that is not a ProviderResponseError,
    // the retry wrapper — which only retries what a provider marks — let a
    // two-second blip end the agent's turn.
    const fetchImpl = async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), {
          code: 'ECONNREFUSED',
        }),
      })
    }
    const provider = createAnthropicProvider({ ...config, fetchImpl })

    const { error } = await outcome(provider.send(request(), new AbortController().signal))

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as ProviderResponseError).retryable).toBe(true)
    expect((error as Error).message).toContain('https://api.anthropic.com/v1/messages')
    expect((error as Error).message).toContain('ECONNREFUSED')
  })

  test('reports a connection lost mid-answer as the service failing, keeping what arrived', async () => {
    // One chunk arrives whole, then the socket goes: the failure has to come
    // on a later pull, or the runtime reports the body as failed before it
    // hands out the chunk that did make it.
    let pulls = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ > 0) {
          controller.error(new TypeError('terminated'))
          return
        }
        controller.enqueue(
          encoder.encode(
            'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
          ),
        )
      },
    })
    const fetchImpl = async () => new Response(body, { status: 200 })
    const provider = createAnthropicProvider({ ...config, fetchImpl })

    const { seen, error } = await outcome(provider.send(request(), new AbortController().signal))

    expect(seen).toEqual([{ type: 'text_delta', text: 'Hi' }])
    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as Error).message).toContain('terminated')
  })

  test('lets a stop the caller asked for through untouched', async () => {
    // Pressing stop aborts the fetch, and an aborted fetch throws. Dressed up
    // as "could not reach", the person who asked for the turn to end would be
    // told the service was down.
    const controller = new AbortController()
    const fetchImpl = async () => {
      controller.abort()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const provider = createAnthropicProvider({ ...config, fetchImpl })

    const { error } = await outcome(provider.send(request(), controller.signal))

    expect(error).not.toBeInstanceOf(ProviderResponseError)
    expect((error as Error).name).toBe('AbortError')
  })
})

describe('the plugin', () => {
  test('declares the anthropic provider with a working default endpoint', () => {
    const definition = plugin.providers?.[0]

    expect(definition?.id).toBe('anthropic')
    expect(definition?.create({ apiKey: 'k' }).id).toBe('anthropic')
  })

  test('requires an api key', () => {
    expect(() => plugin.providers?.[0]?.create({})).toThrow(/apiKey/)
  })
})

describe('asking the service not to read the same thing again', () => {
  test('marks the system prompt, which is identical on every request', () => {
    // A measured session sent two million input tokens to write one plugin —
    // the same forty-thousand-token conversation, fifty times. This service
    // will hold a prefix and charge a tenth for it, and it has to be asked:
    // unlike the OpenAI dialect, where it happens on its own, nothing is
    // cached here unless the request says so. We never said so.
    //
    // The system prompt first because it is the safest possible thing to
    // cache: byte-identical on every turn of every session, and long — the
    // instructions plus whatever the project adds.
    const body = buildRequestBody(request({ system: 'Be brief.' }))

    expect(body.system).toEqual([
      { type: 'text', text: 'Be brief.', cache_control: { type: 'ephemeral' } },
    ])
  })

  test('marks the tools, which are the same on every request too', () => {
    // The schemas cost over a thousand tokens on every single request and
    // never change within a session. Marked after the last one, because the
    // marker caches everything up to where it sits.
    const body = buildRequestBody(
      request({ tools: [{ name: 't', description: 'd', inputSchema: { type: 'object' } }] }),
    )

    expect(body.tools?.at(-1)).toMatchObject({ cache_control: { type: 'ephemeral' } })
  })

  test('says nothing about a cache when there is no system prompt', () => {
    // A marker on an empty prefix is a request the service rejects.
    const body = buildRequestBody(request({ system: '' }))

    expect(body.system).toBeUndefined()
  })

  test('leaves the messages alone', () => {
    // The conversation changes every turn, so a marker inside it caches a
    // prefix that will not be there next time — paying the write price for
    // something read once. The stable half is the system prompt and the
    // tools, and that is what this claims.
    const body = buildRequestBody(request())

    expect(JSON.stringify(body.messages)).not.toContain('cache_control')
  })
})

describe('asking anthropic what it has', () => {
  test('uses its own header and version, not a bearer token', async () => {
    // The shared "GET /models with a bearer token" this replaced is an OpenAI
    // convention. Anthropic answers on the same path and refuses that header,
    // so its users saw a blank field and typed the model id from memory.
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ data: [{ id: 'claude-opus-5' }] }), { status: 200 })
    }

    const models = await listAnthropicModels(
      { apiKey: 'k', baseUrl: 'https://api.anthropic.com/v1', version: '2023-06-01', fetchImpl },
      new AbortController().signal,
    )

    expect(models).toEqual(['claude-opus-5'])
    expect(seen?.url).toBe('https://api.anthropic.com/v1/models')
    expect(seen?.headers['x-api-key']).toBe('k')
    expect(seen?.headers['anthropic-version']).toBe('2023-06-01')
    expect(seen?.headers.Authorization).toBeUndefined()
  })

  test('says why when the key is refused, rather than showing an empty list', async () => {
    const fetchImpl = async () => new Response('no', { status: 401 })

    expect(
      listAnthropicModels(
        {
          apiKey: 'wrong',
          baseUrl: 'https://api.anthropic.com/v1',
          version: '2023-06-01',
          fetchImpl,
        },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/key/i)
  })
})
