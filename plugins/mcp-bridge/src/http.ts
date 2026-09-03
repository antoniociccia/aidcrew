import type { Transport } from './client.ts'
import type { JsonRpcResponse } from './protocol.ts'
import { McpError } from './protocol.ts'

/**
 * A server reached over HTTP, in the streamable transport.
 *
 * One endpoint takes every message as a POST. The answer comes back either as
 * plain JSON or as a server-sent event stream, and which of the two is the
 * server's choice rather than ours — so both are read, and the difference
 * stops here.
 */

export type HttpOptions = {
  url: string
  /** Sent with every request. Where a server needs a token, this is where it goes. */
  headers?: Record<string, string>
  fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
}

const CALL_TIMEOUT_MS = 120_000

export function createHttpTransport(name: string, options: HttpOptions): Transport {
  const doFetch = options.fetchImpl ?? ((url, init) => fetch(url, init))
  let nextId = 0
  /**
   * The session this server gave us, echoed back on every later message.
   *
   * Servers that keep state hand one out at initialize and reject anything
   * that arrives without it, with a 404 that reads like the wrong URL.
   */
  let session: string | undefined

  async function post(payload: unknown, signal: AbortSignal): Promise<Response> {
    return await doFetch(options.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Both, because the server picks: JSON for a plain answer, SSE when
        // it wants to stream. Offering one closes off half the servers.
        Accept: 'application/json, text/event-stream',
        ...(session ? { 'Mcp-Session-Id': session } : {}),
        ...options.headers,
      },
      body: JSON.stringify(payload),
      signal,
    })
  }

  return {
    async request(method, params, signal) {
      nextId += 1
      const id = nextId

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS)
      const onAbort = () => controller.abort()
      signal.addEventListener('abort', onAbort, { once: true })

      try {
        const response = await post({ jsonrpc: '2.0', id, method, params }, controller.signal)

        const given = response.headers.get('Mcp-Session-Id')
        if (given) session = given

        if (!response.ok) {
          const detail = await response.text().catch(() => '')
          throw new McpError(
            name,
            `${response.status} ${response.statusText}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
          )
        }

        const contentType = response.headers.get('Content-Type') ?? ''
        const message = contentType.includes('text/event-stream')
          ? await readEventStream(response, id)
          : ((await response.json()) as JsonRpcResponse)

        return message ?? { jsonrpc: '2.0', id, error: { code: -1, message: 'no answer' } }
      } finally {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
      }
    },

    async notify(method, params) {
      // A notification's answer is 202 with no body, and there is nothing to
      // wait for — but a failure to deliver `initialized` leaves the server
      // refusing everything after it, so it is not fire-and-forget either.
      const response = await post({ jsonrpc: '2.0', method, params }, new AbortController().signal)
      if (!response.ok && response.status !== 202) {
        throw new McpError(name, `${method} was refused: ${response.status}`)
      }
      await response.body?.cancel()
    },

    async close() {
      if (!session) return
      // Politeness rather than necessity: a server that keeps state should be
      // told the conversation is over, and one that does not simply refuses.
      await doFetch(options.url, {
        method: 'DELETE',
        headers: { 'Mcp-Session-Id': session, ...options.headers },
      }).catch(() => undefined)
      session = undefined
    },
  }
}

/** The first event carrying the response we asked for. */
async function readEventStream(
  response: Response,
  id: number,
): Promise<JsonRpcResponse | undefined> {
  if (!response.body) return undefined

  const decoder = new TextDecoder()
  let buffered = ''

  for await (const chunk of response.body as ReadableStream<Uint8Array>) {
    buffered += decoder.decode(chunk, { stream: true })

    let boundary = buffered.indexOf('\n\n')
    while (boundary !== -1) {
      const block = buffered.slice(0, boundary)
      buffered = buffered.slice(boundary + 2)
      boundary = buffered.indexOf('\n\n')

      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trim())
        .join('')

      if (data === '') continue

      try {
        const message = JSON.parse(data) as JsonRpcResponse
        // A stream can carry the server's own requests and notifications
        // alongside the answer; only the one we asked for ends this.
        if (message.id === id) return message
      } catch {
        // Not protocol. Skip it rather than fail the call.
      }
    }
  }

  return undefined
}
