import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './main.ts'

/**
 * Phase 4's promise: point aidcrew at a repository that already has a Claude
 * Code setup and it works, with no import step and nothing copied.
 */

const sse = (chunks: object[]) =>
  `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`

const textTurn = (text: string) =>
  sse([
    { choices: [{ index: 0, delta: { content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])

const toolTurn = (name: string, args: unknown) =>
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
let requests: Record<string, unknown>[]

function serve(script: string[]): string {
  requests = []
  let turn = 0
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as Record<string, unknown>)
      const body = script[turn] ?? textTurn('done')
      turn += 1
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
    },
  })
  return `${server.url.origin}/v1`
}

async function run(baseUrl: string): Promise<string> {
  let out = ''
  await main(
    ['-p', 'do the thing', '-C', repo],
    {
      AIDCREW_PROVIDER: 'openai-compat',
      AIDCREW_BASE_URL: baseUrl,
      AIDCREW_API_KEY: 'k',
      AIDCREW_MODEL: 'm',
    },
    {
      write: (text) => {
        out += text
      },
      writeError: () => {},
      color: false,
    },
    new AbortController().signal,
    { pluginDirs: [], home },
  )
  return out
}

function systemOf(index: number): string {
  const messages = (requests[index]?.messages ?? []) as { role: string; content: string }[]
  return messages[0]?.content ?? ''
}

const toolsOf = (index: number) =>
  ((requests[index]?.tools ?? []) as { function: { name: string } }[]).map((t) => t.function.name)

function write(base: string, relative: string, content: string): void {
  const full = join(base, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
}

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-sources-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-sources-home-')))
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(repo, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('an existing Claude Code setup, used as it is', () => {
  test('puts CLAUDE.md into the system prompt with no configuration at all', async () => {
    write(repo, 'CLAUDE.md', '# House rules\n\nNever use semicolons.\n')

    await run(serve([textTurn('understood')]))

    expect(systemOf(0)).toContain('Never use semicolons.')
  })

  test('reads the user-level CLAUDE.md as well as the project one', async () => {
    write(home, '.claude/CLAUDE.md', 'Always answer in Italian.')
    write(repo, 'CLAUDE.md', 'This project uses tabs.')

    await run(serve([textTurn('ok')]))

    expect(systemOf(0)).toContain('Always answer in Italian.')
    expect(systemOf(0)).toContain('This project uses tabs.')
  })

  test('offers skills by name and description, never by body', async () => {
    write(
      repo,
      '.claude/skills/deploy/SKILL.md',
      '---\nname: deploy\ndescription: How to ship this project.\n---\n\nSTEP ONE: never inline me.\n',
    )

    await run(serve([textTurn('ok')]))

    expect(systemOf(0)).toContain('deploy: How to ship this project.')
    expect(systemOf(0)).not.toContain('STEP ONE')
  })

  test('gives the model a tool to fetch the skill it chose', async () => {
    write(
      repo,
      '.claude/skills/deploy/SKILL.md',
      '---\nname: deploy\ndescription: How to ship.\n---\n\nRun bun deploy.\n',
    )

    await run(serve([toolTurn('skill', { name: 'deploy' }), textTurn('read it')]))

    expect(toolsOf(0)).toContain('skill')
    const messages = (requests[1]?.messages ?? []) as { role: string; content: string }[]
    expect(messages.at(-1)?.content).toContain('Run bun deploy.')
  })

  test('does not offer a skill tool when the project has no skills', async () => {
    // A tool the model can never usefully call still costs tokens every turn.
    await run(serve([textTurn('ok')]))

    expect(toolsOf(0)).not.toContain('skill')
  })

  test('honours a config that points somewhere else entirely', async () => {
    write(repo, '.aidcrew/config.toml', '[sources]\ninstructions = ["./docs/RULES.md"]\n')
    write(repo, 'docs/RULES.md', 'The rule from the unusual place.')
    write(repo, 'CLAUDE.md', 'This one should be ignored.')

    await run(serve([textTurn('ok')]))

    expect(systemOf(0)).toContain('The rule from the unusual place.')
    expect(systemOf(0)).not.toContain('This one should be ignored.')
  })

  test('reads nothing and still runs in a bare directory', async () => {
    const out = await run(serve([textTurn('nothing to read here')]))

    expect(out).toContain('nothing to read here')
  })

  test('leaves the project files untouched: they are read, never imported', async () => {
    write(repo, 'CLAUDE.md', 'original content')
    write(repo, '.claude/skills/x/SKILL.md', '---\nname: x\ndescription: d\n---\nbody')

    await run(serve([textTurn('ok')]))

    expect(Bun.file(join(repo, 'CLAUDE.md')).text()).resolves.toBe('original content')
    // No .aidcrew directory should have appeared to hold copies.
    expect(await Bun.file(join(repo, '.aidcrew', 'skills', 'x', 'SKILL.md')).exists()).toBe(false)
  })
})
