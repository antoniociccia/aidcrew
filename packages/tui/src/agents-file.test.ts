import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadWorkspaceConfig, setAgentModel } from '@aidcrew/cli'
import { claudeLoader } from '@aidcrew/loader-claude'
import {
  AGENTS_DIR,
  deleteAgent,
  existingAgents,
  removeAgent,
  TEMPLATES,
  writeAgent,
} from './agents-file.ts'

let repo: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-agents-')))
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

const architect = TEMPLATES[0]
if (!architect) throw new Error('the templates are empty')

describe('writing an agent', () => {
  test('puts it in the project, where git will carry it', async () => {
    const path = await writeAgent(repo, architect)

    expect(path).toBe(join(repo, AGENTS_DIR, 'architect.md'))
    expect(readFileSync(path, 'utf8')).toContain('name: architect')
  })

  test('creates the directory the first time', async () => {
    await writeAgent(repo, architect)

    expect(await existingAgents(repo)).toEqual(['architect'])
  })

  test('writes a file the loader can read back', async () => {
    // The interface writes it, the loader reads it: if these two ever disagree
    // the agent silently disappears, so they are checked against each other.
    await writeAgent(repo, architect)

    const loaded = await claudeLoader.loadAgents(join(repo, AGENTS_DIR))

    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({
      id: 'architect',
      description: architect.description,
      tools: architect.tools,
    })
    expect(loaded[0]?.systemPrompt).toContain('You plan changes')
  })

  test('round-trips an agent with no tool restriction', async () => {
    const coder = TEMPLATES.find((t) => t.id === 'coder')
    if (!coder) throw new Error('no coder template')

    await writeAgent(repo, coder)
    const loaded = await claudeLoader.loadAgents(join(repo, AGENTS_DIR))

    expect(loaded[0]?.tools).toBeUndefined()
  })

  test('overwrites rather than duplicating when edited', async () => {
    await writeAgent(repo, architect)
    await writeAgent(repo, { ...architect, description: 'A different description.' })

    const loaded = await claudeLoader.loadAgents(join(repo, AGENTS_DIR))
    expect(loaded).toHaveLength(1)
    expect(loaded[0]?.description).toBe('A different description.')
  })
})

describe('removing an agent', () => {
  test('deletes the file', async () => {
    await writeAgent(repo, architect)

    await deleteAgent(repo, 'architect')

    expect(await existingAgents(repo)).toEqual([])
  })

  test('says nothing when asked to remove one that is not there', async () => {
    expect(deleteAgent(repo, 'ghost')).resolves.toBeUndefined()
  })

  test('takes it off the team as well, or it comes straight back', async () => {
    // The team is what the config declares, not what is on disk. Deleting the
    // file alone left the entry behind, so the agent reappeared on the next
    // read — which is what "d does nothing" looked like from the outside.
    await writeAgent(repo, architect)
    await setAgentModel(repo, 'architect', { provider: 'zen', model: 'x' })

    await removeAgent(repo, 'architect')

    const config = await loadWorkspaceConfig({ cwd: repo, home: repo })
    expect(config.agents.architect).toBeUndefined()
    expect(await existingAgents(repo)).toEqual([])
  })

  test('takes an agent off the team even when its file lives elsewhere', async () => {
    // An agent from ~/.claude/agents has no file here to delete. Removing it
    // has to mean removing it from the team, or `d` does nothing at all for
    // every agent that did not come from this project.
    await setAgentModel(repo, 'e2e-runner', { provider: 'zen', model: 'x' })

    await removeAgent(repo, 'e2e-runner')

    const config = await loadWorkspaceConfig({ cwd: repo, home: repo })
    expect(config.agents['e2e-runner']).toBeUndefined()
  })
})

describe('listing what a project already has', () => {
  test('is empty for a project that has none', async () => {
    expect(await existingAgents(repo)).toEqual([])
  })

  test('lists every agent written so far', async () => {
    for (const template of TEMPLATES) await writeAgent(repo, template)

    expect((await existingAgents(repo)).sort()).toEqual(TEMPLATES.map((t) => t.id).sort())
  })
})

describe('writing a field that YAML would misread', () => {
  test('a description with a colon in it survives the round trip', async () => {
    // `description: Writes plugins: tools, providers` is not valid YAML — the
    // second colon makes it a mapping inside a mapping — so the frontmatter
    // failed to parse, the agent had no description, and it was skipped
    // entirely. Silently: it was written to disk and never came back.
    await writeAgent(repo, {
      id: 'writer',
      description: 'Writes plugins: tools, providers, hooks.',
      systemPrompt: 'You write plugins.',
      reason: 'x',
    })

    const [loaded] = await claudeLoader.loadAgents(join(repo, AGENTS_DIR))
    expect(loaded?.description).toBe('Writes plugins: tools, providers, hooks.')
  })

  test('a description with a quote in it survives too', async () => {
    await writeAgent(repo, {
      id: 'quoter',
      description: 'Says "no" when it means no.',
      systemPrompt: 'You are careful.',
      reason: 'x',
    })

    const [loaded] = await claudeLoader.loadAgents(join(repo, AGENTS_DIR))
    expect(loaded?.description).toBe('Says "no" when it means no.')
  })
})

describe('the templates offered on first run', () => {
  test('every one loads back correctly', async () => {
    for (const template of TEMPLATES) await writeAgent(repo, template)

    const loaded = await claudeLoader.loadAgents(join(repo, AGENTS_DIR))

    expect(loaded).toHaveLength(TEMPLATES.length)
    for (const agent of loaded) expect(agent.systemPrompt.length).toBeGreaterThan(20)
  })

  test('the reviewing roles cannot write', async () => {
    // A reviewer that can edit fixes what it finds instead of reporting it,
    // and the second opinion you wanted is gone.
    for (const id of ['architect', 'reviewer']) {
      const template = TEMPLATES.find((t) => t.id === id)
      expect(template?.tools).toBeDefined()
      expect(template?.tools).not.toContain('write')
      expect(template?.tools).not.toContain('edit')
    }
  })

  test('every template explains why you would want it', () => {
    for (const template of TEMPLATES) {
      expect(template.reason.length).toBeGreaterThan(10)
    }
  })
})
