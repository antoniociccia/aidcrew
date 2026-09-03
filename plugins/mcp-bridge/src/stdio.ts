import type { Transport } from './client.ts'
import type { JsonRpcRequest, JsonRpcResponse } from './protocol.ts'
import { McpError } from './protocol.ts'

/**
 * A server running as a child process, spoken to over its standard input and
 * output: one JSON-RPC message per line, in both directions.
 *
 * This is how nearly every MCP server ships, and it means a server is an
 * arbitrary program started on the user's machine. Deciding whether to start
 * one is not this file's business — see `servers.ts`, where a project's
 * servers are not run until somebody has said they may be.
 */

export type StdioOptions = {
  command: string
  args?: string[]
  /**
   * Extra environment for the server, on top of a deliberately small base.
   *
   * Nothing is inherited wholesale: our environment holds the API keys for
   * every provider on the team, and a tool server has no business reading
   * them. What a server genuinely needs — its own token, usually — is named
   * here, in the file that declares the server.
   */
  env?: Record<string, string>
  cwd?: string
}

/** How long to wait for a server to answer before giving up on it. */
const CALL_TIMEOUT_MS = 120_000
/** A slow server is normal; one that never speaks at all is not. */
const START_TIMEOUT_MS = 30_000

export function createStdioTransport(name: string, options: StdioOptions): Transport {
  let child: ReturnType<typeof Bun.spawn> | undefined
  let nextId = 0
  let buffered = ''
  let reading: Promise<void> | undefined

  const waiting = new Map<number | string, (response: JsonRpcResponse) => void>()
  /** What the server wrote to stderr, kept for the error message. */
  let complaint = ''
  let complaining: Promise<void> | undefined
  /**
   * Why the server is gone, once it is.
   *
   * A server that died while nothing was pending used to leave the transport
   * holding a dead pipe: the next request was written into it and waited the
   * full call timeout to say "timed out", two minutes after the real answer —
   * it exited, and this is what it said — was already known.
   */
  let gone: string | undefined

  function start(): ReturnType<typeof Bun.spawn> {
    if (child) return child

    try {
      child = Bun.spawn([options.command, ...(options.args ?? [])], {
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
        ...(options.cwd ? { cwd: options.cwd } : {}),
        env: {
          PATH: process.env.PATH ?? '/usr/bin:/bin',
          HOME: process.env.HOME ?? '',
          ...options.env,
        },
      })
    } catch (cause) {
      throw new McpError(
        name,
        `could not start "${options.command}": ${cause instanceof Error ? cause.message : String(cause)}`,
      )
    }

    complaining = collectStderr(child)
    reading = pump(child)
    return child
  }

  /** Reads whole lines out of stdout and hands each to whoever is waiting. */
  async function pump(process: ReturnType<typeof Bun.spawn>): Promise<void> {
    const decoder = new TextDecoder()

    for await (const chunk of process.stdout as ReadableStream<Uint8Array>) {
      buffered += decoder.decode(chunk, { stream: true })

      // A message can arrive split across reads, and several can arrive in
      // one, so lines are the unit and the remainder is kept.
      let newline = buffered.indexOf('\n')
      while (newline !== -1) {
        const line = buffered.slice(0, newline).trim()
        buffered = buffered.slice(newline + 1)
        newline = buffered.indexOf('\n')

        if (line === '') continue
        deliver(line)
      }
    }

    // The process ended. Its last words are on stderr, which closes a moment
    // apart from stdout; waited for briefly so that the message says why it
    // died rather than only that it did, and bounded so a grandchild holding
    // the pipe open cannot keep this from ever returning.
    await Promise.race([complaining, Bun.sleep(200)])
    const code = process.exitCode
    gone = `the server exited${code === null ? '' : ` with code ${code}`}${
      complaint === '' ? '' : ` (stderr: ${complaint})`
    }`

    // Anything still waiting will never be answered, and leaving those
    // promises pending would hang the agent rather than fail it.
    for (const [id, resolve] of waiting) resolve(failed(id, gone))
    waiting.clear()
  }

  function deliver(line: string): void {
    let message: Partial<JsonRpcRequest & JsonRpcResponse>
    try {
      message = JSON.parse(line) as Partial<JsonRpcRequest & JsonRpcResponse>
    } catch {
      // Servers do print things to stdout that are not protocol — a startup
      // banner, a stray log line. Ignoring them is right; failing on them
      // would make half the servers in the world unusable.
      return
    }

    // A message with a method is the server asking, not answering. Its ids
    // are its own and can collide with one we are waiting on, and matching on
    // the id alone handed a `ping` to a tool call as its result. A ping is
    // answered, as the protocol asks; anything else it wants is not offered.
    if (message.method !== undefined) {
      if (message.id !== undefined) void answer(message.id, message.method)
      return
    }

    const resolve = message.id === undefined ? undefined : waiting.get(message.id)
    if (!resolve || message.id === undefined) return
    waiting.delete(message.id)
    resolve(message as JsonRpcResponse)
  }

  async function answer(id: number | string, method: string): Promise<void> {
    await write(
      method === 'ping'
        ? { jsonrpc: '2.0', id, result: {} }
        : { jsonrpc: '2.0', id, error: { code: -32601, message: `no such method: ${method}` } },
    )
  }

  async function collectStderr(process: ReturnType<typeof Bun.spawn>): Promise<void> {
    const text = await new Response(process.stderr as ReadableStream<Uint8Array>).text()
    // The end rather than the start: a server that logs as it runs puts the
    // reason it died after everything else it had to say.
    complaint = text.trim().slice(-2000)
  }

  async function write(payload: unknown): Promise<void> {
    const process = start()
    const writer = process.stdin as { write(chunk: string): void; flush?(): void }
    writer.write(`${JSON.stringify(payload)}\n`)
    writer.flush?.()
  }

  return {
    async request(method, params, signal) {
      nextId += 1
      const id = nextId
      if (gone !== undefined) return failed(id, gone)

      const answered = new Promise<JsonRpcResponse>((resolve) => waiting.set(id, resolve))

      await write({ jsonrpc: '2.0', id, method, params })

      const limit = method === 'initialize' ? START_TIMEOUT_MS : CALL_TIMEOUT_MS
      return await Promise.race([
        answered,
        timeout(limit, id, method),
        cancelled(signal, id),
      ]).finally(() => waiting.delete(id))
    },

    async notify(method, params) {
      await write({ jsonrpc: '2.0', method, params })
    },

    async close() {
      child?.kill()
      child = undefined
      await reading?.catch(() => {})
      // Closed on purpose is not gone: a request after this starts it again.
      gone = undefined
      complaint = ''
    },
  }
}

function failed(id: number | string, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code: -1, message } }
}

function timeout(ms: number, id: number, method: string): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve({
        jsonrpc: '2.0',
        id,
        error: { code: -2, message: `${method} timed out after ${Math.round(ms / 1000)}s` },
      })
    }, ms)
    // Never the reason a process stays alive.
    timer.unref?.()
  })
}

/** Turns an abort into an answer, so a cancelled turn does not leave a promise. */
function cancelled(signal: AbortSignal, id: number): Promise<JsonRpcResponse> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve({ jsonrpc: '2.0', id, error: { code: -3, message: 'cancelled' } })
      return
    }
    signal.addEventListener(
      'abort',
      () => resolve({ jsonrpc: '2.0', id, error: { code: -3, message: 'cancelled' } }),
      { once: true },
    )
  })
}
