import { describe, expect, it } from 'bun:test'
import { type CliDeps, main, parseCli } from './cli.ts'
import type { AgentId, DecisionOutput, Scheduler } from './contracts.ts'
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
    await main(['report', '--db', path, '--run', runId], deps, (s) => out.push(s))
    expect(JSON.parse(out[1] as string)).toEqual({ runId, status: 'finished' })
  })
})
