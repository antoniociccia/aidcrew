import type { CanonicalRequest, Provider, StreamDelta } from '@aidcrew/core'
import { ProviderProtocolError, ProviderResponseError } from '@aidcrew/core'
import { buildRequestBody } from './request.ts'
import type { ThoughtSignatures } from './stream.ts'
import { parseGeminiStream } from './stream.ts'

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export type GeminiConfig = {
  baseUrl: string
  apiKey: string
  fetchImpl?: FetchImpl
}

const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])

export function createGeminiProvider(config: GeminiConfig): Provider {
  const base = config.baseUrl.replace(/\/+$/, '')
  const doFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))

  /**
   * Every signature a thinking model has attached to a call, for as long as
   * this provider lives.
   *
   * Kept here rather than in the conversation because the canonical model has
   * no field for it, and rather than in the call's arguments because a tool
   * would then be handed it. Never pruned: a conversation can reach back to
   * any call it still remembers, and there is no telling from here which
   * those are. Ids are unique for the life of the process, so nothing here is
   * ever overwritten by a call from another conversation.
   */
  const signatures: ThoughtSignatures = new Map()

  return {
    id: 'gemini',

    async *send(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<StreamDelta> {
      // The model is part of the path here, not a field in the body, and the
      // streaming variant is a different method rather than a flag. `alt=sse`
      // is what makes it a server-sent event stream instead of a JSON array
      // delivered in pieces, which nothing else here could read.
      const url = `${base}/models/${encodeURIComponent(request.model)}:streamGenerateContent?alt=sse`

      let response: Response
      try {
        response = await doFetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // In a header rather than the query string: a key in a URL is a key
            // in every proxy log between here and Google.
            'x-goog-api-key': config.apiKey,
          },
          body: JSON.stringify(buildRequestBody(request, signatures)),
          signal,
        })
      } catch (cause) {
        throw asProviderFailure(cause, signal, `could not reach ${url}`)
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new ProviderResponseError(
          `gemini: ${explain(detail) ?? `${response.status} ${response.statusText}`}`,
          'gemini',
          RETRYABLE_STATUSES.has(response.status),
        )
      }
      if (!response.body) {
        throw new ProviderResponseError('gemini returned no body', 'gemini', true)
      }

      try {
        yield* parseGeminiStream(response.body, 'gemini', signatures)
      } catch (cause) {
        throw asProviderFailure(cause, signal, `lost the connection to ${url}`)
      }
    },
  }
}

/**
 * A network failure as something the rest of the system can act on.
 *
 * A refused connection, a name that will not resolve, a certificate the
 * machine does not trust, a socket reset halfway through the answer: `fetch`
 * reports every one of them as a bare "TypeError: fetch failed", with no
 * provider, no address, and the actual reason tucked under `cause` where
 * nothing prints it. And because that is not a ProviderResponseError, the
 * retry wrapper — which retries only what a provider marks — let a
 * two-second blip end the agent's turn.
 *
 * Retryable, because that is what a network failure is. Two things pass
 * through untouched: what the parser already said, which is a better error
 * than this one, and a stop the caller asked for — dressed up as "could not
 * reach", the person who pressed stop would be told the service was down.
 */
function asProviderFailure(cause: unknown, signal: AbortSignal, what: string): unknown {
  if (signal.aborted) return cause
  if (cause instanceof ProviderResponseError || cause instanceof ProviderProtocolError) return cause
  return new ProviderResponseError(`gemini: ${what}: ${reason(cause)}`, 'gemini', true)
}

/**
 * The line that says what to check.
 *
 * Node's fetch says "fetch failed" and keeps the real error under `cause`;
 * Bun's says "Unable to connect" and keeps a `code`. Whichever it was, the
 * innermost message plus the code is the part a person can search for.
 */
function reason(cause: unknown): string {
  const inner = cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause
  const message = inner instanceof Error ? inner.message : String(inner)
  const code = (inner as { code?: unknown } | null | undefined)?.code
  return typeof code === 'string' && !message.includes(code) ? `${message} (${code})` : message
}

/** The message inside the error envelope, which says more than the status. */
function explain(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } }
    const message = parsed.error?.message
    if (typeof message !== 'string') return undefined
    return message.length > 500 ? `${message.slice(0, 500)}…` : message
  } catch {
    return undefined
  }
}
