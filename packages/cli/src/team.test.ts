import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import type { AgentDef, AgentSnapshot } from '@aidcrew/core'
import { hired, resolveTeam, summarise } from './team.ts'

const agent = (id: string, extra: Partial<AgentDef> = {}): AgentDef => ({
  id,
  description: `the ${id}`,
  systemPrompt: `You are ${id}.`,
  ...extra,
})

describe('resolveTeam', () => {
  test('keeps the agent as defined when nothing overrides it', () => {
    const { team } = resolveTeam([agent('coder', { model: 'from-file' })], {}, {})

    expect(team[0]?.model).toBe('from-file')
  })

  test('lets the project config override the model in the file', () => {
    const { team } = resolveTeam(
      [agent('coder', { model: 'from-file' })],
      {
        coder: { model: 'from-config' },
      },
      {},
    )

    expect(team[0]?.model).toBe('from-config')
  })

  test('falls back to the session default when neither says', () => {
    const { team } = resolveTeam([agent('coder')], {}, { model: 'session-default' })

    expect(team[0]?.model).toBe('session-default')
  })

  test('gives each member its own provider, which is the point of a team', () => {
    const { team } = resolveTeam(
      [agent('architect'), agent('coder'), agent('reviewer')],
      {
        architect: { provider: 'anthropic', model: 'opus' },
        coder: { provider: 'deepseek', model: 'chat' },
        reviewer: { provider: 'zen', model: 'free' },
      },
      {},
    )

    expect(team.map((member) => member.provider)).toEqual(['anthropic', 'deepseek', 'zen'])
  })

  test('keeps the system prompt from the file, never from the config', () => {
    const { team } = resolveTeam([agent('coder')], { coder: { model: 'x' } }, {})

    expect(team[0]?.systemPrompt).toBe('You are coder.')
  })

  test('reports an override for an agent that has no file', () => {
    // Almost always a typo, and ignoring it silently means an agent runs on
    // the wrong model with nobody the wiser.
    const { unknown } = resolveTeam([agent('coder')], { codr: { model: 'x' } }, {})

    expect(unknown).toEqual(['codr'])
  })

  test('overrides the tool allowlist, which is how an agent is kept read-only', () => {
    const { team } = resolveTeam(
      [agent('reviewer', { tools: ['read', 'bash'] })],
      {
        reviewer: { tools: ['read'] },
      },
      {},
    )

    expect(team[0]?.tools).toEqual(['read'])
  })

  test('configuring one agent does not drop the others', () => {
    // Giving the architect a model is not a statement about who else is on
    // the team, and reading it as one makes agents vanish for no reason a
    // person could see.
    const { team } = resolveTeam(
      [agent('architect'), agent('coder'), agent('reviewer')],
      { architect: { model: 'opus' } },
      {},
    )

    expect(team.map((member) => member.id)).toEqual(['architect', 'coder', 'reviewer'])
  })

  test('still puts the configured ones first, in the order declared', () => {
    const { team } = resolveTeam(
      [agent('coder'), agent('architect')],
      { architect: { model: 'a' } },
      {},
    )

    expect(team[0]?.id).toBe('architect')
  })

  test('keeps the order the config declares, which decides who is told first', () => {
    const { team } = resolveTeam(
      [agent('coder'), agent('architect')],
      { architect: { model: 'a' }, coder: { model: 'c' } },
      {},
    )

    expect(team.map((member) => member.id)).toEqual(['architect', 'coder'])
  })

  test('leaves out agents that belong to the user, not to the project', () => {
    // Someone's personal helpers should not turn up on every project's team.
    const { team } = resolveTeam(
      [agent('coder'), agent('a-personal-helper')],
      {},
      {},
      (id) => id === 'coder',
    )

    expect(team.map((member) => member.id)).toEqual(['coder'])
  })

  test('includes a personal agent when the project asks for it by name', () => {
    const { team } = resolveTeam(
      [agent('coder'), agent('a-personal-helper')],
      { 'a-personal-helper': { model: 'm' } },
      {},
      (id) => id === 'coder',
    )

    expect(team.map((member) => member.id).sort()).toEqual(['a-personal-helper', 'coder'])
  })

  test('takes every agent it can find when the config configures none', () => {
    const { team } = resolveTeam([agent('a'), agent('b')], {}, {})

    expect(team.map((member) => member.id)).toEqual(['a', 'b'])
  })

  test('returns an empty team when no agents are defined', () => {
    expect(resolveTeam([], { ghost: { model: 'x' } }, {}).team).toEqual([])
  })
})

describe('summarise', () => {
  const snapshot = (id: string, extra: Partial<AgentSnapshot> = {}): AgentSnapshot => ({
    id,
    status: 'idle',
    model: 'a-model',
    usage: { inputTokens: 100, outputTokens: 50 },
    turns: 2,
    workspace: '/repo',
    isolated: true,
    yolo: false,
    role: 'a',
    task: 'main',
    queued: 0,
    behind: 0,
    activity: [],
    ...extra,
  })

  test('shows model, turns and cost for each agent', () => {
    const text = summarise([snapshot('coder')])

    expect(text).toContain('coder')
    expect(text).toContain('a-model')
    expect(text).toContain('2 turns')
    expect(text).toContain('150 tokens')
  })

  test('warns when an agent had no workspace of its own', () => {
    const text = summarise([snapshot('coder', { isolated: false })])

    expect(text).toContain('shared workspace')
  })

  test('says so plainly when nothing ran', () => {
    expect(summarise([])).toBe('no agents ran')
  })
})

/**
 * Which found agents are actually on the team.
 *
 * Being found and being hired are different: `~/.claude/agents` belongs to
 * another tool and can hold anything, so an agent there joins only when the
 * project names it — someone else's helpers should not turn up on every
 * project's payroll.
 *
 * `~/.aidcrew/agents` is not that. It is this tool's own home directory, and
 * a team written there is a team somebody meant to use again. Treating the two
 * alike is why starting a project meant inventing a crew from nothing with the
 * one you wanted sitting unread on the same disk.
 */
describe('a crew kept in your own home directory', () => {
  const home = '/home/ada'
  const cwd = '/repos/thing'
  const def = (id: string) => ({ id, description: id, systemPrompt: `You are ${id}.` })

  test('joins a project that has said nothing about it', () => {
    const where = new Map([
      ['architect', join(home, '.aidcrew', 'agents')],
      ['coder', join(home, '.aidcrew', 'agents')],
    ])

    const { team } = resolveTeam([def('architect'), def('coder')], {}, {}, (id) =>
      hired(where.get(id), cwd, home),
    )

    expect(team.map((one) => one.id).sort()).toEqual(['architect', 'coder'])
  })

  test("another tool's agents still wait to be named", () => {
    const where = new Map([['e2e-playwright-runner', join(home, '.claude', 'agents')]])

    const { team } = resolveTeam([def('e2e-playwright-runner')], {}, {}, (id) =>
      hired(where.get(id), cwd, home),
    )

    expect(team).toEqual([])
  })

  test("the project's own agents join, as they always did", () => {
    const where = new Map([['reviewer', join(cwd, '.aidcrew', 'agents')]])

    const { team } = resolveTeam([def('reviewer')], {}, {}, (id) => hired(where.get(id), cwd, home))

    expect(team.map((one) => one.id)).toEqual(['reviewer'])
  })
})
