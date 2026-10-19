// Runs compared side by side, one row per decider. Only like with like: one
// condition, one length, one population, and never an oracle, whose knowledge
// of the hidden rules makes it a check of the lab, not a result.
import type { Condition, RunConfig, RunStore } from '../contracts.ts'
import { checkEscape } from './escape.ts'

export interface DeciderStats {
  runs: number
  escaped: number
  escapeRate: number
  verifiedRate: number
  predictionsMade: number
  predictionsCorrect: number
  meanAliveAtEnd: number
}

export interface Comparison {
  condition: Condition
  ticks: number
  agents: number
  byDecider: Record<string, DeciderStats>
}

function comparable(runIds: string[], store: RunStore): { runId: string; config: RunConfig }[] {
  if (runIds.length === 0) throw new Error('compareRuns needs at least one run')
  const runs = runIds.map((runId) => {
    const run = store.run(runId)
    if (!run) throw new Error(`no run ${runId}`)
    if (run.config.decider === 'oracle') {
      throw new Error(`run ${runId} is an oracle run: a lab check, excluded from comparisons`)
    }
    return { runId, config: run.config }
  })
  const first = (runs[0] as (typeof runs)[number]).config
  for (const { runId, config } of runs) {
    if (config.condition !== first.condition) {
      throw new Error(`run ${runId} is condition ${config.condition}, not ${first.condition}`)
    }
    if (config.ticks !== first.ticks || config.agents !== first.agents) {
      throw new Error(
        `run ${runId} has ${config.ticks} ticks and ${config.agents} agents, not ${first.ticks} and ${first.agents}`,
      )
    }
  }
  return runs
}

export async function compareRuns(store: RunStore, runIds: string[]): Promise<Comparison> {
  const runs = comparable(runIds, store)
  const first = (runs[0] as (typeof runs)[number]).config
  const byDecider: Record<string, DeciderStats> = {}
  for (const { runId, config } of runs) {
    const result = await checkEscape(store, runId)
    const events = store.events(runId)
    const died = new Set(events.filter((e) => e.type === 'agent_died').map((e) => e.agentId))
    const stats = byDecider[config.decider] ?? {
      runs: 0,
      escaped: 0,
      escapeRate: 0,
      verifiedRate: 0,
      predictionsMade: 0,
      predictionsCorrect: 0,
      meanAliveAtEnd: 0,
    }
    byDecider[config.decider] = stats
    // Rates and the mean are kept as running totals here and divided below.
    stats.runs += 1
    stats.escaped += result.escaped ? 1 : 0
    stats.verifiedRate += result.verified ? 1 : 0
    stats.predictionsMade += events.filter((e) => e.type === 'prediction').length
    stats.predictionsCorrect += events.filter(
      (e) => e.type === 'prediction_resolved' && e.payload.correct === true,
    ).length
    stats.meanAliveAtEnd += config.agents - died.size
  }
  for (const stats of Object.values(byDecider)) {
    stats.escapeRate = stats.escaped / stats.runs
    stats.verifiedRate /= stats.runs
    stats.meanAliveAtEnd /= stats.runs
  }
  return { condition: first.condition, ticks: first.ticks, agents: first.agents, byDecider }
}
