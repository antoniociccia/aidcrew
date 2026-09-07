/**
 * The parts of the benchmark that can be tested without spending money.
 *
 * The runner in `run.ts` does the spending: it materialises a task, runs a
 * team on it and grades the result. Everything it decides with — which
 * configurations exist, what a run's JSON verdict says, what it cost, what
 * the table at the end reads — lives here, where a test can reach it.
 */

/** A team shape the benchmark compares: who is on it, on which model, and who leads. */
export type Configuration = {
  name: string
  description: string
  leader: string
  agents: { id: string; model: string }[]
}

/**
 * The configurations compared, on OpenRouter model ids.
 *
 * Solo runs are the baselines a mixed team has to beat: the same cheap model
 * alone, and a strong model alone. The two teams test the hypothesis the
 * product is built on — that a planner and a cheap coder solve as much as
 * the strong model alone, for a fraction of the bill — and the cheap team
 * tests whether the planner has to be strong at all.
 */
export const CONFIGURATIONS: Configuration[] = [
  {
    name: 'cheap-solo',
    description: 'one coder on deepseek-v4-flash',
    leader: 'coder',
    agents: [{ id: 'coder', model: 'deepseek/deepseek-v4-flash' }],
  },
  {
    name: 'strong-solo',
    description: 'one coder on claude-sonnet-5',
    leader: 'coder',
    agents: [{ id: 'coder', model: 'anthropic/claude-sonnet-5' }],
  },
  {
    name: 'cheap-team',
    description: 'architect on glm-5.3-flash, coder on deepseek-v4-flash',
    leader: 'architect',
    agents: [
      { id: 'architect', model: 'z-ai/glm-5.3-flash' },
      { id: 'coder', model: 'deepseek/deepseek-v4-flash' },
    ],
  },
  {
    name: 'strong-team',
    description: 'architect on claude-sonnet-5, coder on deepseek-v4-flash',
    leader: 'architect',
    agents: [
      { id: 'architect', model: 'anthropic/claude-sonnet-5' },
      { id: 'coder', model: 'deepseek/deepseek-v4-flash' },
    ],
  },
]

/** The project config that puts a configuration's team on a task. */
export function configToml(config: Configuration): string {
  const lines = [
    '# Written by the benchmark.',
    '',
    '[defaults]',
    'provider = "openrouter"',
    `model = "${config.agents[0]?.model ?? ''}"`,
    `leader = "${config.leader}"`,
  ]
  for (const agent of config.agents) {
    lines.push('', `[agents.${agent.id}]`, 'provider = "openrouter"', `model = "${agent.model}"`)
  }
  return `${lines.join('\n')}\n`
}

/**
 * OpenRouter's list prices on 2026-09-07, in USD per token, for the models
 * compared. The fallback when a run's usage carries no charged amount; a run
 * that says what it was charged is believed over this.
 */
export const PRICES: Record<string, { input: number; output: number }> = {
  'deepseek/deepseek-v4-flash': { input: 0.089e-6, output: 0.177e-6 },
  'z-ai/glm-5.3-flash': { input: 0.075e-6, output: 0.25e-6 },
  'anthropic/claude-sonnet-5': { input: 2e-6, output: 10e-6 },
}

/** What `aidcrew team --json` prints on its last line, as far as the benchmark reads it. */
export type Verdict = {
  jobs: {
    task: string
    done: boolean
    verified?: string
    merged?: string
    failures: number
    sentBack: number
    left?: string
    warnings?: string[]
  }[]
  agents: {
    id: string
    model: string
    turns: number
    usage: {
      inputTokens: number
      outputTokens: number
      chargedUsd?: number
      listedUsd?: number
    }
  }[]
  exitCode: number
}

/** The verdict on the last non-empty line of a run's output, or nothing when there is none. */
export function parseVerdict(stdout: string): Verdict | undefined {
  const last = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .at(-1)
  if (!last || !last.startsWith('{')) return undefined
  try {
    const parsed = JSON.parse(last) as Partial<Verdict>
    if (!Array.isArray(parsed.jobs) || !Array.isArray(parsed.agents)) return undefined
    return parsed as Verdict
  } catch {
    return undefined
  }
}

export type Cost = { usd: number; source: 'charged' | 'listed' | 'priced' | 'unknown' }

/**
 * What a run cost, in the most trustworthy figure available: what the
 * provider said it charged, else what it listed, else the list price times
 * the tokens. Every request counts, the failed attempts included — the cost
 * of a solved task is the cost of solving it, not of the attempt that worked.
 */
export function costOf(agents: Verdict['agents']): Cost {
  const charged = agents.map((agent) => agent.usage.chargedUsd)
  if (charged.some((usd) => usd !== undefined)) {
    return { usd: charged.reduce<number>((sum, usd) => sum + (usd ?? 0), 0), source: 'charged' }
  }
  const listed = agents.map((agent) => agent.usage.listedUsd)
  if (listed.some((usd) => usd !== undefined)) {
    return { usd: listed.reduce<number>((sum, usd) => sum + (usd ?? 0), 0), source: 'listed' }
  }
  let usd = 0
  let priced = false
  for (const agent of agents) {
    const price = PRICES[agent.model]
    if (!price) continue
    priced = true
    usd += agent.usage.inputTokens * price.input + agent.usage.outputTokens * price.output
  }
  return { usd, source: priced ? 'priced' : 'unknown' }
}

/** One run of one configuration on one task, as it is written to the results file. */
export type RunRecord = {
  task: string
  category: string
  configuration: string
  /** What the harness said: every job checked and merged. */
  done: boolean
  /** What the hidden tests said, on the repository after the run. */
  passed: boolean
  usd: number
  costSource: Cost['source']
  inputTokens: number
  outputTokens: number
  turns: number
  seconds: number
  exitCode: number
  left?: string
  warnings?: string[]
  /** The run never produced a verdict: a crash, a timeout, a missing key. */
  error?: string
}

export type Summary = {
  configuration: string
  tasks: number
  passed: number
  done: number
  /** The harness said done and the hidden tests disagreed: the figure that matters most. */
  saidDoneButFailed: number
  usd: number
  usdPerPass: number | undefined
  meanSeconds: number
}

/** One line per configuration, over every record it has. */
export function summarize(records: RunRecord[]): Summary[] {
  const names = [...new Set(records.map((record) => record.configuration))]
  return names.map((configuration) => {
    const own = records.filter((record) => record.configuration === configuration)
    const passed = own.filter((record) => record.passed).length
    const usd = own.reduce((sum, record) => sum + record.usd, 0)
    return {
      configuration,
      tasks: own.length,
      passed,
      done: own.filter((record) => record.done).length,
      saidDoneButFailed: own.filter((record) => record.done && !record.passed).length,
      usd,
      usdPerPass: passed === 0 ? undefined : usd / passed,
      meanSeconds: own.reduce((sum, record) => sum + record.seconds, 0) / Math.max(own.length, 1),
    }
  })
}

const money = (usd: number): string =>
  usd < 0.1 ? `${(usd * 100).toFixed(1)}c` : `$${usd.toFixed(2)}`

/** The results as a person reads them: a summary per configuration, then every task. */
export function table(records: RunRecord[]): string {
  const lines = [
    '| configuration | passed | said done | said done, failed | total cost | cost per pass | mean time |',
    '|---|---|---|---|---|---|---|',
  ]
  for (const row of summarize(records)) {
    const perPass = row.usdPerPass === undefined ? '-' : money(row.usdPerPass)
    lines.push(
      `| ${row.configuration} | ${row.passed}/${row.tasks} | ${row.done} | ${row.saidDoneButFailed} | ` +
        `${money(row.usd)} | ${perPass} | ${Math.round(row.meanSeconds)}s |`,
    )
  }
  const configurations = [...new Set(records.map((record) => record.configuration))]
  const tasks = [...new Set(records.map((record) => record.task))]
  lines.push(
    '',
    `| task | category | ${configurations.join(' | ')} |`,
    `|---|---|${configurations.map(() => '---').join('|')}|`,
  )
  for (const task of tasks) {
    const cells = configurations.map((configuration) => {
      const record = records.find((one) => one.task === task && one.configuration === configuration)
      if (!record) return '-'
      if (record.error) return `error (${money(record.usd)})`
      const mark = record.passed ? 'pass' : record.done ? 'FAIL, said done' : 'fail'
      return `${mark} ${money(record.usd)} ${Math.round(record.seconds)}s`
    })
    const category = records.find((one) => one.task === task)?.category ?? ''
    lines.push(`| ${task} | ${category} | ${cells.join(' | ')} |`)
  }
  return `${lines.join('\n')}\n`
}

/** The task x configuration pairs still to run, given what a results file already holds. */
export function nextRuns(
  tasks: string[],
  configurations: string[],
  existing: RunRecord[],
): { task: string; configuration: string }[] {
  const seen = new Set(existing.map((record) => `${record.task} ${record.configuration}`))
  return configurations.flatMap((configuration) =>
    tasks
      .filter((task) => !seen.has(`${task} ${configuration}`))
      .map((task) => ({ task, configuration })),
  )
}
