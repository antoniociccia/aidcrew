/**
 * What the benchmark measured, for the wizard to say beside a model.
 *
 * A person picking a first model is choosing between names. These are the
 * teams `bench/` has run on real tasks, with the figure that matters — how
 * many tasks came home, and what a solved one cost — so the choice is made
 * on a number the repository can reproduce rather than on a reputation.
 * Read off `bench/results/`, and updated by hand when a round is published:
 * a binary cannot read the repository it came from.
 */
export type Measured = {
  /** The models on the team, by the short id every gateway shares. */
  models: string[]
  /** Who plans and who writes, or one model alone. */
  shape: string
  /** Tasks solved, of those run. */
  passed: number
  runs: number
  /** What a solved task cost, in cents, at list price. */
  centsPerPass: number
  /** The round, so a reader can find the table. */
  when: string
}

export const MEASURED: Measured[] = [
  {
    models: ['glm-5.3-flash', 'deepseek-v4-flash'],
    shape: 'glm-5.3-flash plans, deepseek-v4-flash writes',
    passed: 85,
    runs: 90,
    centsPerPass: 0.4,
    when: '2026-09-07',
  },
  {
    models: ['deepseek-v4-pro'],
    shape: 'alone',
    passed: 82,
    runs: 90,
    centsPerPass: 3.1,
    when: '2026-09-07',
  },
  {
    models: ['deepseek-v4-flash'],
    shape: 'alone',
    passed: 57,
    runs: 90,
    centsPerPass: 0.3,
    when: '2026-09-07',
  },
]

/** Whether a provider's model id names one of the measured models, whatever prefix it carries. */
export function isMeasured(modelId: string): boolean {
  return MEASURED.some((team) => team.models.some((model) => modelId.endsWith(model)))
}

/**
 * The best measured figure a model id took part in, said in one line — or
 * nothing, for a model the benchmark has not run.
 */
export function measuredHint(modelId: string): string | undefined {
  const teams = MEASURED.filter((team) => team.models.some((model) => modelId.endsWith(model)))
  if (teams.length === 0) return undefined
  const best = teams.reduce((top, team) =>
    team.passed / team.runs > top.passed / top.runs ? team : top,
  )
  const rate = Math.round((100 * best.passed) / best.runs)
  const cents = `${best.centsPerPass.toFixed(1)}¢`
  const how = best.shape === 'alone' ? 'alone' : `in a team (${best.shape})`
  return `measured: ${rate}% of ${best.runs} runs ${how}, ${cents} per solved task`
}
