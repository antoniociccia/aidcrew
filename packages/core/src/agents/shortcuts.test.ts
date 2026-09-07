import { describe, expect, test } from 'bun:test'
import { shortcutsIn } from './shortcuts.ts'

const file = (path: string, lines: string[], mode: 'changed' | 'deleted' = 'changed') =>
  [
    `diff --git a/${path} b/${path}`,
    ...(mode === 'deleted'
      ? ['deleted file mode 100644', '--- a/' + path, '+++ /dev/null']
      : ['--- a/' + path, '+++ b/' + path]),
    '@@ -1,3 +1,3 @@',
    ...lines,
  ].join('\n')

describe('the ways a check is made to pass without the work', () => {
  // A green suite proves the suite, not the request. An agent that deletes
  // the test it cannot pass, or the assertion inside it, gets a green suite
  // too — most often without meaning to cheat. None of this is forbidden;
  // all of it is said out loud, where the review will see it.
  test('a deleted test file is named', () => {
    const found = shortcutsIn(file('src/auth.test.ts', ['-expect(token).toBeDefined()'], 'deleted'))

    expect(found).toEqual(['deleted src/auth.test.ts'])
  })

  test('assertions removed from a test are counted, net of any added', () => {
    const found = shortcutsIn(
      file('src/auth.test.ts', [
        '-  expect(token).toBeDefined()',
        '-  expect(user.role).toBe("admin")',
        '+  expect(token).toBeDefined()',
        ' const x = 1',
      ]),
    )

    expect(found).toEqual(['src/auth.test.ts: 1 assertion removed'])
  })

  test('a test skipped or narrowed is counted', () => {
    const found = shortcutsIn(
      file('src/auth.test.ts', [
        '-  test("rejects an expired token", () => {',
        '+  test.skip("rejects an expired token", () => {',
      ]),
    )

    expect(found).toEqual(['src/auth.test.ts: 1 test skipped'])
  })

  test('a changed test script or check command is named', () => {
    const found = shortcutsIn(
      [
        file('package.json', ['-    "test": "vitest run",', '+    "test": "echo ok",']),
        file('.aidcrew/config.toml', ['-check = "bun test"', '+check = "true"']),
      ].join('\n'),
    )

    expect(found).toEqual([
      'the test script in package.json changed',
      'the check in .aidcrew/config.toml changed',
    ])
  })

  test('says nothing about ordinary work, assertions added included', () => {
    const found = shortcutsIn(
      [
        file('src/auth.ts', ['-  return null', '+  return token']),
        file('src/auth.test.ts', ['+  expect(token).toBeDefined()']),
        file('src/assert-helpers.ts', [
          '-export function assertIs() {}',
          '+export function assertIs(x: unknown) {}',
        ]),
      ].join('\n'),
    )

    expect(found).toEqual([])
  })
})
