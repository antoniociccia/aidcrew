import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeLoader } from '@aidcrew/loader-claude'
import { collectSources } from './sources.ts'

let home: string
let repo: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-src-home-')))
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-src-repo-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

function agentFile(base: string, id: string): void {
  const directory = join(base, 'agents')
  mkdirSync(directory, { recursive: true })
  writeFileSync(
    join(directory, `${id}.md`),
    `---\nname: ${id}\ndescription: the ${id}\n---\n\nYou are ${id}.\n`,
  )
}

const paths = () => ({
  instructions: [],
  skills: [],
  orchestration: [],
  agents: [join(home, 'agents'), join(repo, 'agents')],
})

describe('collectSources', () => {
  test('finds agents from every configured directory', async () => {
    agentFile(home, 'a-global-helper')
    agentFile(repo, 'coder')

    const loaded = await collectSources([claudeLoader], paths())

    expect(loaded.agents.map((agent) => agent.id).sort()).toEqual(['a-global-helper', 'coder'])
  })

  test('records where each agent came from', async () => {
    // Without this, an agent living in someone's home directory joins every
    // project's team, and the project cannot tell the difference.
    agentFile(home, 'a-global-helper')
    agentFile(repo, 'coder')

    const loaded = await collectSources([claudeLoader], paths())

    expect(loaded.agentSources.get('coder')).toBe(join(repo, 'agents'))
    expect(loaded.agentSources.get('a-global-helper')).toBe(join(home, 'agents'))
  })

  test('records the directory that won when an agent is defined twice', async () => {
    agentFile(home, 'coder')
    agentFile(repo, 'coder')

    const loaded = await collectSources([claudeLoader], paths())

    expect(loaded.agents).toHaveLength(1)
    expect(loaded.agentSources.get('coder')).toBe(join(repo, 'agents'))
  })

  test('reports nothing found for directories that do not exist', async () => {
    const loaded = await collectSources([claudeLoader], paths())

    expect(loaded.agents).toEqual([])
    expect(loaded.failures).toEqual([])
  })
})
