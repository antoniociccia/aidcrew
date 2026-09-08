import { describe, expect, test } from 'bun:test'
import { isMeasured, measuredHint } from './measured.ts'
import { rankForCoding } from './models.ts'

describe('what the benchmark measured, beside a model', () => {
  test('names the best figure a model took part in, whatever prefix the provider gives it', () => {
    expect(measuredHint('z-ai/glm-5.3-flash')).toBe(
      'measured: 94% of 90 runs in a team (glm-5.3-flash plans, deepseek-v4-flash writes), 0.4¢ per solved task',
    )
    expect(measuredHint('deepseek-v4-pro')).toBe(
      'measured: 91% of 90 runs alone, 3.1¢ per solved task',
    )
  })

  test('says nothing about a model the benchmark has not run', () => {
    expect(measuredHint('claude-opus-5')).toBeUndefined()
    expect(isMeasured('gpt-5')).toBe(false)
  })

  test('puts the measured models first in the wizard, before the merely preferred', () => {
    const ranked = rankForCoding([
      'claude-opus-5',
      'qwen3.8-flash',
      'deepseek-v4-flash',
      'glm-5.3-flash',
    ])

    expect(ranked.slice(0, 2).sort()).toEqual(['deepseek-v4-flash', 'glm-5.3-flash'])
  })
})
