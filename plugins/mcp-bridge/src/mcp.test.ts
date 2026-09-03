import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bridgedName, bridgeTools } from './bridge.ts'
import { McpClient } from './client.ts'
import { createHttpTransport } from './http.ts'
import { renderResult } from './protocol.ts'
import { connectAll, readServers } from './servers.ts'
import { createStdioTransport } from './stdio.ts'
import type { TrustStore } from './trust.ts'
import { createTrust, describe as describeServer } from './trust.ts'

const SERVER = join(import.meta.dir, 'fake-server.ts')
const never = new AbortController().signal

let root: string | undefined
const opened: McpClient[] = []

afterEach(async () => {
  for (const client of opened.splice(0)) await client.close()
  if (root) rmSync(root, { recursive: true, force: true })
  root = undefined
})

async function connect(mode = 'normal'): Promise<McpClient> {
  const client = new McpClient(
    'fake',
    createStdioTransport('fake', { command: 'bun', args: [SERVER, mode] }),
  )
  opened.push(client)
  await client.connect(never)
  return client
}

function project(files: Record<string, unknown>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-mcp-'))
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(root, name), JSON.stringify(body, null, 2))
  }
  return root
}

describe('talking to a server over its own stdin and stdout', () => {
  test('completes the handshake and learns what the server can do', async () => {
    const client = await connect()

    expect(client.info).toMatchObject({ name: 'fake' })
    expect(client.tools.map((tool) => tool.name).sort()).toEqual(['echo', 'explode'])
  })

  test('calls a tool and gets its answer back', async () => {
    const client = await connect()

    const result = await client.callTool('echo', { text: 'hello' }, never)

    expect(renderResult(result)).toBe('echo: hello')
  })

  test('survives a server that writes a banner before speaking protocol', async () => {
    // Plenty of servers print something on startup. Failing on it would make
    // half of them unusable, so anything that is not JSON is skipped.
    const client = await connect('noisy')

    expect(client.tools).toHaveLength(2)
  })

  test('reads a message that arrives in two pieces', async () => {
    // A pipe splits wherever it likes, and a naive reader loses the message.
    const client = await connect('split')

    expect(renderResult(await client.callTool('echo', { text: 'halves' }, never))).toBe(
      'echo: halves',
    )
  })

  test('fails rather than hangs when the server dies', async () => {
    const client = new McpClient(
      'dead',
      createStdioTransport('dead', { command: 'bun', args: [SERVER, 'crash'] }),
    )
    opened.push(client)

    // The dangerous failure is not an error: it is a promise nobody resolves,
    // which stops the agent with no message at all.
    expect(client.connect(never)).rejects.toThrow(/exited/)
  })

  test('fails at once, not after two minutes, when the server has gone between calls', async () => {
    // A server that died while nothing was pending left the transport holding
    // a dead pipe: the next call was written into it and waited the full
    // two-minute timeout to say "timed out", when the true answer — it
    // exited, and this is what it said — was known the moment it went.
    const client = await connect('quits')
    await Bun.sleep(250)

    const started = Date.now()
    await expect(client.callTool('echo', { text: 'anyone there' }, never)).rejects.toThrow(
      /exited.*out of memory/,
    )
    expect(Date.now() - started).toBeLessThan(2000)
  })

  test('does not mistake a request from the server for the answer it is waiting on', async () => {
    // A server's ids are its own, so a `ping` it sends can carry the same id
    // as the call the client is waiting on. Matched by id alone, the ping was
    // taken for the answer, and the tool appeared to have returned nothing.
    const client = await connect('asks')

    expect(renderResult(await client.callTool('echo', { text: 'me' }, never))).toBe('echo: me')
  })

  test('fails rather than hangs when the command does not exist', async () => {
    const client = new McpClient(
      'missing',
      createStdioTransport('missing', { command: 'definitely-not-a-real-command-xyz' }),
    )
    opened.push(client)

    expect(client.connect(never)).rejects.toThrow()
  })

  test('does not hand the server our environment', async () => {
    // The environment holds every provider key on the team. A tool server has
    // no business reading them, and most servers are somebody else's code.
    const transport = createStdioTransport('env', {
      command: 'bun',
      args: [
        '-e',
        'console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{leaked:process.env.AIDCREW_API_KEY ?? null}}))',
      ],
    })

    process.env.AIDCREW_API_KEY = 'sk-should-not-escape'
    try {
      const response = await transport.request('initialize', {}, never)
      expect((response.result as { leaked: string | null }).leaked).toBeNull()
    } finally {
      delete process.env.AIDCREW_API_KEY
      await transport.close()
    }
  })
})

describe('a server reached over HTTP', () => {
  test('sends and reads JSON-RPC, and keeps the session it is given', async () => {
    const seen: { session: string | null; method: string }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id?: number; method: string }
        seen.push({ session: request.headers.get('Mcp-Session-Id'), method: body.method })

        if (body.method === 'initialize') {
          return Response.json(
            { jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'over-http' } } },
            { headers: { 'Mcp-Session-Id': 'session-1' } },
          )
        }
        if (body.method === 'tools/list') {
          return Response.json({
            jsonrpc: '2.0',
            id: body.id,
            result: { tools: [{ name: 'ping', inputSchema: { type: 'object' } }] },
          })
        }
        return new Response(null, { status: 202 })
      },
    })

    try {
      const client = new McpClient(
        'remote',
        createHttpTransport('remote', { url: server.url.href }),
      )
      await client.connect(never)

      expect(client.tools.map((tool) => tool.name)).toEqual(['ping'])
      // Given at initialize, echoed on everything after: a server that keeps
      // state refuses messages without it, with a 404 that reads like a typo.
      expect(seen[0]?.session).toBeNull()
      expect(seen.at(-1)?.session).toBe('session-1')
    } finally {
      server.stop(true)
    }
  })

  test('reads an answer delivered as an event stream', async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as { id?: number; method: string }
        if (body.method !== 'initialize') return new Response(null, { status: 202 })

        // Whether the answer is JSON or a stream is the server's choice, and
        // a client that reads only one of them works with half of them.
        const events = [
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message' })}\n\n`,
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { serverInfo: { name: 'streamed' } } })}\n\n`,
        ].join('')
        return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })

    try {
      const transport = createHttpTransport('streamed', { url: server.url.href })
      const response = await transport.request('initialize', {}, never)

      expect(response.result).toMatchObject({ serverInfo: { name: 'streamed' } })
    } finally {
      server.stop(true)
    }
  })
})

describe('bridging a server tool into ours', () => {
  test('names it after the server, so two servers can both offer "search"', () => {
    expect(bridgedName('linear', 'create_issue')).toBe('mcp__linear__create_issue')
    // Providers only accept [A-Za-z0-9_-] in a function name.
    expect(bridgedName('my server', 'do.thing')).toBe('mcp__my_server__do_thing')
  })

  test('the result is an ordinary tool, and the loop cannot tell the difference', async () => {
    const client = await connect()

    const [echo] = bridgeTools(client)
    expect(echo?.name).toBe('mcp__fake__echo')
    expect(echo?.inputSchema).toMatchObject({ type: 'object' })

    const output = await echo?.execute(
      { text: 'through the bridge' },
      {
        cwd: process.cwd(),
        agentId: 'a',
        signal: never,
      },
    )
    expect(output?.content).toBe('echo: through the bridge')
  })

  test('a tool that fails on the server is a failed call, not a failed turn', async () => {
    const client = await connect()

    const explode = bridgeTools(client).find((tool) => tool.name.endsWith('explode'))
    const output = await explode?.execute({}, { cwd: process.cwd(), agentId: 'a', signal: never })

    expect(output).toMatchObject({ content: 'it exploded', isError: true })
  })
})

describe('reading what a project declares', () => {
  test('reads .mcp.json as everybody else writes it', async () => {
    const root = project({
      '.mcp.json': {
        mcpServers: {
          linear: { command: 'npx', args: ['-y', 'linear-mcp'] },
          docs: { url: 'https://example.com/mcp' },
        },
      },
    })

    const { servers } = await readServers([join(root, '.mcp.json')])

    expect(servers.map((server) => server.name).sort()).toEqual(['docs', 'linear'])
  })

  test('a file that is not there is not a problem', async () => {
    const { servers, problems } = await readServers(['/nowhere/.mcp.json'])

    expect(servers).toEqual([])
    expect(problems).toEqual([])
  })

  test('says what is wrong with a broken file instead of ignoring it', async () => {
    root = mkdtempSync(join(tmpdir(), 'aidcrew-mcp-'))
    writeFileSync(join(root, '.mcp.json'), '{ not json')

    const { problems } = await readServers([join(root, '.mcp.json')])

    expect(problems[0]).toMatch(/not valid JSON/)
  })

  test('a later file overrides a server of the same name', async () => {
    const root = project({
      'user.json': { mcpServers: { docs: { command: 'old' } } },
      'project.json': { mcpServers: { docs: { command: 'new' } } },
    })

    const { servers } = await readServers([join(root, 'user.json'), join(root, 'project.json')])

    expect(servers).toHaveLength(1)
    expect(servers[0]?.spec).toMatchObject({ command: 'new' })
  })

  test('one server failing never stops the others', async () => {
    const { connected, failed } = await connectAll(
      [
        { name: 'good', spec: { command: 'bun', args: [SERVER] }, from: 'test' },
        { name: 'bad', spec: { command: 'not-a-real-command-xyz' }, from: 'test' },
      ],
      process.cwd(),
      never,
    )
    opened.push(...connected)

    expect(connected.map((client) => client.name)).toEqual(['good'])
    expect(failed[0]).toMatchObject({ name: 'bad' })
  })
})

describe('deciding whether a server may run at all', () => {
  function store(): TrustStore & { seen: Record<string, string> } {
    const seen: Record<string, string> = {}
    return {
      seen,
      get: (key) => seen[key],
      set: (key, value) => {
        seen[key] = value
      },
    }
  }

  const server = { name: 'linear', from: '/repo/.mcp.json', spec: { command: 'npx' } }

  test('refuses when there is nobody to ask', async () => {
    // An unattended run starts nothing it was not already told to. Cloning a
    // repository must not be enough to run the programs it names.
    const allow = createTrust({ workspace: '/repo', store: store() })

    expect(await allow(server)).toBe(false)
  })

  test('asks once, and remembers the answer', async () => {
    const asked: string[] = []
    const held = store()
    const allow = createTrust({
      workspace: '/repo',
      store: held,
      ask: async (question) => {
        asked.push(question.name)
        return 'allow'
      },
    })

    expect(await allow(server)).toBe(true)
    expect(await allow(server)).toBe(true)
    // A question asked every morning is a question answered without reading.
    expect(asked).toEqual(['linear'])
  })

  test('remembers a refusal too, so a no is not asked again tomorrow', async () => {
    let asked = 0
    const held = store()
    const allow = createTrust({
      workspace: '/repo',
      store: held,
      ask: async () => {
        asked += 1
        return 'refuse'
      },
    })

    expect(await allow(server)).toBe(false)
    expect(await allow(server)).toBe(false)
    expect(asked).toBe(1)
  })

  test('a yes in one workspace is not a yes in another', async () => {
    const held = store()
    const here = createTrust({ workspace: '/repo', store: held, ask: async () => 'allow' })
    const elsewhere = createTrust({ workspace: '/other', store: held, ask: async () => 'refuse' })

    expect(await here(server)).toBe(true)
    // The name is the easy part to reuse; the command is the part that matters.
    expect(await elsewhere(server)).toBe(false)
  })

  test('says what the server would actually do, not just its name', () => {
    expect(describeServer({ command: 'npx', args: ['-y', 'linear-mcp'] })).toBe(
      'runs npx -y linear-mcp',
    )
    expect(describeServer({ url: 'https://example.com/mcp' })).toBe(
      'connects to https://example.com/mcp',
    )
  })
})

describe('rendering what a tool answered', () => {
  test('joins text blocks', () => {
    expect(
      renderResult({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb')
  })

  test('names a picture rather than inlining thousands of tokens of base64', () => {
    expect(
      renderResult({ content: [{ type: 'image', data: 'AAAA', mimeType: 'image/png' }] }),
    ).toBe('[image: image/png]')
  })

  test('says plainly that a tool returned nothing', () => {
    // Distinguishable from a failure, which it is not.
    expect(renderResult({ content: [] })).toBe('(the tool returned nothing)')
  })
})
