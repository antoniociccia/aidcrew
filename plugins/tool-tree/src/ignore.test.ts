import { describe, expect, test } from 'bun:test'
import { compileIgnore } from './ignore.ts'

/**
 * Each case: the .gitignore body, then a path relative to the file's directory,
 * whether that path is a directory, and whether git would ignore it.
 */
const cases: [string, string, boolean, boolean][] = [
  ['node_modules', 'node_modules', true, true],
  ['node_modules', 'packages/x/node_modules', true, true],
  ['node_modules', 'src/node_modules.ts', false, false],
  ['*.log', 'app.log', false, true],
  ['*.log', 'logs/app.log', false, true],
  ['*.log', 'app.log.bak', false, false],
  ['/build', 'build', true, true],
  ['/build', 'src/build', true, false],
  ['coverage/', 'coverage', true, true],
  ['coverage/', 'coverage', false, false],
  ['docs/*.tmp', 'docs/a.tmp', false, true],
  ['docs/*.tmp', 'docs/sub/a.tmp', false, false],
  ['docs/**/*.tmp', 'docs/sub/deep/a.tmp', false, true],
  ['docs/**/*.tmp', 'docs/a.tmp', false, true],
  ['**/.aidcrew/wt/', 'a/b/.aidcrew/wt', true, true],
  ['secret?.txt', 'secret1.txt', false, true],
  ['secret?.txt', 'secretary.txt', false, false],
  ['secret?.txt', 'secret.txt', false, false],
  ['*.[oa]', 'x.o', false, true],
  ['*.[oa]', 'x.c', false, false],
  ['*.log\n!keep.log', 'keep.log', false, false],
  ['*.log\n!keep.log', 'other.log', false, true],
  ['# only a comment\n\n', 'anything', false, false],
  ['\\#literal', '#literal', false, true],
  ['a.txt   ', 'a.txt', false, true],
  ['sub/**', 'sub/x/y', false, true],
  ['dist', 'dist', true, true],
]

describe('compileIgnore', () => {
  test.each(cases)('%j ignores %j (dir=%p) → %p', (body, path, isDir, expected) => {
    const ignores = compileIgnore(body)

    expect(ignores(path, isDir) ?? false).toBe(expected)
  })

  test('a later rule wins over an earlier one, which is how negation works in git', () => {
    const ignores = compileIgnore('!keep.log\n*.log')

    expect(ignores('keep.log', false)).toBe(true)
  })
})
