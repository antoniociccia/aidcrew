import { describe, expect, test } from 'bun:test'
import { REPEATS_NOTED, REPEATS_REFUSED, Repeats } from './stall.ts'

describe('a turn going round in circles', () => {
  // The turn limit stops a model going round in circles — after fifty calls
  // on the bill. The same command failing the same way is visible on the
  // third time, and that is when it is said.
  test('counts the same call returning the same result', () => {
    const repeats = new Repeats()

    expect(repeats.record('bash', { command: 'bun test' }, '1 fail')).toBe(1)
    expect(repeats.record('bash', { command: 'bun test' }, '1 fail')).toBe(2)
    expect(repeats.record('bash', { command: 'bun test' }, '1 fail')).toBe(3)
    expect(repeats.streak('bash', { command: 'bun test' })).toBe(3)
  })

  test('starts over when the result changes, which is progress', () => {
    const repeats = new Repeats()
    repeats.record('bash', { command: 'bun test' }, '2 fail')
    repeats.record('bash', { command: 'bun test' }, '2 fail')

    expect(repeats.record('bash', { command: 'bun test' }, '1 fail')).toBe(1)
  })

  test('keeps calls apart by what they asked, not only by tool', () => {
    const repeats = new Repeats()
    repeats.record('read', { path: 'a.ts' }, 'const a')
    repeats.record('read', { path: 'b.ts' }, 'const a')

    expect(repeats.streak('read', { path: 'a.ts' })).toBe(1)
    expect(repeats.streak('read', { path: 'c.ts' })).toBe(0)
  })

  test('says, then refuses, at bounds a person would', () => {
    expect(REPEATS_NOTED).toBe(3)
    expect(REPEATS_REFUSED).toBe(6)
  })
})
