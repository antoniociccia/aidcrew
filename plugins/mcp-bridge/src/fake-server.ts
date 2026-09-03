#!/usr/bin/env bun
/**
 * A real MCP server, small enough to read, used by the tests.
 *
 * A stub client talking to a stub server proves nothing about a protocol: the
 * failures worth catching are the ordering ones — the notification that must
 * not be a request, the message split across two reads — and those only appear
 * when the bytes actually go through a pipe.
 *
 * Behaviour is chosen by the first argument:
 *   (none)   answers normally
 *   noisy    prints a banner to stdout before the protocol, as many do
 *   split    writes each message in two halves, to break naive line reading
 *   crash    exits as soon as it is asked for anything
 *   quits    completes the handshake, complains on stderr, and then exits
 *   asks     sends a request of its own, with the same id, before each answer
 */

const mode = process.argv[2] ?? 'normal'

const TOOLS = [
  {
    name: 'echo',
    description: 'Says back what it was given.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'explode',
    description: 'Always fails, so a failing tool can be tested.',
    inputSchema: { type: 'object', properties: {} },
  },
]

function reply(id: unknown, result: unknown): void {
  const line = `${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`
  if (mode === 'split') {
    const half = Math.floor(line.length / 2)
    process.stdout.write(line.slice(0, half))
    setTimeout(() => process.stdout.write(line.slice(half)), 5)
    return
  }
  process.stdout.write(line)
}

function fail(id: unknown, code: number, message: string): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`)
}

if (mode === 'noisy') {
  process.stdout.write('fake-server listening\n')
  process.stderr.write('starting up\n')
}

let buffered = ''
for await (const chunk of Bun.stdin.stream()) {
  buffered += new TextDecoder().decode(chunk)

  let newline = buffered.indexOf('\n')
  while (newline !== -1) {
    const line = buffered.slice(0, newline).trim()
    buffered = buffered.slice(newline + 1)
    newline = buffered.indexOf('\n')
    if (line === '') continue

    const message = JSON.parse(line) as { id?: unknown; method?: string; params?: unknown }

    if (mode === 'crash') process.exit(3)

    // An answer to something this server asked. Nothing here waits for one,
    // so it is read and dropped — a server must not answer an answer.
    if (message.method === undefined) continue

    if (mode === 'asks' && message.id !== undefined) {
      // A server may ask the client things — `ping` is in the protocol — and
      // its ids are its own, so one can collide with an id the client is
      // waiting on. A client that keys only on the id takes this for the
      // answer to its call.
      process.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: message.id, method: 'ping' })}\n`,
      )
    }

    if (message.method === 'initialize') {
      reply(message.id, {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1.0.0' },
      })
      continue
    }

    // A notification has no id and must never be answered. Answering it is
    // what the test of the handshake is really checking.
    if (message.method === 'notifications/initialized') continue

    if (message.method === 'tools/list') {
      reply(message.id, { tools: TOOLS })
      if (mode === 'quits') {
        // Gone between calls, the way a server that runs out of memory or is
        // killed by the system goes: after a handshake that worked, with a
        // last word on stderr and nothing on stdout.
        process.stderr.write('out of memory\n')
        setTimeout(() => process.exit(1), 20)
      }
      continue
    }

    if (message.method === 'tools/call') {
      const params = message.params as { name?: string; arguments?: { text?: string } }
      if (params.name === 'explode') {
        reply(message.id, {
          content: [{ type: 'text', text: 'it exploded' }],
          isError: true,
        })
        continue
      }
      reply(message.id, {
        content: [{ type: 'text', text: `echo: ${params.arguments?.text ?? ''}` }],
      })
      continue
    }

    fail(message.id, -32601, `no such method: ${message.method}`)
  }
}
