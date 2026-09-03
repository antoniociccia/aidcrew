import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeAgentSettings, setAgentModel, setSharedMemory } from './agent-config.ts'
import { loadWorkspaceConfig } from './workspace.ts'

let repo: string
const configPath = () => join(repo, '.aidcrew', 'config.toml')

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-agent-config-')))
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

function existing(toml: string): void {
  mkdirSync(join(repo, '.aidcrew'), { recursive: true })
  writeFileSync(configPath(), toml)
}

describe('an agent whose id is not a bare word', () => {
  test('is written so the file still parses', async () => {
    // An agent file may say `name: Code Reviewer`, and that is its id. Written
    // as `[agents.Code Reviewer]` the file stopped being TOML, and the next
    // start failed on a line the person never typed.
    await setAgentModel(repo, 'Code Reviewer', { model: 'm2' })

    const loaded = await loadWorkspaceConfig({ cwd: repo, home: join(repo, 'no-home') })
    expect(loaded.agents['Code Reviewer']?.model).toBe('m2')
  })
})

describe('a file that cannot be read', () => {
  const broken =
    '[agents.coder]\nmodel = "m1"\n\n[prices."gpt-4.1"]\ninput = 1e-6\noutput = 2e-6\n\n' +
    '[defaults]\nbroken = \n'

  test('is not written over', async () => {
    // "Start clean" on a parse error meant one bad line cost the whole file:
    // choosing a model while `broken = ` sat in [defaults] replaced every
    // other agent, every price and every default with the one table just
    // written, and said nothing. A writer must never write over a file it
    // could not read.
    existing(broken)

    await expect(setAgentModel(repo, 'reviewer', { model: 'm2' })).rejects.toThrow(/not valid TOML/)
    await expect(setSharedMemory(repo, true)).rejects.toThrow(/not valid TOML/)
    await expect(removeAgentSettings(repo, 'coder')).rejects.toThrow(/not valid TOML/)

    expect(readFileSync(configPath(), 'utf8')).toBe(broken)
  })

  test('says which file, so the person can go and fix the line', async () => {
    existing(broken)

    await expect(setAgentModel(repo, 'reviewer', { model: 'm2' })).rejects.toThrow(configPath())
  })

  test('is not the same as a file that is not there, which is where everybody starts', async () => {
    await setAgentModel(repo, 'coder', { model: 'm1' })

    const loaded = await loadWorkspaceConfig({ cwd: repo, home: join(repo, 'no-home') })
    expect(loaded.agents.coder?.model).toBe('m1')
  })
})
