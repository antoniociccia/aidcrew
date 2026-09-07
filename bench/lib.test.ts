import { describe, expect, test } from 'bun:test'
import {
  CONFIGURATIONS,
  configToml,
  costOf,
  nextRuns,
  parseVerdict,
  type RunRecord,
  summarize,
  table,
} from './lib.ts'

const record = (over: Partial<RunRecord>): RunRecord => ({
  task: 'paginate',
  category: 'bugfix',
  configuration: 'cheap-solo',
  done: true,
  passed: true,
  usd: 0.01,
  costSource: 'charged',
  inputTokens: 1000,
  outputTokens: 100,
  turns: 3,
  seconds: 60,
  exitCode: 0,
  ...over,
})

describe('the configurations compared', () => {
  test('put the team on OpenRouter, with the leader named', () => {
    const team = CONFIGURATIONS.find((one) => one.name === 'cheap-team')
    if (!team) throw new Error('no cheap-team configuration')
    const toml = configToml(team)

    expect(toml).toContain('provider = "opencode-go"')
    expect(toml).toContain('leader = "architect"')
    expect(toml).toContain('[agents.architect]')
    expect(toml).toContain('model = "glm-5.3-flash"')
    expect(toml).toContain('[agents.coder]')
  })
})

describe('reading a run', () => {
  test('takes the verdict off the last line, whatever came before', () => {
    const verdict = parseVerdict(
      'coder: wrote src/x.ts\n\nmain: done\n{"jobs":[{"task":"main","done":true,"failures":0,"sentBack":0}],"agents":[],"kept":[],"exitCode":0}\n',
    )

    expect(verdict?.jobs[0]?.done).toBe(true)
    expect(verdict?.exitCode).toBe(0)
  })

  test('has no verdict for a run that crashed before printing one', () => {
    expect(parseVerdict('some agents have no key:\n  coder needs a key\n')).toBeUndefined()
    expect(parseVerdict('')).toBeUndefined()
  })
})

describe('what a run cost', () => {
  test('believes what the provider said it charged, summed over the agents', () => {
    const cost = costOf([
      {
        id: 'a',
        model: 'x',
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1, chargedUsd: 0.02 },
      },
      {
        id: 'b',
        model: 'y',
        turns: 1,
        usage: { inputTokens: 1, outputTokens: 1, chargedUsd: 0.03 },
      },
    ])

    expect(cost).toEqual({ usd: 0.05, source: 'charged' })
  })

  test('falls back to the list price times the tokens', () => {
    const cost = costOf([
      {
        id: 'coder',
        model: 'deepseek-v4-pro',
        turns: 1,
        usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      },
    ])

    expect(cost.source).toBe('priced')
    expect(cost.usd).toBeCloseTo(0.955 + 1.911, 6)
  })

  test('prices cached input at a tenth of fresh input', () => {
    const cost = costOf([
      {
        id: 'coder',
        model: 'deepseek-v4-flash',
        turns: 1,
        usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 },
      },
    ])

    expect(cost.usd).toBeCloseTo(0.0089, 6)
  })

  test('says so when it cannot tell', () => {
    const cost = costOf([
      { id: 'a', model: 'unknown', turns: 1, usage: { inputTokens: 5, outputTokens: 5 } },
    ])

    expect(cost).toEqual({ usd: 0, source: 'unknown' })
  })
})

describe('the summary', () => {
  test('counts passes, what the harness claimed, and the claims the tests refuted', () => {
    const [row] = summarize([
      record({ task: 'a', passed: true, done: true, usd: 0.01 }),
      record({ task: 'b', passed: false, done: true, usd: 0.02 }),
      record({ task: 'c', passed: false, done: false, usd: 0.03 }),
    ])

    expect(row).toMatchObject({ tasks: 3, passed: 1, done: 2, saidDoneButFailed: 1 })
    expect(row?.usd).toBeCloseTo(0.06, 9)
    expect(row?.usdPerPass).toBeCloseTo(0.06, 9)
  })

  test('has no cost per pass when nothing passed', () => {
    const [row] = summarize([record({ passed: false, done: false })])

    expect(row?.usdPerPass).toBeUndefined()
  })
})

describe('the table', () => {
  test('reads per configuration and per task, and marks a refuted claim', () => {
    const text = table([
      record({ task: 'a', configuration: 'cheap-solo', passed: true }),
      record({ task: 'a', configuration: 'strong-solo', passed: false, done: true, usd: 0.5 }),
      record({
        task: 'b',
        configuration: 'cheap-solo',
        error: 'timed out',
        passed: false,
        done: false,
      }),
    ])

    expect(text).toContain('| cheap-solo | 1/2 |')
    expect(text).toContain('| strong-solo | 0/1 | 1 | 1 |')
    expect(text).toContain('FAIL, said done')
    expect(text).toContain('error')
  })
})

describe('picking up a results file', () => {
  test('runs only the pairs not already in it', () => {
    const left = nextRuns(['a', 'b'], ['x', 'y'], [record({ task: 'a', configuration: 'x' })])

    expect(left).toEqual([
      { task: 'b', configuration: 'x', run: 1 },
      { task: 'a', configuration: 'y', run: 1 },
      { task: 'b', configuration: 'y', run: 1 },
    ])
  })

  test('repeats every pair, after one full pass over all of them', () => {
    const left = nextRuns(['a'], ['x', 'y'], [record({ task: 'a', configuration: 'x', run: 1 })], 2)

    expect(left).toEqual([
      { task: 'a', configuration: 'y', run: 1 },
      { task: 'a', configuration: 'x', run: 2 },
      { task: 'a', configuration: 'y', run: 2 },
    ])
  })
})

describe('a table of repeated runs', () => {
  test('says how many of the runs passed, with the means', () => {
    const text = table([
      record({ task: 'a', configuration: 'x', run: 1, passed: true, usd: 0.01, seconds: 10 }),
      record({
        task: 'a',
        configuration: 'x',
        run: 2,
        passed: false,
        done: true,
        usd: 0.03,
        seconds: 30,
      }),
    ])

    expect(text).toContain('| a | bugfix | 1/2, 1 said done 2.0c 20s |')
  })
})
