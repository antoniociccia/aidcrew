import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import { createOpenAiCompatProvider } from './provider.ts'
import { buildResponsesBody, parseResponsesStream } from './responses.ts'

const request: CanonicalRequest = {
  model: 'muse-spark-1.2-contributor',
  system: 'be brief',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  tools: [],
  maxTokens: 64,
}

function sse(...events: object[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
      }
      controller.close()
    },
  })
}

async function collect(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const delta of stream) out.push(delta)
  return out
}

describe('the responses dialect', () => {
  test('sends the system prompt as instructions, not as a message', () => {
    const body = buildResponsesBody(request)

    expect(body.instructions).toBe('be brief')
    expect(body.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ])
  })

  test('declares tools flat, without the function wrapper chat completions uses', () => {
    const body = buildResponsesBody({
      ...request,
      tools: [{ name: 'read', description: 'reads a file', inputSchema: { type: 'object' } }],
    })

    expect(body.tools).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'reads a file',
        parameters: { type: 'object' },
      },
    ])
  })

  test('carries a completed tool call back as a function_call item', () => {
    const body = buildResponsesBody({
      ...request,
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a' } }],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', toolUseId: 'c1', content: 'ok', isError: false }],
        },
      ],
    })

    expect(body.input).toEqual([
      { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{"path":"a"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ])
  })

  test('turns named events into canonical deltas', async () => {
    const deltas = await collect(
      parseResponsesStream(
        sse(
          { type: 'response.output_text.delta', delta: 'he' },
          { type: 'response.output_text.delta', delta: 'llo' },
          {
            type: 'response.completed',
            response: { usage: { input_tokens: 7, output_tokens: 2 } },
          },
        ),
        'go',
      ),
    )

    expect(deltas).toEqual([
      { type: 'text_delta', text: 'he' },
      { type: 'text_delta', text: 'llo' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 7, outputTokens: 2 } },
    ])
  })

  test('reassembles a tool call split across argument deltas', async () => {
    // The event shapes here are recorded from OpenCode Go, not imagined. A
    // call has two ids — `item.id` addresses the argument deltas, `call_id`
    // addresses the result — and reading the wrong one loses every argument,
    // which reaches the user as a tool invoked with nothing in it.
    const deltas = await collect(
      parseResponsesStream(
        sse(
          {
            type: 'response.output_item.added',
            output_index: 2,
            item: {
              id: 'fc_01a047',
              type: 'function_call',
              status: 'in_progress',
              name: 'bash',
              call_id: 'call_01a047',
              arguments: '',
            },
          },
          { type: 'response.function_call_arguments.delta', item_id: 'fc_01a047', delta: '{"comm' },
          {
            type: 'response.function_call_arguments.delta',
            item_id: 'fc_01a047',
            delta: 'and":"ls"}',
          },
          {
            type: 'response.output_item.done',
            output_index: 2,
            item: {
              id: 'fc_01a047',
              type: 'function_call',
              status: 'completed',
              name: 'bash',
              call_id: 'call_01a047',
              arguments: '{"command":"ls"}',
            },
          },
          { type: 'response.completed', response: { usage: {} } },
        ),
        'go',
      ),
    )

    expect(deltas).toEqual([
      { type: 'tool_use_start', id: 'call_01a047', name: 'bash' },
      { type: 'tool_use_delta', id: 'call_01a047', partialInput: '{"comm' },
      { type: 'tool_use_delta', id: 'call_01a047', partialInput: 'and":"ls"}' },
      { type: 'tool_use_end', id: 'call_01a047' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('ignores the reasoning and message items wrapped around a call', async () => {
    const deltas = await collect(
      parseResponsesStream(
        sse(
          {
            type: 'response.output_item.added',
            item: { id: 'rs_1', type: 'reasoning', status: 'in_progress' },
          },
          { type: 'response.output_item.done', item: { id: 'rs_1', type: 'reasoning' } },
          {
            type: 'response.output_item.added',
            item: { id: 'msg_1', type: 'message', role: 'assistant' },
          },
          { type: 'response.output_text.delta', delta: 'Files coming up' },
          { type: 'response.output_item.done', item: { id: 'msg_1', type: 'message' } },
          { type: 'response.completed', response: { usage: {} } },
        ),
        'go',
      ),
    )

    expect(deltas).toEqual([
      { type: 'text_delta', text: 'Files coming up' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  test('reports a truncated answer as max_tokens rather than a clean end', async () => {
    const deltas = await collect(
      parseResponsesStream(
        sse({
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'max_output_tokens' }, usage: {} },
        }),
        'go',
      ),
    )

    expect(deltas.at(-1)).toMatchObject({ type: 'done', stopReason: 'max_tokens' })
  })

  test('reports a filtered answer as a refusal, not a clean end', async () => {
    // The turn ended because the service would not say it, and an agent told
    // it ended cleanly asks the next question as if it had been answered.
    const deltas = await collect(
      parseResponsesStream(
        sse({
          type: 'response.incomplete',
          response: { incomplete_details: { reason: 'content_filter' }, usage: {} },
        }),
        'go',
      ),
    )

    expect(deltas.at(-1)).toMatchObject({ type: 'done', stopReason: 'refusal' })
  })
})

describe('an error the responses stream reports', () => {
  async function failureOf(stream: AsyncIterable<StreamDelta>): Promise<ProviderResponseError> {
    try {
      await collect(stream)
    } catch (cause) {
      return cause as ProviderResponseError
    }
    throw new Error('expected the stream to fail')
  }

  test('is raised from the error event openai itself sends', async () => {
    // OpenAI's own `error` event carries `code` and `message` at the top,
    // not under an `error` key. Read only the key, the event was unknown,
    // unknown events are not our business, and a rate limit came out as an
    // empty turn that cost nothing — reported as the model choosing silence.
    const failure = await failureOf(
      parseResponsesStream(
        sse({ type: 'error', code: 'rate_limit_exceeded', message: 'Rate limit reached.' }),
        'go',
      ),
    )

    expect(failure).toBeInstanceOf(ProviderResponseError)
    expect(failure.message).toContain('Rate limit reached.')
    expect(failure.retryable).toBe(true)
  })

  test('is raised from a response that failed, where the error sits under response', async () => {
    const failure = await failureOf(
      parseResponsesStream(
        sse({
          type: 'response.failed',
          response: {
            status: 'failed',
            error: { code: 'invalid_prompt', message: 'The prompt was rejected.' },
          },
        }),
        'go',
      ),
    )

    expect(failure).toBeInstanceOf(ProviderResponseError)
    expect(failure.message).toContain('The prompt was rejected.')
    expect(failure.retryable).toBe(false)
  })

  test('is raised from a 200 whose body was a json error rather than a stream', async () => {
    // The same silence as on the chat path: no `data:` lines, no events, an
    // empty turn — and the sentence that explained it never shown.
    const encoder = new TextEncoder()
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"error":{"message":"Model not found."}}'))
        controller.close()
      },
    })

    const failure = await failureOf(parseResponsesStream(body, 'go'))

    expect(failure).toBeInstanceOf(ProviderResponseError)
    expect(failure.message).toContain('Model not found.')
    expect(failure.retryable).toBe(false)
  })

  test('is retried when the failure was the service, not the request', async () => {
    const failure = await failureOf(
      parseResponsesStream(
        sse({
          type: 'response.failed',
          response: { status: 'failed', error: { code: 'server_error', message: 'Try again.' } },
        }),
        'go',
      ),
    )

    expect(failure.retryable).toBe(true)
  })
})

describe('the part of the prompt the service did not read again', () => {
  test('is counted apart, and taken off the fresh input', async () => {
    // The same convention as the chat dialect: `input_tokens` is the whole
    // prompt with the cached part inside it, so it is taken off rather than
    // added, or a long conversation is charged for its cache twice — and
    // the one number that says whether caching is working stayed at zero.
    const deltas = await collect(
      parseResponsesStream(
        sse({
          type: 'response.completed',
          response: {
            usage: {
              input_tokens: 12_000,
              output_tokens: 40,
              input_tokens_details: { cached_tokens: 11_500 },
            },
          },
        }),
        'go',
      ),
    )

    const done = deltas.find((delta) => delta.type === 'done')
    expect(done?.type === 'done' ? done.usage : undefined).toEqual({
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 11_500,
    })
  })
})

describe('choosing between the two dialects', () => {
  function providerOver(replies: Array<{ path: string; status: number; body: string }>) {
    const seen: string[] = []
    const provider = createOpenAiCompatProvider({
      id: 'opencode-go',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl: async (url) => {
        seen.push(new URL(url).pathname)
        const reply = replies.shift()
        if (!reply) throw new Error(`unexpected call to ${url}`)
        return reply.status === 200
          ? new Response(sse({ type: 'response.completed', response: { usage: {} } }), {
              status: 200,
            })
          : new Response(reply.body, { status: reply.status, statusText: 'Server Error' })
      },
    })
    return { provider, seen }
  }

  test('falls back to responses when chat completions fails on the model', async () => {
    // Exactly what OpenCode Go does for muse-spark: a bare 500 on chat, 200 here.
    const { provider, seen } = providerOver([
      {
        path: '/chat/completions',
        status: 500,
        body: '{"error":{"message":"Internal server error"}}',
      },
      { path: '/responses', status: 200, body: '' },
    ])

    await collect(provider.send(request, new AbortController().signal))

    expect(seen).toEqual(['/v1/chat/completions', '/v1/responses'])
  })

  test('goes straight to responses the second time, having learned', async () => {
    const { provider, seen } = providerOver([
      { path: '/chat/completions', status: 500, body: '{}' },
      { path: '/responses', status: 200, body: '' },
      { path: '/responses', status: 200, body: '' },
    ])
    const signal = new AbortController().signal

    await collect(provider.send(request, signal))
    await collect(provider.send(request, signal))

    expect(seen).toEqual(['/v1/chat/completions', '/v1/responses', '/v1/responses'])
  })

  test('does not retry a refusal that is about us rather than the endpoint', async () => {
    const { provider, seen } = providerOver([
      { path: '/chat/completions', status: 401, body: '{"error":{"message":"Invalid API key."}}' },
    ])

    await expect(collect(provider.send(request, new AbortController().signal))).rejects.toThrow(
      /Invalid API key/,
    )
    expect(seen).toEqual(['/v1/chat/completions'])
  })

  test('retries a 401 that is really about the model, not the key', async () => {
    // OpenCode Go says 401 for both; only the message tells them apart.
    const { provider, seen } = providerOver([
      {
        path: '/chat/completions',
        status: 401,
        body: '{"error":{"type":"ModelError","message":"Model grok-4.6 is not supported for format oa-compat"}}',
      },
      { path: '/responses', status: 200, body: '' },
    ])

    await collect(provider.send(request, new AbortController().signal))

    expect(seen).toEqual(['/v1/chat/completions', '/v1/responses'])
  })

  test('reports the chat failure when neither endpoint works', async () => {
    const { provider } = providerOver([
      { path: '/chat/completions', status: 500, body: '{"error":{"message":"model is on fire"}}' },
      { path: '/responses', status: 404, body: '{}' },
    ])

    await expect(collect(provider.send(request, new AbortController().signal))).rejects.toThrow(
      /model is on fire.*and on \/responses/,
    )
  })
})

describe('payloads that are legal but not events', () => {
  test('ignores a null, rather than crashing on it', async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder()
        controller.enqueue(encoder.encode('data: null\n\n'))
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"hi"}\n\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
          ),
        )
        controller.close()
      },
    })

    const out = await collect(parseResponsesStream(body, 'test'))

    expect(out[0]).toEqual({ type: 'text_delta', text: 'hi' })
  })
})
