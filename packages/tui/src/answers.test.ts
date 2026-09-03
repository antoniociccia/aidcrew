import { describe, expect, test } from 'bun:test'
import { answersFor } from './answers.ts'

const take = () => () => {}

describe('what a question offers as answers', () => {
  test('offers the wider ones a guard has, in their own words', () => {
    const answers = answersFor({ folder: 'writes under src/', broad: 'bash rm …' }, take)

    expect(answers.map((one) => one.key)).toEqual(['y', 'd', 'a', 'n'])
    expect(answers[2]?.label).toBe('bash rm …')
  })

  test('offers only yes and no when there is nothing wider to allow', () => {
    // A plugin asking whether it may use a token asks one thing, once. There
    // is no broader version of it, and offering one put two keys on the
    // prompt that did the same thing — one labelled "yes" beside another
    // labelled "once", which is not a choice but a puzzle.
    const answers = answersFor({}, take)

    expect(answers.map((one) => one.key)).toEqual(['y', 'n'])
  })

  test('always ends with refusing, which is the one that costs nothing', () => {
    for (const scopes of [{}, { broad: 'x' }, { folder: 'f', broad: 'x' }]) {
      expect(answersFor(scopes, take).at(-1)?.key).toBe('n')
    }
  })
})
