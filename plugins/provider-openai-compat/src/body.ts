import { ProviderResponseError } from '@aidcrew/core'

/**
 * What a response body says, read for the cases where the status did not.
 *
 * A status other than 200 is read for its sentence in `provider.ts`. But some
 * gateways answer 200 to everything and put the refusal in the body, and some
 * ignore `stream: true` and send the completion whole — either way a body with
 * no `data:` lines in it, which parsed as a stream is a stream of nothing.
 * Those turns came out empty and cost nothing, so they read as the model
 * choosing to say nothing, and the sentence that explained it was never shown.
 */

/**
 * How much of a body is remembered while it is parsed.
 *
 * Enough for any refusal and for most completions sent whole, and small
 * enough that a stream which is fine is not held twice for its whole length.
 */
const KEPT_BYTES = 64 * 1024

export type Remembered = {
  bytes: AsyncIterable<Uint8Array>
  /** What went by, decoded — the first `KEPT_BYTES` of it. */
  text(): string
}

/** Passes a body through, keeping its start for the case where parsing finds nothing. */
export function remembering(body: AsyncIterable<Uint8Array>): Remembered {
  const kept: Uint8Array[] = []
  let size = 0

  async function* bytes(): AsyncIterable<Uint8Array> {
    for await (const chunk of body) {
      if (size < KEPT_BYTES) {
        kept.push(chunk)
        size += chunk.byteLength
      }
      yield chunk
    }
  }

  return {
    bytes: bytes(),
    text() {
      const decoder = new TextDecoder()
      return (
        kept.map((chunk) => decoder.decode(chunk, { stream: true })).join('') + decoder.decode()
      )
    },
  }
}

/**
 * The error for a 200 that carried no events.
 *
 * Final rather than retryable: a gateway that answers this way answers this
 * way to the same request again, and three waits only postpone the message.
 */
export function notAStream(text: string, providerId: string): ProviderResponseError {
  const complaint = explain(text)
  const quoted = text.trim() === '' ? 'an empty body' : truncate(text, 200)
  return new ProviderResponseError(
    complaint ? `${providerId}: ${complaint}` : `${providerId} answered 200 with ${quoted}`,
    providerId,
    false,
  )
}

/** The sentence inside the JSON envelopes gateways put their refusals in. */
export function explain(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: unknown } | string
      message?: unknown
    }
    const message =
      typeof parsed.error === 'string'
        ? parsed.error
        : typeof parsed.error?.message === 'string'
          ? parsed.error.message
          : typeof parsed.message === 'string'
            ? parsed.message
            : undefined

    return message === undefined ? undefined : truncate(message)
  } catch {
    return undefined
  }
}

export function truncate(detail: string, max = 500): string {
  const trimmed = detail.trim()
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed
}
