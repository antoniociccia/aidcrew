import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import plugin from './plugin.ts'
import { createGeminiProvider } from './provider.ts'
import { buildRequestBody, cleanSchema } from './request.ts'
import { parseGeminiStream } from './stream.ts'

const encoder = new TextEncoder()

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'gemini-3-pro',
    system: 'Be brief.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  }
}

function events(list: object[]): AsyncIterable<Uint8Array> {
  const body = list.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
  return (async function* () {
    yield encoder.encode(body)
  })()
}

async function deltas(list: object[]): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const delta of parseGeminiStream(events(list), 'gemini')) out.push(delta)
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

/** A fake service that answers each request with the next body in turn. */
function answering(...bodies: (ReadableStream<Uint8Array> | object[])[]) {
  const calls: { url: string; body: unknown }[] = []
  const fetchImpl = async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)) })
    const next = bodies.shift()
    if (next === undefined) throw new Error('no answer was prepared for this request')
    return new Response(
      Array.isArray(next)
        ? next.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
        : next,
      { status: 200 },
    )
  }
  return { calls, fetchImpl }
}

const config = { apiKey: 'k', baseUrl: 'https://generativelanguage.googleapis.com/v1beta' }

describe('buildRequestBody', () => {
  test('sends the system prompt as systemInstruction, not as a turn', () => {
    const body = buildRequestBody(request())

    expect(body.systemInstruction).toEqual({ parts: [{ text: 'Be brief.' }] })
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
  })

  test('calls the assistant "model", which is what this dialect calls it', () => {
    const body = buildRequestBody(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
        ],
      }),
    )

    expect(body.contents.map((turn) => turn.role)).toEqual(['user', 'model'])
  })

  test('sends a tool call as functionCall and its result as functionResponse', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'the file', isError: false },
            ],
          },
        ],
      }),
    )

    expect(body.contents[0]?.parts[0]).toEqual({
      functionCall: { name: 'read', args: { path: 'a.ts' } },
    })
    // Matched by name, because this protocol gives a call no id at all — which
    // is why the id has to survive the round trip some other way.
    expect(body.contents[1]?.parts[0]).toEqual({
      functionResponse: { name: 'read', response: { output: 'the file' } },
    })
  })

  test('a tool result whose call it never saw still names the right function', () => {
    // The name is recovered from the call earlier in the same conversation.
    // Without that, a result would be sent under an empty name and the model
    // would be told a function it never called had answered.
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'x', name: 'bash', input: {} }],
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'x', content: 'ok', isError: false }],
          },
        ],
      }),
    )

    expect(body.contents[1]?.parts[0]).toMatchObject({ functionResponse: { name: 'bash' } })
  })

  test('matches a result to the call before it, even when an id was handed out twice', () => {
    // Ids used to be minted from a counter that started over every turn, so
    // every conversation had a `gemini-call-1` in each of its turns. The names
    // were gathered over the whole conversation first, last one winning, and
    // the `read` result from turn one went out as an answer from `bash` —
    // a history that never happened, sent on every request after it.
    const body = buildRequestBody(
      request({
        messages: [
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'read', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'c', content: 'a file', isError: false }],
          },
          { role: 'assistant', content: [{ type: 'tool_use', id: 'c', name: 'bash', input: {} }] },
          {
            role: 'user',
            content: [{ type: 'tool_result', toolUseId: 'c', content: 'ok', isError: false }],
          },
        ],
      }),
    )

    expect(body.contents[1]?.parts[0]).toMatchObject({ functionResponse: { name: 'read' } })
    expect(body.contents[3]?.parts[0]).toMatchObject({ functionResponse: { name: 'bash' } })
  })

  test('declares tools the way this API wants them, nested under one entry', () => {
    const body = buildRequestBody(
      request({
        tools: [
          {
            name: 'read',
            description: 'Reads.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    )

    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          {
            name: 'read',
            description: 'Reads.',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      },
    ])
  })

  test('sends a picture as inline data', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', mediaType: 'image/png', data: 'AAAA' }],
          },
        ],
      }),
    )

    expect(body.contents[0]?.parts[0]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AAAA' },
    })
  })

  test('never sends an empty turn, which this API rejects outright', () => {
    const body = buildRequestBody(
      request({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'hi' }] },
          // Thinking is dropped, leaving a turn with nothing in it.
          { role: 'assistant', content: [{ type: 'thinking', text: 'hmm' }] },
        ],
      }),
    )

    expect(body.contents).toHaveLength(1)
  })
})

describe('cleanSchema', () => {
  test('removes the keywords this API rejects', () => {
    // A schema straight from Zod carries $schema and additionalProperties, and
    // Gemini answers 400 to both — so every tool would fail, not just one.
    const cleaned = cleanSchema({
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', description: 'A path.' },
        depth: { type: 'integer', exclusiveMinimum: 0 },
      },
      required: ['path'],
    })

    expect(cleaned).toEqual({
      type: 'object',
      properties: {
        path: { type: 'string', description: 'A path.' },
        depth: { type: 'integer' },
      },
      required: ['path'],
    })
  })

  test('keeps what the API does understand, including nested shapes', () => {
    const cleaned = cleanSchema({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
    })

    expect(cleaned).toEqual({
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      },
    })
  })

  test('turns a union of a type and null into that type, which is all it accepts', () => {
    expect(cleanSchema({ type: ['string', 'null'] })).toEqual({ type: 'string', nullable: true })
  })
})

describe('parseGeminiStream', () => {
  test('turns text parts into text deltas', async () => {
    const out = await deltas([
      { candidates: [{ content: { parts: [{ text: 'he' }], role: 'model' } }] },
      {
        candidates: [{ content: { parts: [{ text: 'llo' }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 8, candidatesTokenCount: 2 },
      },
    ])

    expect(out).toEqual([
      { type: 'text_delta', text: 'he' },
      { type: 'text_delta', text: 'llo' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 8, outputTokens: 2 } },
    ])
  })

  test('reports thinking separately from the answer', async () => {
    const out = await deltas([
      { candidates: [{ content: { parts: [{ text: 'weighing it', thought: true }] } }] },
      { candidates: [{ content: { parts: [{ text: 'yes' }] }, finishReason: 'STOP' }] },
    ])

    expect(out.slice(0, 2)).toEqual([
      { type: 'thinking_delta', text: 'weighing it' },
      { type: 'text_delta', text: 'yes' },
    ])
  })

  test('gives a function call an id, which the protocol does not', async () => {
    const out = await deltas([
      {
        candidates: [
          {
            content: { parts: [{ functionCall: { name: 'read', args: { path: 'a.ts' } } }] },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const start = out.find((delta) => delta.type === 'tool_use_start')
    expect(start).toMatchObject({ type: 'tool_use_start', name: 'read' })
    // Whole arguments arrive at once here, so the input is one delta and the
    // call is closed immediately.
    expect(out.filter((delta) => delta.type === 'tool_use_delta')).toEqual([
      { type: 'tool_use_delta', id: (start as { id: string }).id, partialInput: '{"path":"a.ts"}' },
    ])
    expect(out.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })
  })

  test('gives two calls in one turn two different ids', async () => {
    const out = await deltas([
      {
        candidates: [
          {
            content: {
              parts: [
                { functionCall: { name: 'read', args: { path: 'a' } } },
                { functionCall: { name: 'read', args: { path: 'b' } } },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      },
    ])

    const ids = out.filter((delta) => delta.type === 'tool_use_start').map((delta) => delta.id)
    expect(new Set(ids).size).toBe(2)
  })

  test('gives a call an id no call in another turn will get', async () => {
    // Two turns, one call each — two separate streams, as the service sends
    // them. A counter that starts over per stream names both `gemini-call-1`,
    // and a conversation with two calls of the same id in it can no longer
    // say which result answered which.
    const call = [
      { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: {} } }] } }] },
    ]
    const first = await deltas(call)
    const second = await deltas(call)

    const ids = [...first, ...second]
      .filter((delta) => delta.type === 'tool_use_start')
      .map((delta) => delta.id)
    expect(ids).toHaveLength(2)
    expect(new Set(ids).size).toBe(2)
  })

  test('reports the input that was not served from the cache, so nothing is counted twice', async () => {
    const out = await deltas([
      {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 80,
        },
      },
    ])

    // This service states its prompt total with the cached part inside it,
    // and every consumer adds all four counts together — the governor's
    // budget, the task totals, the row in the interface. Passed through whole
    // beside the cached figure, this turn is charged 180 tokens against a
    // 100-token budget, and the error is largest exactly where caching is
    // heaviest.
    expect(out.at(-1)).toMatchObject({
      usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 80 },
    })
  })

  test('never reports a negative input, however odd the numbers it is given', async () => {
    // A service reporting more cached tokens than prompt ones should cost us a
    // wrong number, not a negative one.
    const out = await deltas([
      {
        candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: 'STOP' }],
        usageMetadata: {
          promptTokenCount: 10,
          candidatesTokenCount: 5,
          cachedContentTokenCount: 80,
        },
      },
    ])

    expect(out.at(-1)).toMatchObject({ usage: { inputTokens: 0, cacheReadTokens: 80 } })
  })

  test('says why it stopped, in our words', async () => {
    for (const [reason, expected] of [
      ['MAX_TOKENS', 'max_tokens'],
      ['SAFETY', 'refusal'],
      ['PROHIBITED_CONTENT', 'refusal'],
      ['STOP', 'end_turn'],
    ] as const) {
      const out = await deltas([
        { candidates: [{ content: { parts: [{ text: 'x' }] }, finishReason: reason }] },
      ])
      expect(out.at(-1)).toMatchObject({ stopReason: expected })
    }
  })

  test('raises what the service complained about instead of ending quietly', async () => {
    const failing = deltas([{ error: { message: 'API key not valid', code: 400 } }])

    expect(failing).rejects.toThrow(/API key not valid/)
  })

  test('closes a call the stream never closed', async () => {
    // A cut connection mid-turn should still produce a well-formed turn.
    const out = await deltas([
      { candidates: [{ content: { parts: [{ functionCall: { name: 'read', args: {} } }] } }] },
    ])

    expect(out.filter((delta) => delta.type === 'tool_use_end')).toHaveLength(1)
  })
})

describe('what a thinking model attaches to a call', () => {
  test('sends a call back with the signature it arrived with, verbatim', async () => {
    // A Gemini 3 model signs the reasoning behind a function call and answers
    // 400 to any later request in which that call comes back unsigned. The
    // signature is not part of the call — the tool never sees it, and it has
    // no place in the canonical model — so it is kept beside the id the call
    // was given here and put back on the way out.
    const { calls, fetchImpl } = answering(
      [
        {
          candidates: [
            {
              content: {
                parts: [
                  {
                    functionCall: { name: 'read', args: { path: 'a.ts' } },
                    thoughtSignature: 'sig-abc',
                  },
                ],
              },
              finishReason: 'STOP',
            },
          ],
        },
      ],
      [{ candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] }],
    )
    const provider = createGeminiProvider({ ...config, fetchImpl })
    const signal = new AbortController().signal

    const { seen } = await outcome(provider.send(request(), signal))
    const start = seen.find((delta) => delta.type === 'tool_use_start') as { id: string }
    await outcome(
      provider.send(
        request({
          messages: [
            { role: 'user', content: [{ type: 'text', text: 'hi' }] },
            {
              role: 'assistant',
              content: [{ type: 'tool_use', id: start.id, name: 'read', input: { path: 'a.ts' } }],
            },
            {
              role: 'user',
              content: [
                { type: 'tool_result', toolUseId: start.id, content: 'the file', isError: false },
              ],
            },
          ],
        }),
        signal,
      ),
    )

    // Out of band on the way in: the tool is handed exactly the arguments.
    expect(seen.filter((delta) => delta.type === 'tool_use_delta')).toEqual([
      { type: 'tool_use_delta', id: start.id, partialInput: '{"path":"a.ts"}' },
    ])
    const sent = calls[1]?.body as { contents: { parts: unknown[] }[] }
    expect(sent.contents[1]?.parts[0]).toEqual({
      functionCall: { name: 'read', args: { path: 'a.ts' } },
      thoughtSignature: 'sig-abc',
    })
  })
})

describe('when the service cannot be spoken to', () => {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3-pro'

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
    const provider = createGeminiProvider({ ...config, fetchImpl })

    const { error } = await outcome(provider.send(request(), new AbortController().signal))

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as ProviderResponseError).retryable).toBe(true)
    expect((error as Error).message).toContain(url)
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
          encoder.encode('data: {"candidates":[{"content":{"parts":[{"text":"Hi"}]}}]}\n\n'),
        )
      },
    })
    const { fetchImpl } = answering(body)
    const provider = createGeminiProvider({ ...config, fetchImpl })

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
    const provider = createGeminiProvider({ ...config, fetchImpl })

    const { error } = await outcome(provider.send(request(), controller.signal))

    expect(error).not.toBeInstanceOf(ProviderResponseError)
    expect((error as Error).name).toBe('AbortError')
  })
})

describe('the plugin', () => {
  test('registers a provider called gemini', () => {
    expect(plugin.providers?.map((provider) => provider.id)).toEqual(['gemini'])
  })

  test('refuses to start without a key, rather than failing on the first turn', () => {
    expect(() => plugin.providers?.[0]?.create({ baseUrl: 'https://x' })).toThrow(/apiKey/)
  })
})
