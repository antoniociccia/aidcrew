import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './main.ts'

/**
 * Phase 5's promise, end to end: three agents, three models, three isolated
 * worktrees, talking to each other, in a real git repository.
 */

const sse = (chunks: object[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`

const say = (text: string) =>
  sse([
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])

const useTool = (name: string, args: unknown) =>
  sse([
    {
      choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name } }] } }],
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
  ])

let repo: string
let home: string
let server: ReturnType<typeof Bun.serve> | undefined

async function git(args: string[]): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd: repo,
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  await proc.exited
}

function write(relative: string, content: string): void {
  const full = join(repo, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

/** A server that answers differently depending on which model was asked for. */
function serveByModel(scripts: Record<string, string[]>): string {
  const turns: Record<string, number> = {}
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string }
      const index = turns[body.model] ?? 0
      turns[body.model] = index + 1
      const script = scripts[body.model] ?? []
      return new Response(script[index] ?? say('nothing more to do'), {
        headers: { 'Content-Type': 'text/event-stream' },
      })
    },
  })
  return `${server.url.origin}/v1`
}

async function runTeam(baseUrl: string, extraArgs: string[] = []) {
  let out = ''
  let err = ''
  const code = await main(
    ['team', '-p', 'ship the feature', '-C', repo, ...extraArgs],
    {
      AIDCREW_PROVIDER: 'openai-compat',
      AIDCREW_BASE_URL: baseUrl,
      AIDCREW_API_KEY: 'k',
      AIDCREW_MODEL: 'fallback-model',
    },
    {
      write: (text) => {
        out += text
      },
      writeError: (text) => {
        err += text
      },
      color: false,
    },
    new AbortController().signal,
    { pluginDirs: [], home },
  )
  return { code, out, err }
}

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-team-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-team-home-')))

  write('app.ts', 'export const version = 1\n')
  await git(['init', '-q', '-b', 'main'])
  await git(['add', '.'])
  await git(['commit', '-qm', 'initial'])

  for (const [id, role] of [
    ['architect', 'You design.'],
    ['coder', 'You write code.'],
    ['reviewer', 'You review.'],
  ] as const) {
    write(`.claude/agents/${id}.md`, `---\nname: ${id}\ndescription: the ${id}\n---\n\n${role}\n`)
  }

  write(
    '.aidcrew/config.toml',
    `[agents.architect]
model = "planner-model"

[agents.coder]
model = "coder-model"

[agents.reviewer]
model = "reviewer-model"
tools = ["read"]
`,
  )
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('a team of three, on three models', () => {
  test('spawns every agent on the model its config names', async () => {
    const { out, code } = await runTeam(serveByModel({}))

    expect(code).toBe(0)
    expect(out).toContain('planner-model')
    expect(out).toContain('coder-model')
    expect(out).toContain('reviewer-model')
  })

  test('sends the instruction to the first agent, and its work stays in its own worktree', async () => {
    const baseUrl = serveByModel({
      'planner-model': [
        useTool('write', { path: 'plan.md', content: '# the plan' }),
        say('planned'),
      ],
    })

    const { out } = await runTeam(baseUrl)

    // The file exists in the architect's worktree, not in the repository.
    expect(out).toContain('architect: plan.md')
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const version = 1\n')
    expect(await Bun.file(join(repo, 'plan.md')).exists()).toBe(false)
  })

  test('two agents on one task see the same files', async () => {
    const baseUrl = serveByModel({
      'planner-model': [
        useTool('write', { path: 'app.ts', content: 'architect version\n' }),
        useTool('agent_send', { to: 'coder', message: 'your turn' }),
        say('handed over'),
      ],
      // Reads the very file the architect just wrote. If they were in
      // separate checkouts this would fail, which is exactly what used to
      // happen: the coder wrote four files and the reviewer found nothing.
      'coder-model': [useTool('read', { path: 'app.ts' }), say('I can see it')],
    })

    const { out } = await runTeam(baseUrl)

    // A team on one job works in one directory, the way people do: a branch
    // each, not a clone each.
    expect(out).toContain('coder · read(app.ts)')
    expect(out).toContain('I can see it')
    expect(out).not.toContain('no such file')
    // And the project itself is still untouched.
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const version = 1\n')
  })

  test('shows one agent handing work to another', async () => {
    const baseUrl = serveByModel({
      'planner-model': [
        useTool('agent_send', { to: 'reviewer', message: 'please check app.ts' }),
        say('asked the reviewer'),
      ],
      'reviewer-model': [say('looks fine to me')],
    })

    const { out } = await runTeam(baseUrl)

    expect(out).toContain('architect → reviewer')
    expect(out).toContain('looks fine to me')
  })

  test('honours a per-agent tool allowlist', async () => {
    // The reviewer is configured read-only; asking it to write must fail.
    const baseUrl = serveByModel({
      'planner-model': [
        useTool('agent_send', { to: 'reviewer', message: 'write something' }),
        say('asked'),
      ],
      'reviewer-model': [useTool('write', { path: 'sneaky.txt', content: 'x' }), say('could not')],
    })

    const { out } = await runTeam(baseUrl)

    expect(out).toContain('unknown tool: write')
  })

  test('sends the instruction to the agent named with --to', async () => {
    const baseUrl = serveByModel({ 'coder-model': [say('coder got it')] })

    const { out } = await runTeam(baseUrl, ['--to', 'coder'])

    expect(out).toContain('coder got it')
  })

  test('reports an unknown recipient instead of picking someone else', async () => {
    const { code, err } = await runTeam(serveByModel({}), ['--to', 'nobody'])

    expect(code).toBe(2)
    expect(err).toMatch(/nobody/)
  })

  test('warns about a config entry with no agent file behind it', async () => {
    write('.aidcrew/config.toml', '[agents.typo]\nmodel = "x"\n')

    const { err } = await runTeam(serveByModel({}))

    expect(err).toMatch(/typo/)
  })

  test('says plainly when nothing changed', async () => {
    const { out } = await runTeam(serveByModel({}))

    expect(out).toContain('no agent changed any files')
  })

  test('reports turns and tokens for each agent at the end', async () => {
    const baseUrl = serveByModel({ 'planner-model': [say('done')] })

    const { out } = await runTeam(baseUrl)

    expect(out).toMatch(/architect\s+planner-model\s+1 turns/)
  })
})

describe('a project with no agents', () => {
  test('explains where it looked instead of failing silently', async () => {
    rmSync(join(repo, '.claude'), { recursive: true, force: true })

    const { code, err } = await runTeam(serveByModel({}))

    expect(code).toBe(2)
    expect(err).toMatch(/no agents found/)
    expect(err).toMatch(/\.claude\/agents/)
  })
})

describe('a team that stopped without finishing', () => {
  /** A turn cut off partway through a tool call, which is what the cap does. */
  const cutShort = (name: string) =>
    sse([
      {
        choices: [
          { index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name } }] } },
        ],
      },
      { choices: [{ index: 0, delta: {}, finish_reason: 'length' }] },
    ])

  test('does not report success, because a zero gets merged', async () => {
    // Worse than hanging. A run that hangs trips the CI timeout and somebody
    // looks at it; a run that exits 0 having done half the work is a green
    // tick on a branch nobody reads again. `host.idle()` returns the instant
    // nobody is busy, which on a stall is immediately — so this printed the
    // summary, printed the diffs, and said everything was fine.
    const baseUrl = serveByModel({
      'planner-model': [
        useTool('agent_send', { to: 'coder', message: 'write the first tool' }),
        say('handed it over'),
      ],
      'coder-model': [cutShort('write')],
    })

    const { code, err } = await runTeam(baseUrl)

    expect(code).not.toBe(0)
    expect(err).toContain('architect')
    expect(err).toContain('coder')
  }, 30_000)

  test('says nothing when the team simply finished', async () => {
    const baseUrl = serveByModel({
      'planner-model': [
        useTool('agent_send', { to: 'coder', message: 'write the first tool' }),
        say('handed it over'),
        // The third turn is the coder's answer coming back. Work handed over
        // now returns to whoever was given the job, so the agent that started
        // the chain takes one more turn — which is the turn it needs to do
        // the last thing, and the reason this exists.
        say('good, we are done'),
      ],
      'coder-model': [say('written')],
    })

    const { code, err } = await runTeam(baseUrl)

    expect(code).toBe(0)
    expect(err).not.toContain('no answer')
  }, 30_000)
})
