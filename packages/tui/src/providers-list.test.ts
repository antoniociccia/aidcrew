import { describe, expect, test } from 'bun:test'
import { providerChoices } from './providers-list.ts'

describe('choosing what an agent runs on', () => {
  test('says that a model is chosen next, so the list does not look finished', () => {
    const choices = providerChoices(['zen', 'openrouter'])

    expect(choices.map((one) => one.value)).toEqual(['zen', 'openrouter'])
    expect(choices[0]?.hint).toContain('you choose the model next')
  })
})
