import { describe, expect, test } from 'bun:test'
import { nearest } from './nearest.ts'

describe('suggesting a model that exists', () => {
  const catalogue = [
    'qwen3.6-plus',
    'qwen3.5-plus',
    'deepseek-v4-flash',
    'deepseek-v4-flash-free',
    'gemini-3.6-flash',
    'gpt-5.4-mini',
    'nemotron-3-ultra-free',
  ]

  test('puts the same family first', () => {
    // The live case: a config asked for "qwen3.8-flash", which this provider
    // has never had. The gateway answered "Endpoint is unavailable", so the
    // name was never in question and six agents failed every turn for two
    // days.
    expect(nearest('qwen3.8-flash', catalogue)[0]).toMatch(/^qwen/)
  })

  test('offers a few, not one', () => {
    // A single guess reads as an answer. Three read as a shortlist, which is
    // what this is: the name is gone and only the person knows what they meant.
    expect(nearest('qwen3.8-flash', catalogue).length).toBe(3)
  })

  test('finds a typo in a name that does exist elsewhere in the list', () => {
    expect(nearest('deepseek-v4-flsh', catalogue)[0]).toBe('deepseek-v4-flash')
  })

  test('says nothing rather than anything when nothing is close', () => {
    // "Did you mean nemotron-3-ultra-free?" for a model called "banana" is
    // noise on top of an error, and it teaches people to skip the sentence.
    expect(nearest('banana', catalogue)).toEqual([])
  })

  test('has nothing to offer from an empty catalogue', () => {
    expect(nearest('qwen3.8-flash', [])).toEqual([])
  })

  test('reaches a dated release from the short name people type', () => {
    // Anthropic's ids carry a date, and nobody types one from memory.
    expect(
      nearest('claude-opus-4.1', ['claude-opus-4-1-20250805', 'claude-haiku-3-5-20241022'])[0],
    ).toBe('claude-opus-4-1-20250805')
  })
})
