import { afterEach, describe, expect, it } from 'bun:test'
import { DEFAULT_BUDGET } from '../cli.ts'
import type { RunConfig, RunStore } from '../contracts.ts'
import { FakeDecider } from '../llm/fake.ts'
import { createScheduler } from '../llm/scheduler.ts'
import { createRunner, type Runner } from '../runner.ts'
import { openStore } from '../store/sqlite.ts'
import { startViewer, type Viewer } from './server.ts'

const XSS = '<img src=x onerror=alert(1)>'

const config: RunConfig = {
  seed: 7,
  condition: 'A',
  ticks: 6,
  agents: 2,
  decider: 'fake',
  ablations: { memory: true, nestedSims: false },
  budget: DEFAULT_BUDGET,
  checkpointEvery: 10,
  designedExit: true,
}

function talkingRun(store: RunStore): Runner {
  const decider = new FakeDecider(() => ({ type: 'say', text: XSS }))
  return createRunner({ store, config, scheduler: createScheduler(decider, config.budget) })
}

let viewer: Viewer | null = null
afterEach(() => {
  viewer?.stop()
  viewer = null
})

function serve(store: RunStore): Viewer {
  viewer = startViewer({ store, port: 0, pollMs: 20 })
  return viewer
}

describe('viewer server', () => {
  it('should_bind_to_loopback_and_list_the_runs', async () => {
    const store = openStore(':memory:')
    const runner = talkingRun(store)
    await runner.run()
    const { url } = serve(store)
    expect(new URL(url).hostname).toBe('127.0.0.1')
    const runs = (await (await fetch(`${url}api/runs`)).json()) as { runId: string }[]
    expect(runs.map((r) => r.runId)).toEqual([runner.runId])
  })

  it('should_describe_a_run_with_its_world_and_report', async () => {
    const store = openStore(':memory:')
    const runner = talkingRun(store)
    await runner.run()
    const { url } = serve(store)
    const run = (await (await fetch(`${url}api/runs/${runner.runId}`)).json()) as {
      config: RunConfig
      report: { escaped: boolean }
      world: { width: number; height: number; terrain: string[] }
      observer: { fertile: unknown[] }
    }
    expect(run.config.seed).toBe(7)
    expect(run.report.escaped).toBe(false)
    expect(run.world.terrain).toHaveLength(run.world.width * run.world.height)
    expect(run.observer.fertile).toHaveLength(3)
  })

  it('should_serve_a_range_of_frames_with_agent_text_untouched', async () => {
    const store = openStore(':memory:')
    const runner = talkingRun(store)
    await runner.run()
    const { url } = serve(store)
    const res = await fetch(`${url}api/runs/${runner.runId}/frames?from=2&to=4`)
    const frames = (await res.json()) as {
      tick: number
      events: { type: string; payload: { text?: string } }[]
    }[]
    expect(frames.map((f) => f.tick)).toEqual([2, 3, 4])
    const said = frames[0]?.events.find((e) => e.type === 'said')
    expect(said?.payload.text).toBe(XSS)
  })

  it('should_refuse_a_bad_id_or_range_and_not_find_an_unknown_run', async () => {
    const { url } = serve(openStore(':memory:'))
    expect((await fetch(`${url}api/runs/not%20an%20id!`)).status).toBe(400)
    expect((await fetch(`${url}api/runs/${'a'.repeat(65)}`)).status).toBe(400)
    expect((await fetch(`${url}api/runs/abc/frames?from=-1`)).status).toBe(400)
    expect((await fetch(`${url}api/runs/abc/frames?from=x`)).status).toBe(400)
    expect((await fetch(`${url}api/runs/abc`)).status).toBe(404)
    expect((await fetch(`${url}nope`)).status).toBe(404)
  })

  it('should_send_a_strict_content_security_policy_on_the_page_and_the_api', async () => {
    const { url } = serve(openStore(':memory:'))
    for (const path of ['', 'page.js', 'api/runs']) {
      const res = await fetch(`${url}${path}`)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('should_stream_a_frame_written_after_the_page_connected', async () => {
    const store = openStore(':memory:')
    const runner = talkingRun(store)
    const { url } = serve(store)
    const res = await fetch(`${url}api/runs/${runner.runId}/stream`)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const reader = (res.body as ReadableStream<Uint8Array>).getReader()
    await runner.tick()
    let text = ''
    while (!text.includes('event: frame')) {
      const { value, done } = await reader.read()
      if (done) break
      text += new TextDecoder().decode(value)
    }
    await reader.cancel()
    const data = text.split('\n').find((l) => l.startsWith('data: {"tick"'))
    expect(JSON.parse((data ?? '').slice('data: '.length)).tick).toBe(0)
  })
})
