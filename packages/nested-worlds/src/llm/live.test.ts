import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from '../cli.ts'
import { makeCliDeps } from '../wiring.ts'
import { providerFromAidcrew } from './live.ts'

const SECRET = 'sk-test-nested-worlds-SECRET'

const emptyHome = () => mkdtempSync(join(tmpdir(), 'nw-home-'))

// An OpenAI-compatible endpoint on loopback that always answers "wait".
function fakeEndpoint() {
  const seen: { auth: string | null; path: string }[] = []
  const answer = JSON.stringify({ action: { type: 'wait' }, rationale: 'listening to the wind' })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(req) {
      seen.push({ auth: req.headers.get('authorization'), path: new URL(req.url).pathname })
      const chunks = [
        { choices: [{ index: 0, delta: { role: 'assistant', content: answer } }] },
        { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } },
      ]
      const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}/v1`, seen, stop: () => server.stop(true) }
}

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})

describe('providerFromAidcrew', () => {
  it('should_refuse_a_provider_with_no_credential_and_say_where_to_put_one', async () => {
    const env = { AIDCREW_HOME: emptyHome() }
    await expect(providerFromAidcrew('opencode-go', env)).rejects.toThrow(
      'no credential for opencode-go: add it in aidcrew or set AIDCREW_API_KEY_OPENCODE_GO',
    )
  })

  it('should_run_a_live_model_without_the_key_reaching_the_store_or_the_report', async () => {
    const endpoint = fakeEndpoint()
    stop = endpoint.stop
    const env = {
      AIDCREW_HOME: emptyHome(),
      AIDCREW_API_KEY_OPENCODE_GO: SECRET,
      AIDCREW_BASE_URL_OPENCODE_GO: endpoint.url,
    }
    const deps = makeCliDeps((providerId) => providerFromAidcrew(providerId, env))
    const db = join(emptyHome(), 'live.sqlite')
    const out: string[] = []
    await main(
      ['run', '--seed', '7', '--decider', 'aidcrew', '--ticks', '2', '--agents', '2', '--db', db],
      deps,
      (s) => out.push(s),
    )
    expect(endpoint.seen.length).toBe(4)
    expect(endpoint.seen.every((r) => r.auth === `Bearer ${SECRET}`)).toBe(true)
    expect(out.join('\n')).toContain('status: finished')
    expect(out.join('\n')).not.toContain(SECRET)
    const bytes = await Bun.file(db).text()
    expect(bytes).toContain('listening to the wind')
    expect(bytes).not.toContain(SECRET)
  })
})
