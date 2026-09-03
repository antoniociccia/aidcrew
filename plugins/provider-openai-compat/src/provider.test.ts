import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest, MeterWindow } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import { RetryAfterError } from '@aidcrew/plugin-sdk'
import { createOpenAiCompatProvider } from './provider.ts'

const request: CanonicalRequest = {
  model: 'test-model',
  system: '',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  tools: [],
  maxTokens: 100,
}

function respondWith(body: string, init: ResponseInit = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fetchImpl = async (url: string, requestInit: RequestInit) => {
    calls.push({ url, init: requestInit })
    return new Response(body, init)
  }
  return { calls, fetchImpl }
}

const okStream =
  'data: {"choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'

async function drain(stream: AsyncIterable<unknown>) {
  const out: unknown[] = []
  for await (const item of stream) out.push(item)
  return out
}

describe('createOpenAiCompatProvider', () => {
  test('posts to the chat completions path of the configured base url', async () => {
    const { calls, fetchImpl } = respondWith(okStream)
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
      fetchImpl,
    })

    await drain(provider.send(request, new AbortController().signal))

    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions')
    expect(calls[0]?.init.method).toBe('POST')
  })

  test('tolerates a base url with a trailing slash', async () => {
    const { calls, fetchImpl } = respondWith(okStream)
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1/',
      apiKey: 'k',
      fetchImpl,
    })

    await drain(provider.send(request, new AbortController().signal))

    expect(calls[0]?.url).toBe('https://example.test/v1/chat/completions')
  })

  test('sends the api key as a bearer token', async () => {
    const { calls, fetchImpl } = respondWith(okStream)
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'secret',
      fetchImpl,
    })

    await drain(provider.send(request, new AbortController().signal))

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer secret')
  })

  test('merges extra headers a gateway may require', async () => {
    const { calls, fetchImpl } = respondWith(okStream)
    const provider = createOpenAiCompatProvider({
      id: 'openrouter',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      headers: { 'HTTP-Referer': 'https://aidcrew.sh' },
      fetchImpl,
    })

    await drain(provider.send(request, new AbortController().signal))

    const headers = calls[0]?.init.headers as Record<string, string>
    expect(headers['HTTP-Referer']).toBe('https://aidcrew.sh')
  })

  test('raises a retryable error on a rate limit', async () => {
    const { fetchImpl } = respondWith('slow down', { status: 429 })
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    const failing = drain(provider.send(request, new AbortController().signal))

    expect(failing).rejects.toThrow(ProviderResponseError)
    expect(failing).rejects.toThrow(/429/)
  })

  test('treats a bad api key as not worth retrying', async () => {
    const { fetchImpl } = respondWith('nope', { status: 401 })
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'wrong',
      fetchImpl,
    })

    try {
      await drain(provider.send(request, new AbortController().signal))
      throw new Error('expected the provider to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderResponseError)
      expect((error as ProviderResponseError).retryable).toBe(false)
    }
  })

  test('says what the provider actually complained about', async () => {
    // Providers put the useful sentence inside a JSON envelope. Showing the
    // envelope makes the reader dig for it; showing the sentence does not.
    const { fetchImpl } = respondWith(
      JSON.stringify({
        type: 'error',
        error: { type: 'CreditsError', message: 'Insufficient balance.' },
      }),
      { status: 401 },
    )
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    try {
      await drain(provider.send(request, new AbortController().signal))
      throw new Error('expected the provider to reject')
    } catch (error) {
      expect((error as Error).message).toContain('Insufficient balance.')
      expect((error as Error).message).not.toContain('"type"')
    }
  })

  test('names the status when the body explains nothing', async () => {
    const { fetchImpl } = respondWith('gateway timeout', { status: 504 })
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    expect(drain(provider.send(request, new AbortController().signal))).rejects.toThrow(/504/)
  })

  test('treats an exhausted balance as not worth retrying', async () => {
    // A retry cannot conjure credit, and hammering the endpoint helps nobody.
    const { fetchImpl } = respondWith(
      JSON.stringify({ error: { type: 'CreditsError', message: 'Insufficient balance.' } }),
      { status: 429 },
    )
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    try {
      await drain(provider.send(request, new AbortController().signal))
    } catch (error) {
      expect((error as ProviderResponseError).retryable).toBe(false)
    }
  })

  test('never puts the api key in the error message', async () => {
    const { fetchImpl } = respondWith('unauthorized', { status: 401 })
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'super-secret-key',
      fetchImpl,
    })

    try {
      await drain(provider.send(request, new AbortController().signal))
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret-key')
    }
  })

  test('rejects a response with no body', async () => {
    const fetchImpl = async () => new Response(null, { status: 200 })
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    expect(drain(provider.send(request, new AbortController().signal))).rejects.toThrow(/body/i)
  })

  test('raises what a gateway said in a 200 that was not a stream', async () => {
    const { fetchImpl } = respondWith('{"error":{"message":"model \\"gpt-9\\" not found"}}')
    const provider = createOpenAiCompatProvider({
      id: 'ollama',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    try {
      await drain(provider.send(request, new AbortController().signal))
      throw new Error('expected the provider to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ProviderResponseError)
      expect((error as Error).message).toContain('ollama')
      expect((error as Error).message).toContain('model "gpt-9" not found')
    }
  })

  test('streams the deltas the parser produced', async () => {
    const { fetchImpl } = respondWith(okStream)
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    const out = await drain(provider.send(request, new AbortController().signal))

    expect(out).toEqual([
      { type: 'text_delta', text: 'hi' },
      { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })
})

describe('when the endpoint cannot be reached at all', () => {
  function providerFailingWith(failure: unknown) {
    return createOpenAiCompatProvider({
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'k',
      fetchImpl: async () => {
        throw failure
      },
    })
  }

  async function failureOf(provider: ReturnType<typeof createOpenAiCompatProvider>) {
    try {
      await drain(provider.send(request, new AbortController().signal))
    } catch (cause) {
      return cause
    }
    throw new Error('expected the provider to reject')
  }

  test('says who, where and why, instead of "fetch failed"', async () => {
    // Ollama not running is the commonest failure a new user meets, and what
    // they saw was `TypeError: fetch failed` — no provider, no address, no
    // reason — and no retry, because it was not the error the retry reads.
    const failure = await failureOf(
      providerFailingWith(
        new TypeError('fetch failed', {
          cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
            code: 'ECONNREFUSED',
          }),
        }),
      ),
    )

    expect(failure).toBeInstanceOf(ProviderResponseError)
    expect((failure as ProviderResponseError).retryable).toBe(true)
    expect((failure as Error).message).toContain('ollama')
    expect((failure as Error).message).toContain('http://127.0.0.1:11434/v1/chat/completions')
    expect((failure as Error).message).toContain('ECONNREFUSED')
  })

  test('shows the code where bun puts it, on the error itself', async () => {
    // Bun does not nest a cause: "Unable to connect. Is the computer able to
    // access the url?" with `code: 'ConnectionRefused'` on the same object.
    const failure = await failureOf(
      providerFailingWith(
        Object.assign(new Error('Unable to connect. Is the computer able to access the url?'), {
          code: 'ConnectionRefused',
        }),
      ),
    )

    expect((failure as Error).message).toContain('Unable to connect')
    expect((failure as Error).message).toContain('ConnectionRefused')
  })

  test('leaves a cancellation alone, since it is the caller who asked', async () => {
    const controller = new AbortController()
    const aborted = new DOMException('The operation was aborted.', 'AbortError')
    const provider = createOpenAiCompatProvider({
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'k',
      fetchImpl: async () => {
        controller.abort()
        throw aborted
      },
    })

    let thrown: unknown
    try {
      await drain(provider.send(request, controller.signal))
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBe(aborted)
  })

  test('names the provider and the address when the connection drops mid-stream', async () => {
    // One chunk gets through, then the socket goes: erroring on the second
    // pull rather than in `start`, because a stream errored with a chunk
    // still queued throws the chunk away.
    const encoder = new TextEncoder()
    let pulls = 0
    const fetchImpl = async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            pulls++
            if (pulls === 1) {
              controller.enqueue(encoder.encode(okStream))
              return
            }
            controller.error(
              Object.assign(new Error('The socket connection was closed unexpectedly.'), {
                code: 'ECONNRESET',
              }),
            )
          },
        }),
      )
    const provider = createOpenAiCompatProvider({
      id: 'ollama',
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'k',
      fetchImpl,
    })

    const seen: unknown[] = []
    let thrown: unknown
    try {
      for await (const delta of provider.send(request, new AbortController().signal)) {
        seen.push(delta)
      }
    } catch (cause) {
      thrown = cause
    }

    expect(seen).toContainEqual({ type: 'text_delta', text: 'hi' })
    expect(thrown).toBeInstanceOf(ProviderResponseError)
    expect((thrown as Error).message).toContain('ollama')
    expect((thrown as Error).message).toContain('http://127.0.0.1:11434/v1/chat/completions')
    expect((thrown as Error).message).toContain('ECONNRESET')
  })
})

describe('when both endpoints refuse', () => {
  test('keeps the first refusal retryable, so a gateway hiccup is tried again', async () => {
    // The first refusal is transient and the fallback's is permanent, and the
    // combined error was marked "do not retry" unconditionally — so a service
    // that was briefly down was reported as permanently wrong, and the retry
    // that exists for exactly this never fired. The first refusal decides,
    // because the fallback was only tried on the strength of it.
    const seen: string[] = []
    const fetchImpl = async (url: string) => {
      seen.push(url)
      return url.includes('/responses')
        ? new Response('model not supported for format openai', { status: 400 })
        : new Response('{"error":{"message":"Internal server error"}}', { status: 500 })
    }

    const provider = createOpenAiCompatProvider({
      id: 'test',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      dialect: 'auto',
      fetchImpl: fetchImpl as never,
    })

    let thrown: unknown
    try {
      for await (const _ of provider.send(request, new AbortController().signal)) {
        // drained for the error
      }
    } catch (cause) {
      thrown = cause
    }

    expect(thrown).toBeInstanceOf(ProviderResponseError)
    expect((thrown as ProviderResponseError).retryable).toBe(true)
    expect(seen.some((url) => url.includes('/responses'))).toBe(true)
  })

  test('stays final when the first refusal was final too', async () => {
    // A bad key answers the same way however often it is asked, and marking
    // that retryable is three times the wait for the same message.
    const fetchImpl = async () => new Response('invalid api key', { status: 401 })

    const provider = createOpenAiCompatProvider({
      id: 'test',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      dialect: 'auto',
      fetchImpl: fetchImpl as never,
    })

    let thrown: unknown
    try {
      for await (const _ of provider.send(request, new AbortController().signal)) {
        // drained for the error
      }
    } catch (cause) {
      thrown = cause
    }

    expect((thrown as ProviderResponseError).retryable).toBe(false)
  })
})

describe('choosing whether the other endpoint is worth asking', () => {
  test('does not ask a second time when the service itself is down', async () => {
    // Both endpoints are the same gateway. When it answers 503, asking the
    // other path is a round trip to the same outage — and the reply that comes
    // back ("model not supported for format openai") describes the endpoint we
    // were never going to use, so it lands in the error message and reads as
    // the cause. A user seeing it concluded their model was wrong.
    const seen: string[] = []
    const fetchImpl = async (url: string) => {
      seen.push(url)
      return new Response('Upstream request failed: Endpoint is unavailable.', { status: 503 })
    }

    const provider = createOpenAiCompatProvider({
      id: 'test',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      dialect: 'auto',
      fetchImpl: fetchImpl as never,
    })

    let thrown: unknown
    try {
      for await (const _ of provider.send(request, new AbortController().signal)) {
        // drained for the error
      }
    } catch (cause) {
      thrown = cause
    }

    expect(seen.some((url) => url.includes('/responses'))).toBe(false)
    expect((thrown as ProviderResponseError).retryable).toBe(true)
    expect((thrown as Error).message).not.toContain('/responses')
  })

  test('still asks when the refusal was about the request', async () => {
    // A 404 on /chat/completions is what an endpoint that only speaks
    // /responses says, and finding that out is the whole point of "auto".
    const seen: string[] = []
    const fetchImpl = async (url: string) => {
      seen.push(url)
      return url.includes('/responses')
        ? new Response('data: [DONE]\n\n', { status: 200 })
        : new Response('not found', { status: 404 })
    }

    const provider = createOpenAiCompatProvider({
      id: 'test',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      dialect: 'auto',
      fetchImpl: fetchImpl as never,
    })

    for await (const _ of provider.send(request, new AbortController().signal)) {
      // drained
    }

    expect(seen.some((url) => url.includes('/responses'))).toBe(true)
  })
})

describe('when the model is not one this endpoint has', () => {
  function providerOver(catalogue: unknown, status = 503) {
    const seen: string[] = []
    const fetchImpl = async (url: string, init?: RequestInit) => {
      seen.push(`${init?.method ?? 'GET'} ${new URL(url).pathname}`)
      if (url.endsWith('/models')) {
        return catalogue === undefined
          ? new Response('nope', { status: 500 })
          : new Response(JSON.stringify(catalogue), { status: 200 })
      }
      return new Response('Upstream request failed: Endpoint is unavailable.', { status })
    }
    const provider = createOpenAiCompatProvider({
      id: 'opencode-go',
      apiKey: 'k',
      baseUrl: 'https://x/v1',
      dialect: 'auto',
      fetchImpl: fetchImpl as never,
    })
    return { provider, seen }
  }

  async function failureOf(provider: {
    send: (r: never, s: AbortSignal) => AsyncIterable<unknown>
  }) {
    try {
      for await (const _ of provider.send(request as never, new AbortController().signal)) {
        // drained for the error
      }
    } catch (cause) {
      return cause as ProviderResponseError
    }
    throw new Error('expected a failure')
  }

  const catalogue = {
    data: [{ id: 'test-modal' }, { id: 'qwen3.6-plus' }, { id: 'deepseek-v4-flash-free' }],
  }

  test('says so, instead of repeating what the gateway said about the network', async () => {
    // The live failure: six agents configured for a model this provider has
    // never had, and every turn of every one of them answered "Endpoint is
    // unavailable" — a sentence about the network, for a typo in a config
    // file. The endpoint was up the whole time and lists its models.
    const { provider } = providerOver(catalogue)

    const failure = await failureOf(provider)

    expect(failure.message).toContain('test-model')
    expect(failure.message).toContain('test-modal')
    expect(failure.retryable).toBe(false)
  })

  test('asks the catalogue once, however many turns fail', async () => {
    const { provider, seen } = providerOver(catalogue)

    await failureOf(provider)
    await failureOf(provider)

    expect(seen.filter((one) => one.endsWith('/models')).length).toBe(1)
  })

  test('leaves the error alone when the model is in the catalogue', async () => {
    // Then the gateway meant it, and replacing a real outage with a guess
    // about the config would send someone to edit a file that is correct.
    const { provider } = providerOver({ data: [{ id: 'test-model' }] })

    const failure = await failureOf(provider)

    expect(failure.message).toContain('Endpoint is unavailable')
    expect(failure.retryable).toBe(true)
  })

  test('leaves the error alone when the catalogue cannot be read', async () => {
    const { provider } = providerOver(undefined)

    const failure = await failureOf(provider)

    expect(failure.message).toContain('Endpoint is unavailable')
  })
})

describe('a service that stops talking', () => {
  /** A fetch that never answers, but does notice when it is told to stop. */
  const neverAnswers = (_url: string, init: RequestInit) =>
    new Promise<Response>((_, reject) => {
      init.signal?.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')),
      )
    })

  /** A body that sends one chunk and then goes quiet without hanging up. */
  function quietAfterOne(): ReadableStream<Uint8Array> {
    let sent = false
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent) return new Promise<void>(() => {})
        sent = true
        controller.enqueue(new TextEncoder().encode(okStream))
      },
    })
  }

  test('is given up on before the first byte, naming who, what and how long', async () => {
    // A stalled upstream held a turn for twenty-three minutes in a real run:
    // no error, no bytes, a spinner. Nothing anywhere had a clock on it.
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl: neverAnswers,
      timeouts: { firstByteMs: 20 },
    })

    const error = await drain(provider.send(request, new AbortController().signal)).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as ProviderResponseError).retryable).toBe(true)
    expect((error as Error).message).toContain('zen')
    expect((error as Error).message).toContain('test-model')
    expect((error as Error).message).toContain('20ms')
  })

  test('is cut off when it goes quiet mid-answer, keeping what arrived', async () => {
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl: async () => new Response(quietAfterOne(), { status: 200 }),
      timeouts: { idleMs: 20 },
    })
    const seen: unknown[] = []

    const error = await (async () => {
      try {
        for await (const delta of provider.send(request, new AbortController().signal)) {
          seen.push(delta)
        }
        return undefined
      } catch (cause) {
        return cause
      }
    })()

    expect(seen).toEqual([{ type: 'text_delta', text: 'hi' }])
    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as ProviderResponseError).retryable).toBe(false)
    expect((error as Error).message).toContain('test-model')
  })
})

describe('a rate limit that says when to come back', () => {
  test('carries the wait it asked for, so the retry can honour it', async () => {
    const { fetchImpl } = respondWith('{"error":{"message":"slow down"}}', {
      status: 429,
      headers: { 'retry-after': '2' },
    })
    const provider = createOpenAiCompatProvider({
      id: 'zen',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
      dialect: 'chat',
    })

    const error = await drain(provider.send(request, new AbortController().signal)).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).toBeInstanceOf(RetryAfterError)
    expect((error as RetryAfterError).retryAfterMs).toBe(2000)
  })
})

describe('what the headers say is left of the allowance', () => {
  test('is passed on as a meter before the answer, when the service sends it', async () => {
    const { fetchImpl } = respondWith(okStream, {
      headers: {
        'x-ratelimit-limit-requests': '100',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-reset-requests': '1s',
        'x-ratelimit-limit-tokens': '1000',
        'x-ratelimit-remaining-tokens': '250',
        'x-ratelimit-reset-tokens': '6m0s',
      },
    })
    const provider = createOpenAiCompatProvider({
      id: 'openai',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })
    const before = Date.now()

    const out = await drain(provider.send(request, new AbortController().signal))

    const meter = out[0] as { type: string; providerId: string; windows: MeterWindow[] }
    expect(meter.type).toBe('meter')
    expect(meter.providerId).toBe('openai')
    expect(meter.windows.map((window) => [window.name, window.usedFraction])).toEqual([
      ['requests', 0.01],
      ['tokens', 0.75],
    ])
    const tokens = meter.windows[1] as MeterWindow
    expect(tokens.resetsAt.getTime()).toBeGreaterThanOrEqual(before + 360_000)
    expect(tokens.resetsAt.getTime()).toBeLessThan(before + 361_000)
  })

  test('is not mentioned at all when the service says nothing', async () => {
    const { fetchImpl } = respondWith(okStream)
    const provider = createOpenAiCompatProvider({
      id: 'ollama',
      baseUrl: 'https://example.test/v1',
      apiKey: 'k',
      fetchImpl,
    })

    const out = await drain(provider.send(request, new AbortController().signal))

    expect(out.some((delta) => (delta as { type: string }).type === 'meter')).toBe(false)
  })
})
