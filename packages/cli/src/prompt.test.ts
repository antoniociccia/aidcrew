import { describe, expect, test } from 'bun:test'
import { encode } from 'gpt-tokenizer'
import { buildSystemPrompt } from './prompt.ts'

describe('buildSystemPrompt', () => {
  test('stays under the token budget the project promises', () => {
    // The whole pitch is a small prompt. If this fails, something that should
    // have been a skill or a plugin was written into the base prompt instead.
    const tokens = encode(buildSystemPrompt({ cwd: '/repo', platform: 'darwin' })).length

    expect(tokens).toBeLessThan(1000)
  })

  test('tells the model where it is working', () => {
    const prompt = buildSystemPrompt({ cwd: '/repo/project', platform: 'linux' })

    expect(prompt).toContain('/repo/project')
    expect(prompt).toContain('linux')
  })

  test('appends project instructions when the workspace has them', () => {
    const prompt = buildSystemPrompt({
      cwd: '/repo',
      platform: 'darwin',
      instructions: ['Always use tabs.'],
    })

    expect(prompt).toContain('Always use tabs.')
  })

  test('leaves no empty instruction section when there are none', () => {
    const prompt = buildSystemPrompt({ cwd: '/repo', platform: 'darwin' })

    expect(prompt).not.toMatch(/instructions/i)
  })

  test('keeps project instructions after the base prompt, so they can override it', () => {
    const prompt = buildSystemPrompt({
      cwd: '/repo',
      platform: 'darwin',
      instructions: ['Never run tests.'],
    })

    expect(prompt.indexOf('Never run tests.')).toBeGreaterThan(prompt.indexOf('/repo'))
  })
})
