import { describe, expect, test } from 'bun:test'
import { insteadOf } from './instead.ts'

describe('saying which tool would have done it without a shell', () => {
  test('names read for a command that only prints a file', () => {
    // Fifty-two bash calls against nine reads, measured in one session, for
    // work that was all reading. The description says this already and is
    // read once, before choosing, against every other description on the
    // request; a result is read at the moment it matters.
    expect(insteadOf('cat packages/cli/package.json')).toContain('read')
  })

  test('names grep, glob and wc for the shell versions of each', () => {
    expect(insteadOf('grep -rn "tools" packages/cli/src')).toContain('grep')
    expect(insteadOf('find . -name "*.ts"')).toContain('glob')
    expect(insteadOf('wc -l README.md')).toContain('wc')
  })

  test('names the tools that arrived later for the shell versions of each', () => {
    expect(insteadOf('git log --oneline -5 -- src/auth.ts')).toContain('git-log')
    expect(insteadOf('tree packages/core')).toContain('tree')
    expect(insteadOf('ls -R src')).toContain('tree')
    expect(insteadOf('find . -type d')).toContain('tree')
    expect(insteadOf('head -n 20 README.md')).toContain('head')
    expect(insteadOf('tail -n 50 out.log')).toContain('head')
    expect(insteadOf('stat README.md')).toContain('stat')
    expect(insteadOf('du -sh node_modules')).toContain('stat')
  })

  test('says nothing when the shell is doing something no tool here does', () => {
    // A pipe, a redirection, a second command joined on: the moment the shell
    // is composing, no single tool replaces it, and a note claiming otherwise
    // would be wrong rather than merely unhelpful.
    expect(insteadOf('cat a.ts | head -n 5')).toBeUndefined()
    expect(insteadOf('ls > listing.txt')).toBeUndefined()
    expect(insteadOf('cat a.ts; rm a.ts')).toBeUndefined()
    expect(insteadOf('grep x a.ts && echo found')).toBeUndefined()
  })

  test('says nothing about an ordinary command', () => {
    expect(insteadOf('bun test')).toBeUndefined()
    expect(insteadOf('git status')).toBeUndefined()
    expect(insteadOf('./check.sh')).toBeUndefined()
  })
})

/**
 * Commands joined together.
 *
 * The advice fired only when the whole command was one of these, on the
 * reasoning that a pipe or a second command means the shell is doing work no
 * tool here does. True of a pipe. Not true of `&&`, which is two commands —
 * and two reads joined by one is the shape a model reaches for when it is
 * exploring, so the habit this exists to redirect was the habit it never saw.
 *
 * Observed: forty-odd calls in one turn, nearly all of them `cat a && cat b`
 * or `ls -la && cat x`, and not one of them was told there was a better tool.
 */
describe('a command with another joined on', () => {
  test('says so when every part of it is a read', () => {
    expect(insteadOf('cat package.json && cat tsconfig.json')).toContain('read')
  })

  test('and when the parts are different tools, naming the first', () => {
    expect(insteadOf('ls -la && cat TOOLS-BRIEF.md')).toBeDefined()
  })

  test('says nothing when one part is something no tool does', () => {
    // The original reasoning, kept: a command that builds, moves or runs
    // something is not a read with a read attached to it.
    expect(insteadOf('cat a.ts && bun test')).toBeUndefined()
    expect(insteadOf('git log --oneline && git status')).toBeUndefined()
  })

  test('still says nothing about a pipe, which does work no tool does', () => {
    expect(insteadOf('find plugins -type d | sort')).toBeUndefined()
    expect(insteadOf('grep -rn defineTool . | head -20')).toBeUndefined()
  })

  test('ignores a part that is only an echo, which is punctuation', () => {
    // `echo "=== next"` between two reads is somebody labelling their own
    // output, not a third thing being done.
    expect(insteadOf('cat a.ts && echo "=== b" && cat b.ts')).toContain('read')
  })
})
