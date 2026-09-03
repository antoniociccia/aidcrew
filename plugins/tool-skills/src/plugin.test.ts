import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Skill, ToolContext } from '@aidcrew/core'
import { createSkillsPlugin, renderSkillIndex } from './plugin.ts'

let root: string
const context: ToolContext = { cwd: '/', signal: new AbortController().signal, agentId: 'coder' }

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-skills-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function skill(name: string, body: string): Skill {
  const path = join(root, `${name}.md`)
  writeFileSync(path, body)
  return { name, description: `does ${name}`, path }
}

function tool(skills: Skill[]) {
  const found = createSkillsPlugin(skills).tools?.[0]
  if (!found) throw new Error('the plugin declares no tool')
  return found
}

describe('renderSkillIndex', () => {
  test('lists each skill with its description', () => {
    const rendered = renderSkillIndex([skill('deploy', 'body'), skill('review', 'body')])

    expect(rendered).toContain('- deploy: does deploy')
    expect(rendered).toContain('- review: does review')
  })

  test('never includes a skill body, which is the entire point', () => {
    const rendered = renderSkillIndex([skill('big', 'SECRET BODY CONTENT')])

    expect(rendered).not.toContain('SECRET BODY CONTENT')
  })

  test('renders nothing at all when there are no skills', () => {
    expect(renderSkillIndex([])).toBe('')
  })
})

describe('the skill tool', () => {
  test('returns the full body of a skill by name', async () => {
    const output = await tool([skill('deploy', 'Run bun deploy, then check the logs.')]).execute(
      { name: 'deploy' },
      context,
    )

    expect(output.content).toBe('Run bun deploy, then check the logs.')
    expect(output.isError).toBeFalsy()
  })

  test('lists what exists when asked for a skill that does not', async () => {
    const output = await tool([skill('deploy', 'x')]).execute({ name: 'nope' }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/deploy/)
  })

  test('says plainly when no skills are configured', async () => {
    const output = await tool([]).execute({ name: 'anything' }, context)

    expect(output.content).toMatch(/no skills/)
  })

  test('reports a skill whose file disappeared since startup', async () => {
    const one = skill('gone', 'body')
    const configured = tool([one])
    rmSync(one.path)

    const output = await configured.execute({ name: 'gone' }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/could not be read/)
  })

  test('rejects arguments that are not a skill name', async () => {
    expect((await tool([]).execute({ wrong: 1 }, context)).isError).toBe(true)
  })

  test('keeps its description short, since it sits in every request', () => {
    expect(tool([]).description.length).toBeLessThan(200)
  })
})
