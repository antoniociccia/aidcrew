import type { CanonicalRequest, Provider, StreamDelta } from '@aidcrew/core'
import { ProviderProtocolError, ProviderResponseError } from '@aidcrew/core'
import { buildRequestBody } from './request.ts'
import { parseAnthropicStream } from './stream.ts'

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

export type AnthropicConfig = {
  baseUrl: string
  apiKey: string
  /** Pinned by the caller: the wire format is versioned, and silently
   *  following the newest one is how a working setup breaks overnight. */
  version: string
  fetchImpl?: FetchImpl
}

/**
 * Whether sending the very same request again can succeed.
 *
 * Every 5xx, not a list of them. The list this replaced had the usual five
 * and not 529, which is this service's own status for "overloaded" and the
 * transient failure it answers with most — so the one failure most worth
 * waiting out was the one that ended an agent's turn for good. A service
 * that has just invented a new way to say "not right now" is, by
 * definition, worth asking again.
 */
function isRetryable(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500
}

/**
 * The models this key can ask for.
 *
 * Same path as the OpenAI-shaped services and a different door: `x-api-key`
 * and a pinned version, where they want a bearer token. That difference is the
 * reason this belongs to the provider — the one shared implementation that
 * assumed a bearer token left Anthropic with no list at all, and a blank field
 * is where mistyped model ids come from.
 */
export async function listAnthropicModels(
  config: AnthropicConfig,
  signal: AbortSignal,
): Promise<string[]> {
  const doFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { 'x-api-key': config.apiKey, 'anthropic-version': config.version },
    signal,
  })

  if (!response.ok) {
    // Worth separating from a general failure: finding out the key is wrong
    // while choosing a model beats finding out on the first real request.
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'the key was rejected'
        : `anthropic answered ${response.status}`,
    )
  }

  const body: unknown = await response.json()
  const rows = (body as { data?: unknown })?.data
  if (!Array.isArray(rows)) throw new Error('anthropic answered with no model list')

  return rows
    .map((row) => (row as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string')
}

export function createAnthropicProvider(config: AnthropicConfig): Provider {
  const endpoint = `${config.baseUrl.replace(/\/+$/, '')}/messages`
  const doFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))

  return {
    id: 'anthropic',

    async *send(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<StreamDelta> {
      let response: Response
      try {
        response = await doFetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            // Not a bearer token: this API authenticates with its own header.
            'x-api-key': config.apiKey,
            'anthropic-version': config.version,
          },
          body: JSON.stringify(buildRequestBody(request)),
          signal,
        })
      } catch (cause) {
        throw asProviderFailure(cause, signal, `could not reach ${endpoint}`)
      }

      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new ProviderResponseError(
          `anthropic returned ${response.status} ${response.statusText}: ${truncate(detail)}`,
          'anthropic',
          isRetryable(response.status),
        )
      }
      if (!response.body) {
        throw new ProviderResponseError('anthropic returned no body', 'anthropic', true)
      }

      try {
        yield* parseAnthropicStream(response.body, 'anthropic')
      } catch (cause) {
        throw asProviderFailure(cause, signal, `lost the connection to ${endpoint}`)
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
  return new ProviderResponseError(`anthropic: ${what}: ${reason(cause)}`, 'anthropic', true)
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

function truncate(detail: string): string {
  const trimmed = detail.trim()
  return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed
}
