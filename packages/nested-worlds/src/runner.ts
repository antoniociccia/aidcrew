// Drives a run tick by tick: observe, decide, validate, step, record. The
// store is the run's memory — a resumed runner rebuilds everything it needs
// from the latest checkpoint and the events before it.
import { ALL_ACTIONS, parseAction } from './actions.ts'
import type {
  Action,
  AgentId,
  DecisionInput,
  DecisionOutput,
  Observation,
  RunConfig,
  RunStatus,
  RunStore,
  Scheduler,
  WorldEvent,
} from './contracts.ts'
import { memoryView } from './memory.ts'
import { createHost, type Host } from './upper/host.ts'
import { generateWorld } from './world/generate.ts'
import { observe } from './world/observe.ts'
import type { ActionResult } from './world/step.ts'

export interface Runner {
  readonly runId: string
  readonly host: Host
  status(): RunStatus
  tick(): Promise<void>
  /** Runs up to `n` ticks, or until the run finishes, is paused or runs out of budget. */
  run(n?: number): Promise<RunStatus>
  pause(): void
  checkpoint(): void
}

export interface RunnerOptions {
  store: RunStore
  config: RunConfig
  scheduler: Scheduler
  runId?: string
}

type Draft = Omit<WorldEvent, 'seq'>

export function createRunner(opts: RunnerOptions): Runner {
  const runId = opts.runId ?? opts.store.createRun(opts.config)
  const host = createHost(generateWorld(opts.config.seed, opts.config.agents))
  return makeRunner(opts.store, runId, opts.config, opts.scheduler, host)
}

export function resumeRunner(store: RunStore, runId: string, scheduler: Scheduler): Runner {
  const run = store.run(runId)
  if (!run) throw new Error(`no run ${runId}`)
  const cp = store.latestCheckpoint(runId)
  const host = cp
    ? createHost(cp.snapshot.base, cp.snapshot.upper)
    : createHost(generateWorld(run.config.seed, run.config.agents))
  const runner = makeRunner(store, runId, run.config, scheduler, host)
  if (run.status === 'paused') runner.setStatus('running')
  return runner
}

function makeRunner(
  store: RunStore,
  runId: string,
  config: RunConfig,
  scheduler: Scheduler,
  host: Host,
): Runner & { setStatus(s: RunStatus): void } {
  let status: RunStatus = store.run(runId)?.status ?? 'running'
  let looping = false
  let pauseRequested = false

  const lastTick = () => host.base.tick - 1
  const save = () => {
    store.saveCheckpoint(runId, host.base.tick, {
      upper: host.upper,
      base: host.base,
      budgetUsage: scheduler.usage(),
    })
  }
  const setStatus = (next: RunStatus, extra: Draft[] = []) => {
    status = next
    store.setStatus(runId, next)
    const events: Draft[] = [
      ...extra,
      { tick: lastTick(), path: '', type: 'run_status', agentId: null, payload: { status: next } },
    ]
    if (next !== 'running') {
      save()
      events.push(checkpointEvent(lastTick(), host.base.tick))
    }
    store.appendEvents(runId, number(events))
  }
  const doPause = () => {
    pauseRequested = false
    if (status === 'running') setStatus('paused')
  }

  async function tick(): Promise<void> {
    if (status !== 'running') throw new Error(`run ${runId} is ${status}`)
    const t = host.base.tick
    const inputs = decisionInputs(store, runId, config, host, t)
    const { outputs, exhausted } = await scheduler.decideAll(inputs)
    const { drafts, actions, overrides } = readDecisions(config, t, inputs, outputs)
    const stepped = host.step(actions)
    for (const input of inputs) {
      const id = input.agentId
      const result = overrides.get(id) ?? stepped.results.get(id) ?? null
      drafts.push({
        tick: t,
        path: '',
        type: 'action',
        agentId: id,
        payload: { action: actions.get(id), result },
      })
    }
    drafts.push(...stepped.events)
    const scheduled = (t + 1) % config.checkpointEvery === 0
    const over = host.base.tick >= config.ticks || host.base.agents.every((a) => !a.alive)
    if (exhausted) {
      drafts.push({
        tick: t,
        path: '',
        type: 'budget_exhausted',
        agentId: null,
        payload: { usage: scheduler.usage() },
      })
    }
    if (scheduled && !exhausted && !over) {
      save()
      drafts.push(checkpointEvent(t, host.base.tick))
    }
    store.appendEvents(runId, number(drafts))
    if (exhausted) setStatus('budget_exhausted')
    else if (over) setStatus('finished')
  }

  return {
    runId,
    host,
    status: () => status,
    tick,
    async run(n = Number.POSITIVE_INFINITY) {
      looping = true
      try {
        for (let i = 0; i < n && status === 'running' && !pauseRequested; i++) await tick()
      } finally {
        looping = false
      }
      if (pauseRequested) doPause()
      return status
    },
    pause() {
      pauseRequested = true
      if (!looping) doPause()
    },
    checkpoint: save,
    setStatus: (s) => setStatus(s),
  }
}

/** Turns what the deciders said into actions; anything the schema refuses becomes a wait. */
function readDecisions(
  config: RunConfig,
  t: number,
  inputs: DecisionInput[],
  outputs: Map<AgentId, DecisionOutput>,
): { drafts: Draft[]; actions: Map<AgentId, Action>; overrides: Map<AgentId, ActionResult> } {
  const drafts: Draft[] = []
  const actions = new Map<AgentId, Action>()
  const overrides = new Map<AgentId, ActionResult>()
  for (const input of inputs) {
    const id = input.agentId
    const out = outputs.get(id)
    if (out) {
      drafts.push({
        tick: t,
        path: '',
        type: 'decision',
        agentId: id,
        payload: {
          decider: config.decider,
          model: config.models?.[id] ?? config.model ?? null,
          rationale: out.rationale ?? null,
          usage: out.usage ?? null,
        },
      })
    }
    const parsed = out ? parseAction(out.action, input.allowedActions) : null
    if (parsed && !parsed.ok) {
      drafts.push({
        tick: t,
        path: '',
        type: 'action_rejected',
        agentId: id,
        payload: { action: null, reason: parsed.error, raw: out?.raw ?? null },
      })
      overrides.set(id, { ok: false, message: `That was not a valid action: ${parsed.error}` })
    }
    actions.set(id, parsed?.ok ? parsed.action : { type: 'wait' })
  }
  return { drafts, actions, overrides }
}

function checkpointEvent(tick: number, savedAt: number): Draft {
  return { tick, path: '', type: 'checkpoint', agentId: null, payload: { savedAt } }
}

/** seq orders events within a tick; a later batch for the same tick continues the count. */
function number(drafts: Draft[]): WorldEvent[] {
  return drafts.map((d, seq) => ({ ...d, seq }))
}

function decisionInputs(
  store: RunStore,
  runId: string,
  config: RunConfig,
  host: Host,
  t: number,
): DecisionInput[] {
  const previous = t > 0 ? store.events(runId, { fromTick: t - 1, toTick: t - 1 }) : []
  const history = config.ablations.memory ? store.events(runId, { toTick: t - 1 }) : []
  return host.base.agents
    .filter((a) => a.alive)
    .map((a) => {
      const heard: Observation['heard'] = previous
        .filter((e) => e.type === 'said' && (e.payload.heardBy as AgentId[]).includes(a.id))
        .map((e) => ({ from: e.agentId as AgentId, text: String(e.payload.text) }))
      const acted = previous.find((e) => e.type === 'action' && e.agentId === a.id)
      const lastResult = (acted?.payload.result as ActionResult | null | undefined) ?? null
      return {
        runId,
        agentId: a.id,
        tick: t,
        path: host.base.path,
        condition: config.condition,
        observation: observe(host.base, a.id, heard, lastResult),
        memory: memoryView(history, a.id, { enabled: config.ablations.memory }),
        allowedActions: ALL_ACTIONS,
      }
    })
}
