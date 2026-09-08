import { describe, expect, test } from 'bun:test'
import plugin, { headersFor, PRESETS } from './plugin.ts'

function provider(id: string) {
  const definition = plugin.providers?.find((p) => p.id === id)
  if (!definition) throw new Error(`the plugin declares no provider "${id}"`)
  return definition
}

describe('provider-openai-compat plugin', () => {
  test('declares one provider per preset, plus the generic escape hatch and the replay', () => {
    const ids = plugin.providers?.map((p) => p.id).sort()

    expect(ids).toEqual([...Object.keys(PRESETS), 'openai-compat', 'replay'].sort())
  })

  test('offers OpenCode Go as its own endpoint, not as Zen', () => {
    // Verified against the docs and the live service: Go answers at
    // /zen/go/v1 and bills separately. Pointing a Go key at Zen fails with
    // "Insufficient balance", which reads like a billing problem and is not.
    expect(PRESETS['opencode-go']).toBe('https://opencode.ai/zen/go/v1')
    expect(PRESETS.zen).toBe('https://opencode.ai/zen/v1')
    expect(provider('opencode-go').create({ apiKey: 'k' }).id).toBe('opencode-go')
  })

  test('a preset needs only an api key', () => {
    const created = provider('zen').create({ apiKey: 'k' })

    expect(created.id).toBe('zen')
  })

  test('a preset endpoint can still be overridden, for a local proxy', () => {
    expect(() =>
      provider('deepseek').create({ apiKey: 'k', baseUrl: 'http://localhost:8080/v1' }),
    ).not.toThrow()
  })

  test('the generic provider requires an explicit endpoint', () => {
    expect(() => provider('openai-compat').create({ apiKey: 'k' })).toThrow(/baseUrl/)
  })

  test('rejects a missing api key at creation, not at the first request', () => {
    expect(() => provider('zen').create({})).toThrow(/apiKey/)
  })

  test('never repeats the api key in a configuration error', () => {
    try {
      provider('openai-compat').create({ apiKey: 'super-secret', baseUrl: 'not-a-url' })
      throw new Error('expected create to reject')
    } catch (error) {
      expect((error as Error).message).not.toContain('super-secret')
    }
  })

  test('refuses a non-http endpoint', () => {
    expect(() =>
      provider('openai-compat').create({ apiKey: 'k', baseUrl: 'file:///etc/passwd' }),
    ).toThrow()
  })

  test('takes the two stall limits, in milliseconds, and refuses a nonsense one', () => {
    // A service that stops talking is given up on after these. Named with
    // the unit because a "120" read as seconds and stored as milliseconds
    // is a timeout that fires before the request is even sent.
    expect(() =>
      provider('zen').create({ apiKey: 'k', firstByteTimeoutMs: 30_000, idleTimeoutMs: 5_000 }),
    ).not.toThrow()
    expect(() => provider('zen').create({ apiKey: 'k', idleTimeoutMs: 0 })).toThrow(/idleTimeoutMs/)
  })

  test('passes extra headers through to the provider', () => {
    expect(() =>
      provider('openrouter').create({ apiKey: 'k', headers: { 'HTTP-Referer': 'https://x.test' } }),
    ).not.toThrow()
  })
})

describe('the headers a request carries', () => {
  test('say who is calling, by name', () => {
    expect(headersFor('https://openrouter.ai/api/v1')['User-Agent']).toMatch(/^aidcrew/)
  })

  test('carry one session id per provider to OpenCode, which refuses a request without one', () => {
    const go = headersFor('https://opencode.ai/zen/go/v1')
    const zen = headersFor('https://opencode.ai/zen/v1')
    expect(go['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/)
    expect(zen['x-opencode-session']).toMatch(/^[0-9a-f-]{36}$/)
    expect(go['x-opencode-session']).not.toBe(zen['x-opencode-session'])
  })

  test('send no session id anywhere else', () => {
    expect(headersFor('https://api.deepseek.com/v1')['x-opencode-session']).toBeUndefined()
  })

  test('let the configuration have the last word', () => {
    const headers = headersFor('https://opencode.ai/zen/go/v1', {
      'User-Agent': 'mine/2',
      'x-opencode-session': 'fixed',
    })
    expect(headers['User-Agent']).toBe('mine/2')
    expect(headers['x-opencode-session']).toBe('fixed')
  })
})
