import { describe, expect, test } from 'bun:test'
import { hidePaths, shorten } from './private.ts'

const home = '/Users/ada'

describe('hiding where the work is', () => {
  test('turns the home directory into a tilde', () => {
    // Which everybody reads without thinking, and which says nothing about
    // who you are.
    expect(shorten('/Users/ada/work/api', home)).toBe('~/work/api')
  })

  test('keeps enough of a path outside home to tell two checkouts apart', () => {
    // An absolute path still says which machine and which account, so only
    // the tail survives — enough to tell one from another, not enough to say
    // where they live.
    expect(shorten('/var/data/clients/acme/api', home)).toBe('…/acme/api')
  })

  test('leaves a short path alone, since there is nothing to hide in it', () => {
    expect(shorten('src/auth.ts', home)).toBe('src/auth.ts')
    expect(shorten('', home)).toBe('')
  })

  test('takes the home directory out of the middle of a sentence', () => {
    // Tool output and errors carry paths inside prose, and a transcript is
    // what is most often on screen when somebody is recording.
    expect(hidePaths(`ENOENT: open '${home}/work/api/a.ts'`, home)).toBe(
      "ENOENT: open '~/work/api/a.ts'",
    )
  })

  test('takes every one of them, not just the first', () => {
    const said = `copied ${home}/a to ${home}/b`

    expect(hidePaths(said, home)).toBe('copied ~/a to ~/b')
  })

  test('leaves text with nothing private in it exactly as it was', () => {
    expect(hidePaths('bun test passed', home)).toBe('bun test passed')
  })
})
