import { describe, expect, test } from 'bun:test'
import { diffClass } from './protocol.ts'

describe('painting a change in the browser', () => {
  test('tells an addition from a removal by the marker the row begins with', () => {
    expect(diffClass('+ 2 TWO')).toBe('add')
    expect(diffClass('- 2 two')).toBe('del')
  })

  test('names the file in its own row', () => {
    expect(diffClass('~ src/rates.ts +2 -1')).toBe('head')
  })

  test('anything else is context, which is there to be read past', () => {
    expect(diffClass('  1 unchanged')).toBe('ctx')
    expect(diffClass('… +18 more lines')).toBe('ctx')
    expect(diffClass('')).toBe('ctx')
  })
})
