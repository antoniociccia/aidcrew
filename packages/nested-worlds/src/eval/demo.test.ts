import { describe, expect, it } from 'bun:test'
import { main } from '../cli.ts'
import { cliDeps } from '../wiring.ts'

const db = () => `${process.env.TMPDIR ?? '/tmp'}/nw-demo-${crypto.randomUUID()}.sqlite`

async function run(decider: string) {
  const path = db()
  const out: string[] = []
  await main(
    ['run', '--seed', '7', '--decider', decider, '--ticks', '80', '--db', path],
    cliDeps,
    (s) => out.push(s),
  )
  return { path, out, runId: out[0] as string, report: out[1] as string }
}

describe('demo', () => {
  it('should_escape_with_the_oracle_and_reprint_the_report', async () => {
    const { path, runId, report } = await run('oracle')
    for (const line of [
      'escaped: true',
      'unlocked: true',
      'read_upper: true',
      'wrote_upper: true',
      'predicted_own_write: true',
    ]) {
      expect(report).toContain(line)
    }
    const again: string[] = []
    await main(['report', '--db', path, '--run', runId], cliDeps, (s) => again.push(s))
    const escaped = report.split('\n').find((l) => l.startsWith('escaped:'))
    expect(escaped).toBeDefined()
    expect(again[0]).toContain(escaped as string)
  })

  it('should_not_escape_with_random', async () => {
    const { report } = await run('random')
    expect(report).toContain('escaped: false')
  })

  it('should_not_escape_with_heuristic', async () => {
    const { report } = await run('heuristic')
    expect(report).toContain('escaped: false')
  })
})
