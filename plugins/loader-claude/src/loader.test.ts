import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { claudeLoader } from './loader.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-loader-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(relative: string, content: string): string {
  const full = join(root, relative)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, content)
  return full
}

describe('instructions', () => {
  test('reads an instruction file whole', async () => {
    const path = write('CLAUDE.md', '# Rules\n\nAlways use tabs.\n')

    const loaded = await claudeLoader.loadInstructions(path)

    expect(loaded).toEqual([{ source: path, text: '# Rules\n\nAlways use tabs.' }])
  })

  test('treats a missing file as nothing to load, not as an error', async () => {
    expect(await claudeLoader.loadInstructions(join(root, 'absent.md'))).toEqual([])
  })

  test('skips a file that is only whitespace', async () => {
    const path = write('CLAUDE.md', '\n\n   \n')

    expect(await claudeLoader.loadInstructions(path)).toEqual([])
  })
})

describe('skills', () => {
  test('reads name and description from the frontmatter', async () => {
    write(
      'skills/deploy/SKILL.md',
      '---\nname: deploy\ndescription: How to ship this project.\n---\n\nLong body here.\n',
    )

    const skills = await claudeLoader.loadSkills(join(root, 'skills'))

    expect(skills).toEqual([
      {
        name: 'deploy',
        description: 'How to ship this project.',
        path: join(root, 'skills', 'deploy', 'SKILL.md'),
      },
    ])
  })

  test('does not read the body, which is the whole point of loading skills lazily', async () => {
    const body = 'x'.repeat(50_000)
    write('skills/big/SKILL.md', `---\nname: big\ndescription: Huge.\n---\n\n${body}`)

    const skills = await claudeLoader.loadSkills(join(root, 'skills'))

    expect(JSON.stringify(skills).length).toBeLessThan(500)
  })

  test('reads a folded description spanning several lines', async () => {
    write(
      'skills/multi/SKILL.md',
      '---\nname: multi\ndescription: >\n  First line\n  second line.\n---\n\nBody.\n',
    )

    const skills = await claudeLoader.loadSkills(join(root, 'skills'))

    expect(skills[0]?.description).toBe('First line second line.')
  })

  test('falls back to the directory name when the frontmatter has none', async () => {
    write('skills/unnamed/SKILL.md', '---\ndescription: Something.\n---\n\nBody.\n')

    const skills = await claudeLoader.loadSkills(join(root, 'skills'))

    expect(skills[0]?.name).toBe('unnamed')
  })

  test('skips a directory with no SKILL.md', async () => {
    mkdirSync(join(root, 'skills', 'empty'), { recursive: true })
    write('skills/real/SKILL.md', '---\nname: real\ndescription: d\n---\n')

    const skills = await claudeLoader.loadSkills(join(root, 'skills'))

    expect(skills.map((s) => s.name)).toEqual(['real'])
  })

  test('skips a skill with no description, which the model could not choose between', async () => {
    write('skills/nodesc/SKILL.md', '---\nname: nodesc\n---\n\nBody.\n')

    expect(await claudeLoader.loadSkills(join(root, 'skills'))).toEqual([])
  })

  test('returns nothing for a directory that does not exist', async () => {
    expect(await claudeLoader.loadSkills(join(root, 'absent'))).toEqual([])
  })

  test('lists skills in a stable order', async () => {
    for (const name of ['gamma', 'alpha', 'beta']) {
      write(`skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\n`)
    }

    const skills = await claudeLoader.loadSkills(join(root, 'skills'))

    expect(skills.map((s) => s.name)).toEqual(['alpha', 'beta', 'gamma'])
  })
})

describe('agents', () => {
  test('reads an agent, with its body as the system prompt', async () => {
    write(
      'agents/reviewer.md',
      '---\nname: reviewer\ndescription: Reviews code.\nmodel: sonnet\n---\n\nYou review code.\n',
    )

    const agents = await claudeLoader.loadAgents(join(root, 'agents'))

    expect(agents).toEqual([
      {
        id: 'reviewer',
        description: 'Reviews code.',
        systemPrompt: 'You review code.',
        model: 'sonnet',
      },
    ])
  })

  test('reads the role tag, so two files can share one job', async () => {
    write('agents/coder.md', '---\nname: coder\ndescription: Writes code.\n---\n\nYou write.\n')
    write(
      'agents/coder-night.md',
      '---\nname: coder-night\ndescription: Writes code.\nrole: coder\n---\n\nYou write.\n',
    )

    const agents = await claudeLoader.loadAgents(join(root, 'agents'))

    // Only the one that says so: an agent without the tag is its own role,
    // which is what every existing team already is.
    expect(agents.map((agent) => [agent.id, agent.role])).toEqual([
      ['coder-night', 'coder'],
      ['coder', undefined],
    ])
  })

  test('reads the tool allowlist, which is how an agent is kept read-only', async () => {
    write(
      'agents/planner.md',
      '---\nname: planner\ndescription: Plans.\ntools: read, bash\n---\n\nYou plan.\n',
    )

    expect((await claudeLoader.loadAgents(join(root, 'agents')))[0]?.tools).toEqual([
      'read',
      'bash',
    ])
  })

  test('reads a tool list written as a yaml array', async () => {
    write(
      'agents/planner.md',
      '---\nname: planner\ndescription: Plans.\ntools: [read, bash]\n---\n\nYou plan.\n',
    )

    expect((await claudeLoader.loadAgents(join(root, 'agents')))[0]?.tools).toEqual([
      'read',
      'bash',
    ])
  })

  test('leaves provider and model unset when the file does not say', async () => {
    write('agents/plain.md', '---\nname: plain\ndescription: d\n---\n\nBody.\n')

    const agent = (await claudeLoader.loadAgents(join(root, 'agents')))[0]
    expect(agent?.model).toBeUndefined()
    expect(agent?.provider).toBeUndefined()
  })

  test('falls back to the filename when the frontmatter has no name', async () => {
    write('agents/from-filename.md', '---\ndescription: d\n---\n\nBody.\n')

    expect((await claudeLoader.loadAgents(join(root, 'agents')))[0]?.id).toBe('from-filename')
  })

  test('skips a file with no frontmatter at all', async () => {
    write('agents/notes.md', 'Just some notes, not an agent.\n')

    expect(await claudeLoader.loadAgents(join(root, 'agents'))).toEqual([])
  })

  test('ignores files that are not markdown', async () => {
    write('agents/README.txt', 'nope')
    write('agents/real.md', '---\nname: real\ndescription: d\n---\n\nBody.\n')

    expect((await claudeLoader.loadAgents(join(root, 'agents'))).map((a) => a.id)).toEqual(['real'])
  })

  test('returns nothing for a directory that does not exist', async () => {
    expect(await claudeLoader.loadAgents(join(root, 'absent'))).toEqual([])
  })
})

describe('instruction files sitting among the agents', () => {
  test('CLAUDE.md in an agents directory is not loaded as an agent', async () => {
    // It is somebody's instructions in the wrong place. Loading it would put a
    // whole CLAUDE.md into a system prompt as though it described a person.
    write('agents/CLAUDE.md', '# Project instructions\n\nAlways run the tests.\n')
    write('agents/coder.md', '---\nname: coder\ndescription: writes code\n---\n\nYou write code.\n')

    const agents = await claudeLoader.loadAgents?.(join(root, 'agents'))

    expect(agents?.map((agent) => agent.id)).toEqual(['coder'])
  })

  test('the same however it is capitalised', async () => {
    // On a case-insensitive filesystem `claude.md` and `CLAUDE.md` are one
    // file, so an agent named claude would otherwise shadow the instructions
    // every coding agent in that repository reads.
    write('agents/claude.md', 'Always run the tests.\n')

    expect(await claudeLoader.loadAgents?.(join(root, 'agents'))).toEqual([])
  })
})
