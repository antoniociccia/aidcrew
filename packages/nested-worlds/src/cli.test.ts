import { describe, expect, it } from 'bun:test'
import { type CliDeps, main, parseCli } from './cli.ts'
import type { AgentId, DecisionOutput, Scheduler } from './contracts.ts'
import { renderReport } from './eval/escape.ts'
import { openStore } from './store/sqlite.ts'

const db = () => `${process.env.TMPDIR ?? '/tmp'}/nw-cli-${crypto.randomUUID()}.sqlite`

function waiting(): Scheduler {
  let calls = 0
  return {
    async decideAll(inputs) {
      const outputs = new Map<AgentId, DecisionOutput>()
      for (const i of inputs) {
        calls++
        outputs.set(i.agentId, { raw: '{"type":"wait"}', action: { type: 'wait' } })
      }
      return { outputs, exhausted: false }
    },
    usage: () => ({ calls, promptTokens: 0, completionTokens: 0, costUsd: 0 }),
  }
}

describe('parseCli', () => {
  it('should_read_a_run_command_with_defaults', () => {
    const c = parseCli([
      'run',
      '--seed',
      '7',
      '--condition',
      'A',
      '--decider',
      'oracle',
      '--ticks',
      '80',
      '--db',
      'x.sqlite',
    ])
    expect(c).toMatchObject({
      cmd: 'run',
      db: 'x.sqlite',
      config: {
        seed: 7,
        condition: 'A',
        decider: 'oracle',
        ticks: 80,
        agents: 4,
        designedExit: true,
      },
    })
    if (c.cmd === 'run') expect(c.config.ablations).toEqual({ memory: true, nestedSims: false })
  })

  it('should_read_ablation_replay_and_agent_count', () => {
    const c = parseCli([
      'run',
      '--seed',
      '1',
      '--decider',
      'replay',
      '--replay-of',
      'abc',
      '--agents',
      '2',
      '--no-memory',
      '--db',
      'd',
    ])
    expect(c).toMatchObject({
      config: { agents: 2, replayOf: 'abc', ablations: { memory: false } },
    })
  })

  it('should_read_a_report_command', () => {
    expect(parseCli(['report', '--db', 'd', '--run', 'r1'])).toEqual({
      cmd: 'report',
      db: 'd',
      runId: 'r1',
    })
  })

  it('should_refuse_what_it_does_not_understand', () => {
    expect(() => parseCli([])).toThrow()
    expect(() => parseCli(['run', '--seed', 'x', '--db', 'd', '--decider', 'fake'])).toThrow()
    expect(() => parseCli(['run', '--seed', '1', '--db', 'd', '--decider', 'gpt'])).toThrow()
    expect(() =>
      parseCli(['run', '--seed', '1', '--db', 'd', '--decider', 'fake', '--agents', '9']),
    ).toThrow()
    expect(() => parseCli(['run', '--seed', '1', '--db', 'd', '--decider', 'replay'])).toThrow()
    expect(() =>
      parseCli(['run', '--seed', '1', '--db', 'd', '--decider', 'fake', '--bogus', '1']),
    ).toThrow()
  })
})

describe('main', () => {
  it('should_print_the_run_id_then_report_it', async () => {
    const path = db()
    const out: string[] = []
    const deps: CliDeps = {
      scheduler: () => waiting(),
      report: (store, runId) => ({ runId, status: store.run(runId)?.status }),
    }
    await main(
      ['run', '--seed', '3', '--decider', 'fake', '--ticks', '5', '--db', path],
      deps,
      (s) => out.push(s),
    )
    const runId = out[0] as string
    expect(openStore(path).run(runId)?.status).toBe('finished')
    expect(JSON.parse(out[1] as string)).toEqual({ runId, status: 'finished' })
    await main(['report', '--db', path, '--run', runId], deps, (s) => out.push(s))
    expect(JSON.parse(out[2] as string)).toEqual({ runId, status: 'finished' })
  })
  it('should_print_a_text_report_as_it_is', async () => {
    const path = db()
    const out: string[] = []
    const deps: CliDeps = { scheduler: () => waiting(), report: () => 'escaped: false' }
    await main(
      ['run', '--seed', '3', '--decider', 'fake', '--ticks', '2', '--db', path],
      deps,
      (s) => out.push(s),
    )
    expect(out[1]).toBe('escaped: false')
  })
  it('should_wait_for_a_report_that_is_still_being_verified', async () => {
    const path = db()
    const out: string[] = []
    const deps: CliDeps = {
      scheduler: () => waiting(),
      report: async () => 'verified: true',
    }
    await main(
      ['run', '--seed', '3', '--decider', 'fake', '--ticks', '2', '--db', path],
      deps,
      (s) => out.push(s),
    )
    await main(['report', '--db', path, '--run', out[0] as string], deps, (s) => out.push(s))
    expect(out.slice(1)).toEqual(['verified: true', 'verified: true'])
  })
  it('should_mark_the_run_failed_when_its_decider_cannot_be_built', async () => {
    const path = db()
    const out: string[] = []
    const deps: CliDeps = {
      scheduler: () => {
        throw new Error('phase 2')
      },
      report: () => null,
    }
    await expect(
      main(['run', '--seed', '3', '--decider', 'openrouter', '--db', path], deps, (s) =>
        out.push(s),
      ),
    ).rejects.toThrow('phase 2')
    expect(openStore(path).run(out[0] as string)?.status).toBe('failed')
  })
})

describe('watch', () => {
  it('should_read_watch_commands_with_a_port', () => {
    expect(parseCli(['watch', '--db', 'd', '--port', '0'])).toEqual({
      cmd: 'watch',
      db: 'd',
      port: 0,
    })
    expect(parseCli(['watch', '--db', 'd', '--run', 'r1'])).toEqual({
      cmd: 'watch',
      db: 'd',
      runId: 'r1',
      port: 4747,
    })
    const run = parseCli(['run', '--seed', '1', '--decider', 'fake', '--db', 'd', '--watch'])
    expect(run).toMatchObject({ cmd: 'run', watch: { port: 4747 } })
    expect(() => parseCli(['watch', '--db', 'd', '--port', '70000'])).toThrow()
  })

  it('should_serve_an_existing_store_and_print_where', async () => {
    const path = db()
    const deps: CliDeps = { scheduler: () => waiting(), report: () => 'r' }
    const out: string[] = []
    await main(
      ['run', '--seed', '3', '--decider', 'fake', '--ticks', '3', '--db', path],
      deps,
      (s) => out.push(s),
    )
    const viewer = await main(['watch', '--db', path, '--port', '0'], deps, (s) => out.push(s))
    try {
      const url = (out.at(-1) ?? '').replace(/^watch: /, '')
      const runs = (await (await fetch(`${url}api/runs`)).json()) as { runId: string }[]
      expect(runs.map((r) => r.runId)).toEqual([out[0] as string])
    } finally {
      viewer?.stop()
    }
  })

  it('should_print_a_url_that_follows_the_run_it_is_running', async () => {
    const path = db()
    const deps: CliDeps = { scheduler: () => waiting(), report: () => 'escaped: false' }
    const out: string[] = []
    const viewer = await main(
      [
        'run',
        '--seed',
        '3',
        '--decider',
        'fake',
        '--ticks',
        '4',
        '--db',
        path,
        '--watch',
        '--port',
        '0',
      ],
      deps,
      (s) => out.push(s),
    )
    try {
      const runId = out[0] as string
      expect(out[1]).toMatch(new RegExp(`^watch: http://127\\.0\\.0\\.1:\\d+/\\?run=${runId}$`))
      expect(out[2]).toBe('escaped: false')
      const url = new URL((out[1] as string).replace(/^watch: /, ''))
      const frames = (await (
        await fetch(`${url.origin}/api/runs/${runId}/frames`)
      ).json()) as unknown[]
      expect(frames).toHaveLength(4)
    } finally {
      viewer?.stop()
    }
  })
})

describe('aidcrew runs', () => {
  it('should_default_to_opencode_go_and_a_small_budget', () => {
    const cmd = parseCli(['run', '--seed', '7', '--decider', 'aidcrew', '--db', 'd'])
    expect(cmd).toMatchObject({
      cmd: 'run',
      config: {
        decider: 'aidcrew',
        provider: 'opencode-go',
        model: 'muse-spark-1.3-contributor',
        budget: { maxCalls: 400, maxCostUsd: 2, maxConcurrent: 4 },
      },
    })
  })

  it('should_take_a_provider_a_model_and_budget_overrides', () => {
    const cmd = parseCli([
      'run',
      '--seed',
      '7',
      '--decider',
      'aidcrew',
      '--db',
      'd',
      '--provider',
      'anthropic',
      '--model',
      'claude-haiku-5-5',
      '--max-calls',
      '50',
      '--max-cost',
      '0.5',
    ])
    expect(cmd).toMatchObject({
      config: {
        provider: 'anthropic',
        model: 'claude-haiku-5-5',
        budget: { maxCalls: 50, maxCostUsd: 0.5 },
      },
    })
    const fake = parseCli(['run', '--seed', '7', '--decider', 'fake', '--db', 'd'])
    expect(fake).toMatchObject({ config: { budget: { maxCalls: 10_000, maxCostUsd: 5 } } })
    expect(fake.cmd === 'run' ? fake.config.provider : 'not a run').toBeUndefined()
    expect(() =>
      parseCli(['run', '--seed', '7', '--decider', 'fake', '--db', 'd', '--max-cost', '-1']),
    ).toThrow()
  })

  it('should_end_a_run_whose_transport_fails_as_failed_with_the_reason_in_its_report', async () => {
    const path = db()
    const out: string[] = []
    let calls = 0
    const flaky: Scheduler = {
      async decideAll(inputs) {
        calls++
        if (calls > 2) throw new Error('connect ECONNREFUSED 127.0.0.1:443')
        return waiting().decideAll(inputs)
      },
      usage: () => waiting().usage(),
    }
    const deps: CliDeps = { scheduler: () => flaky, report: renderReport }
    await expect(
      main(['run', '--seed', '3', '--decider', 'fake', '--ticks', '10', '--db', path], deps, (s) =>
        out.push(s),
      ),
    ).rejects.toThrow('ECONNREFUSED')
    const runId = out[0] as string
    expect(openStore(path).run(runId)?.status).toBe('failed')
    expect(out[1]).toContain('status: failed')
    expect(out[1]).toContain('failure: connect ECONNREFUSED 127.0.0.1:443')
  })
})
