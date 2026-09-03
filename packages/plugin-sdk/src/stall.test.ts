import { describe, expect, test } from 'bun:test'
import { ProviderResponseError } from '@aidcrew/core'
import { DEFAULT_STALL_TIMEOUTS, watchForStall } from './stall.ts'

const encoder = new TextEncoder()

/** A body that sends what it is given, then goes quiet until it is released. */
function quietAfter(chunks: string[]): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent < chunks.length) {
        controller.enqueue(encoder.encode(chunks[sent++] as string))
        return
      }
      // Never resolves: the service has stopped talking without hanging up.
      return new Promise<void>(() => {})
    },
  })
}

/** A fetch that never answers, but does notice when it is told to stop. */
function neverAnswers(init: RequestInit): Promise<Response> {
  return new Promise<Response>((_, reject) => {
    init.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    )
  })
}

async function collect(body: AsyncIterable<Uint8Array>): Promise<string[]> {
  const out: string[] = []
  for await (const chunk of body) out.push(new TextDecoder().decode(chunk))
  return out
}

describe('a request that never answers', () => {
  test('is given up on, naming who was asked, for what, and how long it waited', async () => {
    // A stalled upstream held a turn for twenty-three minutes in a real run:
    // no error, no bytes, nothing on the screen but a spinner. The wait has
    // to end on its own, and the error has to say enough to act on.
    const watch = watchForStall({
      provider: 'zen',
      model: 'gpt-5',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 20 },
    })

    const error = await neverAnswers({ signal: watch.signal }).then(
      () => undefined,
      (cause: unknown) => watch.failure(cause),
    )

    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as Error).message).toContain('zen')
    expect((error as Error).message).toContain('gpt-5')
    expect((error as Error).message).toContain('20ms')
  })

  test('is worth sending again, since nothing of the answer was lost', async () => {
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 20 },
    })

    const error = await neverAnswers({ signal: watch.signal }).then(
      () => undefined,
      (cause: unknown) => watch.failure(cause),
    )

    expect((error as ProviderResponseError).retryable).toBe(true)
  })
})

describe('an answer that goes quiet halfway', () => {
  test('is cut off after the idle limit, keeping what arrived', async () => {
    const watch = watchForStall({
      provider: 'zen',
      model: 'gpt-5',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 1000, idleMs: 20 },
    })
    const seen: string[] = []

    const error = await (async () => {
      try {
        for await (const chunk of watch.body(quietAfter(['hello ']))) {
          seen.push(new TextDecoder().decode(chunk))
        }
        return undefined
      } catch (cause) {
        return cause
      }
    })()

    expect(seen).toEqual(['hello '])
    expect(error).toBeInstanceOf(ProviderResponseError)
    expect((error as Error).message).toContain('gpt-5')
    expect((error as Error).message).toContain('20ms')
  })

  test('is not sent again, because half an answer has already gone out', async () => {
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 1000, idleMs: 20 },
    })

    const error = await collect(watch.body(quietAfter(['hello ']))).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect((error as ProviderResponseError).retryable).toBe(false)
  })

  test('allows a slow start, as long as the first byte arrives in time', async () => {
    // The two limits are different on purpose: a model can take a minute to
    // start on a long prompt, but once it is talking, a minute of silence is
    // a connection that has died.
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 200, idleMs: 20 },
    })
    const slowStart = new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 60))
        controller.enqueue(encoder.encode('late'))
        controller.close()
      },
    })

    expect(await collect(watch.body(slowStart))).toEqual(['late'])
  })
})

describe('a healthy stream', () => {
  test('passes through untouched, and leaves no clock running afterwards', async () => {
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 30, idleMs: 30 },
    })
    const steady = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const word of ['one', 'two', 'three']) {
          await new Promise((resolve) => setTimeout(resolve, 10))
          controller.enqueue(encoder.encode(word))
        }
        controller.close()
      },
    })

    expect(await collect(watch.body(steady))).toEqual(['one', 'two', 'three'])

    // Long after the idle limit, nothing has been aborted: the clock stopped
    // when the stream ended, rather than firing into a request that was over.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(watch.signal.aborted).toBe(false)
  })

  test('uses limits generous enough for a long prompt on a slow model', () => {
    expect(DEFAULT_STALL_TIMEOUTS.firstByteMs).toBeGreaterThanOrEqual(60_000)
    expect(DEFAULT_STALL_TIMEOUTS.idleMs).toBeGreaterThanOrEqual(30_000)
  })
})

describe('a stop the caller asked for', () => {
  test('passes through as it came, not dressed up as a stall', async () => {
    const controller = new AbortController()
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: controller.signal,
      timeouts: { firstByteMs: 1000 },
    })
    setTimeout(() => controller.abort(), 10)

    const error = await neverAnswers({ signal: watch.signal }).then(
      () => undefined,
      (cause: unknown) => watch.failure(cause),
    )

    expect(error).not.toBeInstanceOf(ProviderResponseError)
    expect((error as Error).name).toBe('AbortError')
  })

  test('is noticed by the body too, without waiting for the idle limit', async () => {
    const controller = new AbortController()
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: controller.signal,
      timeouts: { firstByteMs: 1000, idleMs: 1000 },
    })
    const started = Date.now()
    setTimeout(() => controller.abort(), 10)

    const error = await collect(watch.body(quietAfter([]))).then(
      () => undefined,
      (cause: unknown) => cause,
    )

    expect(error).not.toBeInstanceOf(ProviderResponseError)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('releasing the watch', () => {
  test('stops the clock, so a request that ended early is not aborted later', async () => {
    const watch = watchForStall({
      provider: 'zen',
      model: 'm',
      signal: new AbortController().signal,
      timeouts: { firstByteMs: 10 },
    })

    watch.release()
    await new Promise((resolve) => setTimeout(resolve, 30))

    expect(watch.signal.aborted).toBe(false)
  })
})
