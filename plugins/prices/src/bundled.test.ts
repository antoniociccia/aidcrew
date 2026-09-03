import { describe, expect, test } from 'bun:test'
import { BUNDLED_FROM, bundledPriceOf, normaliseModelId } from './bundled.ts'
import { costOf, isEstimate, money } from './table.ts'

describe('a price from the bundled list', () => {
  test('is found for a model a paid gateway lists without a price', () => {
    // The live case. Zen's /models says `{"id":"claude-opus-5","object":"model"}`
    // and nothing about money, so the table read from the listing was empty
    // and the screen showed no cost at all for a service that bills every
    // token — which is the complaint "the counting is broken with paid
    // providers", and which a list price with a tilde in front answers.
    expect(bundledPriceOf('claude-opus-5')).toMatchObject({
      input: 5e-6,
      output: 25e-6,
      cacheRead: 0.5e-6,
      cacheWrite: 6.25e-6,
    })
  })

  test('says where it came from, so a surprising bill can be traced', () => {
    expect(BUNDLED_FROM).toBe('the bundled list (checked September 2026)')
    expect(bundledPriceOf('claude-opus-5')?.from).toBe(BUNDLED_FROM)
  })

  test('is marked as an estimate, because a list in a repository is stale by the time it is read', () => {
    expect(bundledPriceOf('gpt-5')?.estimated).toBe(true)
  })

  test('ignores case and a vendor written in front', () => {
    expect(bundledPriceOf('Anthropic/Claude-Opus-5')).toEqual(bundledPriceOf('claude-opus-5'))
    expect(bundledPriceOf('openai/gpt-5-mini')).toEqual(bundledPriceOf('gpt-5-mini'))
  })

  test('ignores a date suffix, a -latest and a dot where a dash was meant', () => {
    expect(bundledPriceOf('claude-sonnet-4-5-20250929')).toEqual(
      bundledPriceOf('claude-sonnet-4-5'),
    )
    expect(bundledPriceOf('claude-opus-4-5@20251101')).toEqual(bundledPriceOf('claude-opus-4-5'))
    expect(bundledPriceOf('gpt-5-mini-2025-08-07')).toEqual(bundledPriceOf('gpt-5-mini'))
    expect(bundledPriceOf('gpt-5-chat-latest')).toEqual(bundledPriceOf('gpt-5-chat'))
    expect(bundledPriceOf('claude-opus-4.5')).toEqual(bundledPriceOf('claude-opus-4-5'))
  })

  test('takes the longest known name the id starts with', () => {
    // `kimi-k2.7-code` is a K2.7; `o3-pro` is not an o3 at ten times the
    // price, so the longer name has to win over the shorter one it contains.
    expect(bundledPriceOf('kimi-k2.7-code')).toEqual(bundledPriceOf('kimi-k2.7'))
    expect(bundledPriceOf('o3-pro')?.input).toBe(20e-6)
    expect(bundledPriceOf('o3')?.input).toBe(2e-6)
  })

  test('does not price a model whose name merely begins like a known one', () => {
    expect(bundledPriceOf('o30')).toBeUndefined()
    expect(bundledPriceOf('gpt-50')).toBeUndefined()
  })

  test('prices a free tier at nothing, which is a fact about its name and not an estimate', () => {
    // Zen appends `-free` to the models it serves at no charge, and a free
    // model priced at the paid rate would put money on the screen for work
    // that cost nothing.
    const free = bundledPriceOf('deepseek-v4-flash-free')

    expect(free).toMatchObject({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
    expect(free?.estimated).toBeFalsy()
  })

  test('says nothing for a model nobody has heard of', () => {
    expect(bundledPriceOf('muse-spark-1.2-contributor')).toBeUndefined()
  })

  test('normalises the way the lookup does, so a caller can compare names', () => {
    expect(normaliseModelId('OpenAI/GPT-5.4-Mini-2026-03-05')).toBe('gpt-5-4-mini')
  })

  test('covers the families people actually run', () => {
    for (const model of [
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-sonnet-5',
      'claude-haiku-4-5',
      'gpt-5.4-mini',
      'gpt-5.6-luna',
      'o4-mini',
      'gemini-3-pro',
      'gemini-3.6-flash',
      'deepseek-v4',
      'deepseek-v4-flash',
      'kimi-k3',
      'qwen3.8-max',
      'qwen3.8-flash',
      'glm-5.3-flash',
      'minimax-m2.7',
      'minimax-m3',
      'grok-4.6',
      'mistral-large-3',
    ]) {
      expect(bundledPriceOf(model), model).toBeDefined()
    }
  })
})

describe('what a turn costs at a bundled price', () => {
  const opus = bundledPriceOf('claude-opus-5')
  const turn = {
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 9000,
    cacheWriteTokens: 400,
  }

  test('charges a cached read at the cache rate, not the full input rate', () => {
    // 1000 × $5/M + 100 × $25/M + 9000 × $0.50/M + 400 × $6.25/M. Priced at
    // the input rate the cached read alone would be 4.5¢ rather than 0.45¢,
    // and on a coding turn it is most of the input.
    expect(costOf(turn, opus)).toBeCloseTo(0.005 + 0.0025 + 0.0045 + 0.0025, 10)
  })

  test('is shown as an estimate', () => {
    const cost = costOf(turn, opus)

    expect(isEstimate(turn, opus)).toBe(true)
    expect(money(cost ?? 0, isEstimate(turn, opus))).toBe('~1¢')
  })

  test('is not an estimate when the provider stated the money itself', () => {
    expect(isEstimate({ ...turn, chargedUsd: 0.02 }, opus)).toBe(false)
  })

  test('is not an estimate when nothing was spent', () => {
    expect(isEstimate({ inputTokens: 0, outputTokens: 0 }, opus)).toBe(false)
  })

  test('is not an estimate when the price came from somewhere that stated it', () => {
    expect(isEstimate(turn, { input: 5e-6, output: 25e-6, from: 'openrouter' })).toBe(false)
  })
})
