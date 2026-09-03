import { describe, expect, test } from 'bun:test'
import { describe as describeKey } from './run-keys.ts'

const ESC = ''

describe('saying what a terminal sent', () => {
  test('an ordinary character comes back as itself', () => {
    expect(describeKey('a')).toContain('a')
    expect(describeKey('a')).toContain('U+0061')
  })

  test('the character somebody cannot type, however it arrives', () => {
    // Plainly, when the terminal sends it as itself.
    expect(describeKey('@')).toContain('U+0040')

    // As an escape and then the character, when option is treated as meta.
    // This is the case that has to be told apart from a shortcut, and the
    // reason this command exists rather than another guess.
    const withEscape = describeKey(`${ESC}@`)
    expect(withEscape).toContain('\\x1b')
    expect(withEscape).toContain('U+001B U+0040')
  })

  test('names a control byte rather than printing something invisible', () => {
    expect(describeKey('')).toContain('\\x14')
  })

  test('handles a whole pasted line without choking on it', () => {
    expect(describeKey('hello')).toContain('U+0068')
  })
})
