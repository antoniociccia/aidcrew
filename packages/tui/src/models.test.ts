import { describe, expect, test } from 'bun:test'
import { isFree, listModels, rankForCoding } from './models.ts'

const respond = (body: unknown, init: ResponseInit = {}) =>
  (async () => new Response(JSON.stringify(body), init)) as unknown as typeof fetch

describe('listModels', () => {
  test('returns the ids the provider offers, sorted', async () => {
    const listing = await listModels(
      'https://example.test/v1',
      'k',
      respond({ data: [{ id: 'zeta' }, { id: 'alpha' }] }),
    )

    expect(listing).toEqual({ kind: 'listed', models: ['alpha', 'zeta'] })
  })

  test('asks the right endpoint with the key', async () => {
    let seen: { url: string; init: RequestInit } | undefined
    const spy = (async (url: string, init: RequestInit) => {
      seen = { url, init }
      return new Response(JSON.stringify({ data: [{ id: 'a' }] }))
    }) as unknown as typeof fetch

    await listModels('https://example.test/v1/', 'the-key', spy)

    // Asserted rather than reached through: if nothing was sent, `seen` is
    // undefined and the reader should get "expected a request" rather than a
    // TypeError from three levels down.
    expect(seen).toBeDefined()
    expect(seen?.url).toBe('https://example.test/v1/models')
    expect((seen?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
      'Bearer the-key',
    )
  })

  test('says plainly when the key was rejected', async () => {
    // Finding this out now beats finding it out on the first real request.
    const listing = await listModels('https://x.test/v1', 'wrong', respond({}, { status: 401 }))

    expect(listing).toEqual({ kind: 'unavailable', reason: 'the key was rejected' })
  })

  test('reports an unexpected status without pretending to have a list', async () => {
    const listing = await listModels('https://x.test/v1', 'k', respond({}, { status: 500 }))

    expect(listing).toMatchObject({ kind: 'unavailable' })
  })

  test('treats an empty list as no list', async () => {
    const listing = await listModels('https://x.test/v1', 'k', respond({ data: [] }))

    expect(listing).toMatchObject({ kind: 'unavailable' })
  })

  test('never throws when the provider is unreachable', async () => {
    const broken = (async () => {
      throw new Error('connection refused')
    }) as unknown as typeof fetch

    const listing = await listModels('https://x.test/v1', 'k', broken)

    expect(listing).toMatchObject({ kind: 'unavailable', reason: 'connection refused' })
  })

  test('ignores entries that are not model ids', async () => {
    const listing = await listModels(
      'https://x.test/v1',
      'k',
      respond({ data: [{ id: 'good' }, { id: 42 }, {}] }),
    )

    expect(listing).toEqual({ kind: 'listed', models: ['good'] })
  })
})

describe('rankForCoding', () => {
  test('puts models known to work well with tools first', () => {
    const ranked = rankForCoding(['random-model', 'claude-opus-5', 'another-thing'])

    expect(ranked[0]).toBe('claude-opus-5')
  })

  test('puts the cheap tier of a family before its expensive one', () => {
    // A team of four on the strongest model is a bill nobody meant to run up
    // while finding out whether the thing works. The list a person picks a
    // first model from starts with the ones that are cheap and good with
    // tools — glm-5.3-flash, qwen3.8-flash — and the expensive ones are still
    // there, further down.
    const ranked = rankForCoding(['claude-opus-5', 'qwen3.8-max', 'glm-5.3-flash', 'qwen3.8-flash'])

    expect(ranked.slice(0, 2)).toEqual(['glm-5.3-flash', 'qwen3.8-flash'])
    expect(ranked.indexOf('qwen3.8-flash')).toBeLessThan(ranked.indexOf('qwen3.8-max'))
  })

  test('keeps everything, only reorders', () => {
    const models = ['a', 'deepseek-chat', 'b']

    expect(rankForCoding(models).sort()).toEqual(models.sort())
  })

  test('sorts the unknown ones alphabetically among themselves', () => {
    expect(rankForCoding(['zebra', 'apple'])).toEqual(['apple', 'zebra'])
  })

  test('leaves an empty list alone', () => {
    expect(rankForCoding([])).toEqual([])
  })
})

describe('isFree', () => {
  test('recognises the free tier by the suffix gateways use', () => {
    // Verified against opencode.ai/zen: its free models end in -free.
    expect(isFree('deepseek-v4-flash-free')).toBe(true)
    expect(isFree('nemotron-3-ultra-free')).toBe(true)
  })

  test('does not mistake a paid model for a free one', () => {
    expect(isFree('deepseek-v4-flash')).toBe(false)
    expect(isFree('claude-opus-5')).toBe(false)
  })

  test('only matches the suffix, not the word anywhere', () => {
    expect(isFree('free-willy-3')).toBe(false)
  })
})
