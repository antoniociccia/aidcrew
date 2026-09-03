import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectTrustKey } from '@aidcrew/cli'
import { removeAgentSettings, setAgentModel, setSourcePaths } from './project-config.ts'
import { openRuntime, readProject } from './runtime.ts'

let repo: string
/** Temporary homes made by the trust tests, cleared afterwards. */
const homes: string[] = []
const home = '/home/somebody'
const configPath = () => join(repo, '.aidcrew', 'config.toml')
type ParsedConfig = {
  sources?: Record<string, string[]>
  defaults?: Record<string, string>
  agents?: Record<string, { provider?: string; model?: string; tools?: string[] }>
}
const parsed = (): ParsedConfig =>
  Bun.TOML.parse(readFileSync(configPath(), 'utf8')) as ParsedConfig

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-cfg-')))
})

afterEach(() => {
  rmSync(repo, { recursive: true, force: true })
  for (const path of homes.splice(0)) rmSync(path, { recursive: true, force: true })
})

function existing(toml: string): void {
  mkdirSync(join(repo, '.aidcrew'), { recursive: true })
  writeFileSync(configPath(), toml)
}

describe('setting an agent model', () => {
  test('creates the file when a project has none', async () => {
    await setAgentModel(repo, 'coder', { provider: 'deepseek', model: 'deepseek-chat' })

    expect(parsed()).toEqual({
      agents: { coder: { provider: 'deepseek', model: 'deepseek-chat' } },
    })
  })

  test('writes valid TOML that reads back identically', async () => {
    await setAgentModel(repo, 'architect', { provider: 'anthropic', model: 'claude-opus-5' })
    await setAgentModel(repo, 'coder', { provider: 'zen', model: 'free' })

    const config = parsed()
    expect(Object.keys(config.agents ?? {}).sort()).toEqual(['architect', 'coder'])
    expect(config.agents?.architect?.model).toBe('claude-opus-5')
  })

  test('updates an agent in place rather than adding it twice', async () => {
    await setAgentModel(repo, 'coder', { provider: 'zen', model: 'first' })
    await setAgentModel(repo, 'coder', { model: 'second' })

    const config = parsed()
    expect(config.agents?.coder).toEqual({ provider: 'zen', model: 'second' })
  })

  test('keeps settings the interface does not manage', async () => {
    // Someone may have written things here by hand; losing them is unforgivable.
    existing('[sources]\nagents = ["./team"]\n\n[defaults]\nprovider = "zen"\n')

    await setAgentModel(repo, 'coder', { model: 'a-model' })

    const config = parsed()
    expect(config.sources?.agents).toEqual(['./team'])
    expect(config.defaults?.provider).toBe('zen')
  })

  test('keeps other agents untouched', async () => {
    existing('[agents.architect]\nmodel = "keep-me"\n')

    await setAgentModel(repo, 'coder', { model: 'new-one' })

    const config = parsed()
    expect(config.agents?.architect?.model).toBe('keep-me')
  })

  test('preserves a tool allowlist while changing the model', async () => {
    existing('[agents.reviewer]\ntools = ["read", "bash"]\n')

    await setAgentModel(repo, 'reviewer', { model: 'a-model' })

    const config = parsed()
    expect(config.agents?.reviewer?.tools).toEqual(['read', 'bash'])
  })

  test('refuses to write over a file it could not read', async () => {
    // This asserted the opposite — that a broken file is started clean — and
    // passed for four months because the TOML parser of the day quietly turned
    // `this is not [ valid toml` into `{this: 'not', valid: {}}` rather than
    // rejecting it, so the broken path was never once taken. A stricter parser
    // took it, and the real behaviour turned out to be the documented one:
    // starting clean here means one unreadable line costs every other agent,
    // every price and every default in the file.
    const broken = '[agents.coder]\nmodel = "m1"\n\n[defaults]\nbroken = \n'
    existing(broken)

    await expect(setAgentModel(repo, 'coder', { model: 'm' })).rejects.toThrow(/not valid TOML/)
    expect(readFileSync(configPath(), 'utf8')).toBe(broken)
  })

  test('says in the file itself that it is safe to edit and commit', async () => {
    await setAgentModel(repo, 'coder', { model: 'm' })

    expect(readFileSync(configPath(), 'utf8')).toMatch(/no secrets/)
  })
})

describe('removing an agent', () => {
  test('drops its settings', async () => {
    await setAgentModel(repo, 'coder', { model: 'm' })

    await removeAgentSettings(repo, 'coder')

    // No agents left means no [agents] section at all, not an empty one.
    expect(parsed()).toEqual({})
  })

  test('leaves the file alone when the agent was not in it', async () => {
    existing('[agents.architect]\nmodel = "keep"\n')

    await removeAgentSettings(repo, 'ghost')

    const config = parsed()
    expect(config.agents?.architect?.model).toBe('keep')
  })
})

describe('what the interface does not know about', () => {
  // Whole sections used to disappear on the next write: the file is parsed and
  // rewritten, and the writer only knew three of its tables. Somebody's stated
  // prices vanished the moment they gave an agent a model.
  const withPrices = `[agents.architect]
model = "opus"

[prices."muse-spark-1.2"]
input = 0.000001
output = 0.000002

[layout]
preset = "columns"
`

  test('survives writing an agent model', async () => {
    existing(withPrices)

    await setAgentModel(repo, 'plugin-writer', { provider: 'zen', model: 'x' })

    const config = parsed() as ParsedConfig & {
      prices?: Record<string, { input: number; output: number }>
      layout?: { preset?: string }
    }
    expect(config.prices?.['muse-spark-1.2']).toEqual({ input: 0.000001, output: 0.000002 })
    expect(config.layout?.preset).toBe('columns')
    expect(config.agents?.['plugin-writer']?.model).toBe('x')
    expect(config.agents?.architect?.model).toBe('opus')
  })

  test('survives removing an agent', async () => {
    existing(withPrices)

    await removeAgentSettings(repo, 'architect')

    const config = parsed() as ParsedConfig & { prices?: Record<string, unknown> }
    expect(config.prices?.['muse-spark-1.2']).toBeDefined()
  })
})

describe('the paths written into a committed file', () => {
  // This file is committed and shared. Somebody's home directory written into
  // it is a path that exists on exactly one machine, and it turns up in the
  // diff of a repository other people read.
  test('are relative to the project and to the home directory', async () => {
    await setSourcePaths(
      repo,
      'agents',
      [join(repo, '.claude', 'agents'), join(home, '.claude', 'agents')],
      home,
    )

    expect(parsed().sources?.agents).toEqual(['./.claude/agents', '~/.claude/agents'])
  })

  test('are left alone when they are somewhere else entirely', async () => {
    await setSourcePaths(repo, 'skills', ['/opt/team/skills'], home)

    expect(parsed().sources?.skills).toEqual(['/opt/team/skills'])
  })
})

/**
 * A claim the person has allowed, in the place the answer is used.
 *
 * `.aidcrew/config.toml` arrives with a clone, so the things in it that let an
 * agent act unasked wait to be allowed — and `aidcrew project trust` is how
 * they are. The interface read that file without asking whether anything had
 * been trusted, so the answer was always no: the command said "trusted", the
 * command that lists them said "trusted", and the team was built as though
 * nobody had ever agreed to anything.
 */
describe('a project claim that has been trusted', () => {
  const declared = `[agents.coder]\nyolo = true\nprovider = "none"\n`

  /** An agent of the project's own, since the config only says what one runs on. */
  const agentFile = (): void => {
    mkdirSync(join(repo, '.aidcrew', 'agents'), { recursive: true })
    writeFileSync(
      join(repo, '.aidcrew', 'agents', 'coder.md'),
      '---\nname: coder\ndescription: writes code\n---\nYou write code.\n',
    )
  }

  /** A home of its own, so the project's file is read as the project's. */
  const elsewhere = (): string => {
    const path = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-home-')))
    homes.push(path)
    return path
  }

  test('is refused until somebody allows it', async () => {
    existing(declared)
    agentFile()
    const home = elsewhere()
    const runtime = await openRuntime(repo, home)
    try {
      const project = await readProject(runtime, repo, home, {})

      expect(project.config.refused.map((one) => one.claim)).toEqual(['agents.coder.yolo'])
      expect(project.agents.find((agent) => agent.id === 'coder')?.yolo).toBeFalsy()
    } finally {
      runtime.close()
    }
  })

  test('takes effect once it is', async () => {
    existing(declared)
    agentFile()
    const home = elsewhere()
    const runtime = await openRuntime(repo, home)
    try {
      runtime.store.set(projectTrustKey(repo, 'agents.coder.yolo'), 'allow')
      const project = await readProject(runtime, repo, home, {})

      expect(project.config.refused).toEqual([])
      expect(project.agents.find((agent) => agent.id === 'coder')?.yolo).toBe(true)
    } finally {
      runtime.close()
    }
  })
})
