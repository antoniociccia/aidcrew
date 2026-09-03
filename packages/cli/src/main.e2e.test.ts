import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './main.ts'
import { trustKey } from './run-mcp.ts'
import { openStore } from './store.ts'

/**
 * Drives the whole stack — HTTP, SSE parsing, the accumulator, the loop, the
 * tools, the filesystem — against a fake endpoint that speaks the OpenAI
 * dialect. The model is scripted; everything under it is real.
 */

type Server = ReturnType<typeof Bun.serve>

const usage = { prompt_tokens: 10, completion_tokens: 5 }

function sse(chunks: object[]): string {
  return `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
}

function toolCallTurn(id: string, name: string, args: object): string {
  return sse([
    {
      choices: [
        { index: 0, delta: { tool_calls: [{ index: 0, id, function: { name, arguments: '' } }] } },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage },
  ])
}

function textTurn(text: string): string {
  return sse([
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ])
}

let root: string
let home: string
let server: Server
let requests: { authorization: string | null; body: Record<string, unknown> }[]

function serveScript(script: string[]): string {
  requests = []
  let turn = 0
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push({
        authorization: request.headers.get('authorization'),
        body: (await request.json()) as Record<string, unknown>,
      })
      const body = script[turn] ?? textTurn('(script exhausted)')
      turn += 1
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  return `${server.url.origin}/v1`
}

function io() {
  let out = ''
  let err = ''
  return {
    io: {
      write: (text: string) => {
        out += text
      },
      writeError: (text: string) => {
        err += text
      },
      color: false,
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
  }
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-e2e-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-e2e-home-')))
})

afterEach(() => {
  server?.stop(true)
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

/** The small MCP server the bridge's own tests use. */
const FAKE_SERVER = join(
  import.meta.dir,
  '..',
  '..',
  '..',
  'plugins',
  'mcp-bridge',
  'src',
  'fake-server.ts',
)

function env(baseUrl: string): Record<string, string> {
  return {
    AIDCREW_PROVIDER: 'openai-compat',
    AIDCREW_BASE_URL: baseUrl,
    AIDCREW_API_KEY: 'test-key',
    AIDCREW_MODEL: 'fake-model',
  }
}

describe('aidcrew end to end', () => {
  test('fixes a real bug in a real repository and proves it with the test suite', async () => {
    writeFileSync(join(root, 'math.js'), 'export const add = (a, b) => a - b\n')
    writeFileSync(
      join(root, 'check.sh'),
      '#!/bin/bash\nnode -e "import(\'./math.js\').then(m => process.exit(m.add(2, 2) === 4 ? 0 : 1))"\n',
    )
    chmodSync(join(root, 'check.sh'), 0o755)

    const baseUrl = serveScript([
      toolCallTurn('c1', 'bash', { command: './check.sh' }),
      toolCallTurn('c2', 'read', { path: 'math.js' }),
      toolCallTurn('c3', 'edit', {
        path: 'math.js',
        oldString: '(a, b) => a - b',
        newString: '(a, b) => a + b',
      }),
      toolCallTurn('c4', 'bash', { command: './check.sh' }),
      textTurn('Fixed: add was subtracting. The check now passes.'),
    ])

    const sink = io()
    const code = await main(
      ['-p', 'the check script fails, fix it', '-C', root],
      env(baseUrl),
      sink.io,
      new AbortController().signal,
      { pluginDirs: [], home },
    )

    expect(code).toBe(0)
    expect(readFileSync(join(root, 'math.js'), 'utf8')).toBe('export const add = (a, b) => a + b\n')
    expect(sink.out).toContain('Fixed: add was subtracting')
  })

  test('sends the failing command output back to the model', async () => {
    writeFileSync(join(root, 'check.sh'), '#!/bin/bash\necho "boom" >&2\nexit 1\n')
    chmodSync(join(root, 'check.sh'), 0o755)

    const baseUrl = serveScript([
      toolCallTurn('c1', 'bash', { command: './check.sh' }),
      textTurn('done'),
    ])

    await main(['-p', 'run it', '-C', root], env(baseUrl), io().io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    const followUp = requests[1]?.body.messages as { role: string; content: string }[]
    const toolMessage = followUp.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toMatch(/boom/)
    expect(toolMessage?.content).toMatch(/exit code 1/)
  })

  test('authenticates every request', async () => {
    const baseUrl = serveScript([textTurn('hi')])

    await main(['-p', 'hello', '-C', root], env(baseUrl), io().io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    expect(requests[0]?.authorization).toBe('Bearer test-key')
  })

  test('declares its tools to the model', async () => {
    const baseUrl = serveScript([textTurn('hi')])

    await main(['-p', 'hello', '-C', root], env(baseUrl), io().io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    const tools = requests[0]?.body.tools as { function: { name: string } }[]
    expect(tools.map((t) => t.function.name).sort()).toEqual([
      'awk',
      'bash',
      'deps',
      'edit',
      'git-log',
      'glob',
      'grep',
      'head',
      'imports',
      'json',
      'lsof',
      'outline',
      'read',
      'stat',
      'symbols',
      'toml',
      'tree',
      'wc',
      'write',
    ])
  })

  test('does not run a server a project declares until somebody trusts it', async () => {
    // A .mcp.json arrives with a repository. Cloning one must not be enough
    // to run the programs it names.
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fake: {
            command: 'bun',
            args: [FAKE_SERVER],
          },
        },
      }),
    )
    const baseUrl = serveScript([textTurn('hi')])

    await main(['-p', 'hello', '-C', root], env(baseUrl), io().io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    const tools = (requests[0]?.body.tools ?? []) as { function: { name: string } }[]
    expect(tools.map((tool) => tool.function.name)).not.toContain('mcp__fake__echo')
  })

  test('says on stderr that the server was not started, and why', async () => {
    // The interface showed this beside the transcript and the headless run
    // showed nothing: a CI job whose MCP tools were missing had a model
    // failing to call tools it had never been offered, and no line saying why.
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { fake: { command: 'bun', args: [FAKE_SERVER] } } }),
    )
    const baseUrl = serveScript([textTurn('hi')])
    const sink = io()

    await main(['-p', 'hello', '-C', root], env(baseUrl), sink.io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    expect(sink.err).toContain('MCP server "fake"')
    expect(sink.err).toContain('not trusted')
  })

  test('a trusted server is connected, and its tools reach the model as ours', async () => {
    // The other half of the test above, and the one that proves the bridge
    // works at all rather than that a file was ignored.
    writeFileSync(
      join(root, '.mcp.json'),
      JSON.stringify({ mcpServers: { fake: { command: 'bun', args: [FAKE_SERVER] } } }),
    )

    const store = openStore(home)
    store.set(trustKey(root, 'fake'), 'allow')
    store.close()

    const baseUrl = serveScript([textTurn('hi')])
    await main(['-p', 'hello', '-C', root], env(baseUrl), io().io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    const tools = (requests[0]?.body.tools ?? []) as { function: { name: string } }[]
    expect(tools.map((tool) => tool.function.name)).toContain('mcp__fake__echo')
  })

  test('refuses to touch files outside the workspace it was given', async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-outside-')))
    writeFileSync(join(outside, 'secret.txt'), 'classified')

    const baseUrl = serveScript([
      toolCallTurn('c1', 'read', { path: join(outside, 'secret.txt') }),
      textTurn('I cannot read that.'),
    ])

    await main(['-p', 'read it', '-C', root], env(baseUrl), io().io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    const followUp = requests[1]?.body.messages as { role: string; content: string }[]
    const toolMessage = followUp.find((m) => m.role === 'tool')
    expect(toolMessage?.content).toMatch(/workspace/)
    expect(toolMessage?.content).not.toContain('classified')

    rmSync(outside, { recursive: true, force: true })
  })

  test('stops at the turn limit and says so on stderr', async () => {
    const baseUrl = serveScript([
      toolCallTurn('c1', 'bash', { command: 'true' }),
      toolCallTurn('c2', 'bash', { command: 'true' }),
    ])

    const sink = io()
    const code = await main(
      ['-p', 'loop forever', '-C', root, '--max-turns', '2'],
      env(baseUrl),
      sink.io,
      new AbortController().signal,
      { pluginDirs: [], home },
    )

    expect(code).toBe(1)
    expect(sink.err).toMatch(/2 turns/)
  })

  test('runs from saved settings alone, with nothing in the environment', async () => {
    // The store is opened by main itself here, exactly as it is in production:
    // injecting it would hide the very wiring this checks.
    const store = openStore(home)
    store.setCredential('provider:openai-compat', { apiKey: 'saved-key' })
    store.set('default.provider', 'openai-compat')
    store.set('default.model', 'saved-model')
    store.close()

    const baseUrl = serveScript([textTurn('ran from settings')])
    const sink = io()

    const code = await main(
      ['-p', 'hello', '-C', root],
      { AIDCREW_BASE_URL: baseUrl },
      sink.io,
      new AbortController().signal,
      { pluginDirs: [], home },
    )

    expect(code).toBe(0)
    expect(sink.out).toContain('ran from settings')
    expect(requests[0]?.authorization).toBe('Bearer saved-key')
    expect(requests[0]?.body.model).toBe('saved-model')
  })

  test('says how to save a key when none is configured', async () => {
    const sink = io()
    const code = await main(
      ['-p', 'hello'],
      { AIDCREW_MODEL: 'm', AIDCREW_PROVIDER: 'zen' },
      sink.io,
      new AbortController().signal,
      { pluginDirs: [], home },
    )

    expect(code).toBe(2)
    expect(sink.err).toMatch(/no key for provider "zen"/)
    expect(sink.err).not.toMatch(/stack|at /)
  })
})

const signal = (): AbortSignal => new AbortController().signal

describe('the guards on a run with nobody watching', () => {
  /**
   * These were absent from this path entirely — no protected files, no pause
   * on a command that cannot be taken back, no copy of anything before it
   * changed — while the interface had all three, which made it look
   * deliberate. Found by using the thing rather than by reading it.
   *
   * The model here is scripted to insist. A real one usually refuses these on
   * its own, which is why a live attempt proves nothing about the guard.
   */
  test('refuses to write a file that holds credentials', async () => {
    const baseUrl = serveScript([
      toolCallTurn('c1', 'write', { path: '.env', content: 'SECRET=abc\n' }),
      textTurn('I could not write it.'),
    ])
    const { io: sink } = io()

    await main(['-p', 'write the env file', '-C', root], env(baseUrl), sink, signal(), {
      home,
      pluginDirs: [],
    })

    expect(existsSync(join(root, '.env'))).toBe(false)
    // The refusal reaches the model as a result it can act on, rather than
    // ending the run: an agent told only "no" tries the same thing by another
    // route.
    const answered = requests.at(-1)?.body as { messages?: { content?: unknown }[] }
    expect(JSON.stringify(answered?.messages)).toContain('cannot be written')
  })

  test('refuses a command that cannot be taken back when nobody can be asked', async () => {
    const baseUrl = serveScript([
      toolCallTurn('c1', 'bash', { command: 'rm -rf .' }),
      textTurn('I could not run it.'),
    ])
    const { io: sink } = io()
    writeFileSync(join(root, 'keep.txt'), 'still here')

    await main(['-p', 'clean up', '-C', root], env(baseUrl), sink, signal(), {
      home,
      pluginDirs: [],
    })

    expect(readFileSync(join(root, 'keep.txt'), 'utf8')).toBe('still here')
  })

  test('keeps what a file said before it was changed', async () => {
    writeFileSync(join(root, 'app.ts'), 'before')
    const baseUrl = serveScript([
      toolCallTurn('c1', 'write', { path: 'app.ts', content: 'after' }),
      textTurn('done'),
    ])
    const { io: sink } = io()

    await main(['-p', 'change it', '-C', root], env(baseUrl), sink, signal(), {
      home,
      pluginDirs: [],
    })

    expect(readFileSync(join(root, 'app.ts'), 'utf8')).toBe('after')
    const journal = readFileSync(join(root, '.aidcrew', 'undo', 'changes.jsonl'), 'utf8')
    expect(journal).toContain('app.ts')
  })

  test('names the agent in the journal, even when there is only one', async () => {
    // An empty name made the record read as though nobody had done it.
    writeFileSync(join(root, 'app.ts'), 'before')
    const baseUrl = serveScript([
      toolCallTurn('c1', 'write', { path: 'app.ts', content: 'after' }),
      textTurn('done'),
    ])
    const { io: sink } = io()

    await main(['-p', 'change it', '-C', root], env(baseUrl), sink, signal(), {
      home,
      pluginDirs: [],
    })

    const journal = readFileSync(join(root, '.aidcrew', 'undo', 'changes.jsonl'), 'utf8')
    expect(JSON.parse(journal.trim()).agentId).not.toBe('')
  })
})

/**
 * A plugin whose whole capability is built in `setup` from the settings it was
 * given. Written out rather than imported so the test reads as the file a
 * stranger would put on disk, which is the only shape the contract promises.
 */
const CONFIGURED_PLUGIN = `import { definePlugin, defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
export default definePlugin({
  name: 'ticket',
  setup: (host) => {
    host.say?.('ticket is watching ' + host.config.board)
    return {
      tools: [defineTool({
        name: 'board',
        description: 'Names the board this plugin was configured for.',
        schema: z.object({}),
        run: async () => ({ content: String(host.config.board) }),
      })],
    }
  },
})`

describe('a plugin the project configured, on the run with nobody watching', () => {
  test('is set up with its own settings, and what it says lands on stderr', async () => {
    // The interface handed a plugin its `[plugins.<name>]` table and the
    // headless path did not, so the same plugin ran on its settings at a desk
    // and on its defaults in CI — a difference only ever discovered by the bug
    // it causes. Proving it is fixed means driving `main` itself: a test that
    // builds the host by hand and passes the settings by hand would pass with
    // the wiring taken back out.
    //
    // A bare path is a `user` directory, so nothing here has to be trusted
    // first: the trust question belongs to a plugin that arrived with the
    // repository, and it is asked and answered elsewhere.
    const plugins = join(root, 'plugin-dirs')
    mkdirSync(join(plugins, 'ticket'), { recursive: true })
    writeFileSync(join(plugins, 'ticket', 'index.ts'), CONFIGURED_PLUGIN)

    mkdirSync(join(root, '.aidcrew'), { recursive: true })
    writeFileSync(join(root, '.aidcrew', 'config.toml'), '[plugins.ticket]\nboard = "release-3"\n')

    const baseUrl = serveScript([
      toolCallTurn('c1', 'board', {}),
      textTurn('The board is release-3.'),
    ])
    const sink = io()

    const code = await main(['-p', 'which board?', '-C', root], env(baseUrl), sink.io, signal(), {
      pluginDirs: [plugins],
      home,
    })

    expect(code).toBe(0)
    const answered = requests[1]?.body.messages as { role: string; content: string }[]
    expect(answered.find((message) => message.role === 'tool')?.content).toContain('release-3')
    expect(sink.err).toContain('ticket is watching release-3')
  })
})

describe('a config that came with the clone', () => {
  test('cannot send a file from outside the project to the model', async () => {
    // The whole chain, for real: the config names a file in the user's home,
    // the loader refuses the path, the sources are collected, the system
    // prompt is built and the request goes out. What is asserted is the only
    // thing that finally matters — the secret is not on the wire.
    writeFileSync(join(home, 'secrets.txt'), 'HUNTER2-not-a-real-secret\n')
    mkdirSync(join(root, '.aidcrew'), { recursive: true })
    writeFileSync(
      join(root, '.aidcrew', 'config.toml'),
      '[sources]\ninstructions = ["~/secrets.txt"]\n',
    )
    const baseUrl = serveScript([textTurn('nothing to do')])

    const sink = io()
    const code = await main(
      ['-p', 'say hello', '-C', root],
      env(baseUrl),
      sink.io,
      new AbortController().signal,
      { pluginDirs: [], home },
    )

    expect(code).toBe(0)
    expect(JSON.stringify(requests[0]?.body)).not.toContain('HUNTER2')
    // And it is said out loud, because a thing quietly not done is a thing
    // somebody spends an afternoon on.
    expect(sink.err).toContain('aidcrew project trust sources.instructions=')
  })
})

describe('the demo', () => {
  test('fixes a real bug in a real file with no key at all', async () => {
    // The funnel, and the one path a stranger with a downloaded binary can
    // take. It goes through `main` because what it must prove is that the
    // whole thing works, not that a script replays: real tools, real guards,
    // a file on disk that is wrong before and right after.
    const sink = io()

    const code = await main(['demo'], {}, sink.io, new AbortController().signal, {
      pluginDirs: [],
      home,
    })

    expect(code).toBe(0)
    const where = /aidcrew-demo-[A-Za-z0-9]+/.exec(sink.out)?.[0]
    expect(where).toBeDefined()
    expect(sink.out).toContain('check.sh exits 0')
  }, 30_000)
})
