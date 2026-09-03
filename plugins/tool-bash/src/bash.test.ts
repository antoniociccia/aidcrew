import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@aidcrew/core'
import { bashTool } from './bash.ts'

let root: string
let context: ToolContext

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-bash-')))
  context = { cwd: root, signal: new AbortController().signal, agentId: 'coder' }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('bash', () => {
  test('returns what the command printed', async () => {
    const output = await bashTool.execute({ command: 'echo hello' }, context)

    expect(output.content).toBe('hello')
    expect(output.isError).toBeFalsy()
  })

  test('runs in the workspace directory', async () => {
    writeFileSync(join(root, 'marker.txt'), '')

    const output = await bashTool.execute({ command: 'ls' }, context)

    expect(output.content).toBe('marker.txt')
  })

  test('includes stderr, because that is where errors explain themselves', async () => {
    const output = await bashTool.execute({ command: 'echo oops >&2' }, context)

    expect(output.content).toMatch(/oops/)
  })

  test('reports a non-zero exit code as an error', async () => {
    const output = await bashTool.execute({ command: 'exit 3' }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/exit code 3/)
  })

  test('says so explicitly when a command prints nothing', async () => {
    const output = await bashTool.execute({ command: 'true' }, context)

    expect(output.content).toMatch(/no output/i)
    expect(output.isError).toBeFalsy()
  })

  test('kills a command that outlives its timeout', async () => {
    const output = await bashTool.execute({ command: 'sleep 10', timeoutMs: 200 }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/timed out/i)
  })

  test('returns when the command is done, even if it left something running', async () => {
    // A process the command started and left behind — `node server.js &` —
    // inherits the pipes and holds them open for as long as it lives. Waiting
    // for end-of-file on them waited for that instead of for the command: one
    // that had finished in a second reported thirty-five minutes later, as a
    // timeout, when the server was killed by hand.
    const startedAt = performance.now()
    const output = await bashTool.execute({ command: '(sleep 4 &); echo started' }, context)

    expect(performance.now() - startedAt).toBeLessThan(2_000)
    expect(output.isError).toBeFalsy()
    expect(output.content).toBe('started')
  })

  test('a timeout still reports what the command printed before it', async () => {
    const output = await bashTool.execute(
      { command: 'echo partial; sleep 10', timeoutMs: 300 },
      context,
    )

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/timed out/i)
    expect(output.content).toContain('partial')
  })

  test('stops when the caller aborts', async () => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)

    const output = await bashTool.execute(
      { command: 'sleep 10' },
      { cwd: root, signal: controller.signal, agentId: 'coder' },
    )

    expect(output.isError).toBe(true)
  })

  test('truncates output that would otherwise flood the context window', async () => {
    const output = await bashTool.execute(
      { command: 'for i in $(seq 1 100000); do echo "line $i"; done' },
      context,
    )

    expect(output.content.length).toBeLessThan(60_000)
    expect(output.content).toMatch(/truncated/i)
  })

  test('keeps its description short, because it sits in every request', () => {
    expect(bashTool.description.length).toBeLessThan(400)
  })
})

describe('a shell command that a tool would have done', () => {
  test('says which one, on the result rather than in the description', async () => {
    // The description says it already and is read once, before choosing,
    // competing with every other description on the request. A result is read
    // by a model that has just done the thing and is deciding what to do next.
    writeFileSync(join(root, 'notes.md'), 'something\n')
    const out = await bashTool.execute({ command: 'cat notes.md' }, context)

    expect(out.content).toContain('`read` would have done this')
  })

  test('says nothing when the command did anything else at all', async () => {
    writeFileSync(join(root, 'notes.md'), 'something\n')
    const out = await bashTool.execute({ command: 'cat notes.md | head -n 1' }, context)

    expect(out.content).not.toContain('would have done this')
  })

  test('says nothing over a failure, which has its own thing to say', async () => {
    // A suggestion under an error reads as the harness talking over it.
    const out = await bashTool.execute({ command: 'cat nothing-is-here.txt' }, context)

    expect(out.isError).toBe(true)
    expect(out.content).not.toContain('would have done this')
  })
})

describe('when the agent has no checkout left', () => {
  test('says the workspace is gone rather than that bash is', async () => {
    // Spawning into a directory that does not exist fails with `ENOENT ...
    // posix_spawn 'bash'`, which reads as "bash is not installed" — so the
    // agent goes looking for a shell instead of learning that its checkout was
    // removed while it was working. Watched: a whole turn spent alternating
    // `glob *` and `wc .` against a directory that had stopped existing.
    const result = await bashTool.execute(
      { command: 'ls' },
      { cwd: '/nowhere/at/all', signal: new AbortController().signal, agentId: 'coder' },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('/nowhere/at/all')
    expect(result.content).toMatch(/gone|no longer/i)
    expect(result.content).not.toContain('posix_spawn')
  })
})
