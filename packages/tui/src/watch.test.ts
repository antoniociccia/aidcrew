import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { watchDirectories } from './watch.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-watch-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

const soon = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Waits for something to become true, rather than for a number of milliseconds.
 *
 * macOS watches a directory tree through FSEvents, whose latency is real and
 * variable — a fixed 200ms wait passed fourteen runs out of fifteen, which is
 * the worst possible test: it fails in CI, on somebody else's laptop, and
 * never while you are looking at it.
 */
/**
 * Waits for the watcher, and says so when it does not come.
 *
 * Generous, because it polls: on a machine that is not busy these return in a
 * few milliseconds, and the only thing a longer deadline costs is how long a
 * genuinely broken watcher takes to be reported. The old four seconds was a
 * race against every other test file running beside this one, and losing it
 * failed the assertion below rather than this line — so a loaded machine read
 * as a broken watcher.
 */
async function until(ready: () => boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!ready() && Date.now() < deadline) await soon(20)
  if (!ready()) throw new Error(`the watcher did not fire within ${ms}ms`)
}

/**
 * Writes until the watcher notices, or gives up saying so.
 *
 * A recursive watch on macOS goes through FSEvents, which takes a moment to
 * begin delivering — and a write in that moment is not late, it is lost, so
 * waiting longer for it never helps. What is being tested is that a write
 * under the directory is reported, not that the first write after the watcher
 * was constructed is, and writing again is what a person would do.
 */
async function untilNoticed(
  write: () => void,
  ready: () => boolean,
  settleMs = 20,
  ms = 15_000,
): Promise<void> {
  // Longer between tries than the watch's own settle window, or the retry is
  // itself what stops the callback: every write restarts the debounce, so
  // writing faster than it settles means it never settles at all.
  const gap = Math.max(50, settleMs * 3)
  const deadline = Date.now() + ms
  while (!ready() && Date.now() < deadline) {
    write()
    await soon(gap)
  }
  if (!ready()) throw new Error(`the watcher did not fire within ${ms}ms`)
}

describe('noticing a plugin change', () => {
  test('a write under the directory is reported', async () => {
    let seen = 0
    const watching = watchDirectories([root], () => (seen += 1), 20)
    try {
      await untilNoticed(
        () => writeFileSync(join(root, 'index.ts'), 'export default { name: "x" }'),
        () => seen > 0,
      )

      expect(seen).toBeGreaterThan(0)
    } finally {
      watching.close()
    }
  }, 20_000)

  test('saving one file once is one reload, not four', async () => {
    // An editor writing a file produces several events — a temp file, a
    // rename, a directory touch — and reloading on each would reload a file
    // that is still half-written.
    let seen = 0
    const watching = watchDirectories([root], () => (seen += 1), 60)
    try {
      // Woken first and then measured, in two steps. Writing repeatedly to
      // beat the FSEvents start-up race is exactly what resets the debounce
      // this test exists to measure, so the two cannot be the same loop.
      await untilNoticed(
        () => writeFileSync(join(root, 'wake.ts'), 'x'),
        () => seen > 0,
        60,
      )
      await soon(200)
      seen = 0

      for (let index = 0; index < 5; index += 1) {
        writeFileSync(join(root, `f${index}.ts`), 'x')
        await soon(5)
      }
      // And still one a settle-window later: the point is that the other four
      // events were folded into it, not that the first one arrived.
      await until(() => seen > 0)
      await soon(200)

      expect(seen).toBe(1)
    } finally {
      watching.close()
    }
  }, 20_000)

  test('a directory that does not exist is not an error', () => {
    const watching = watchDirectories([join(root, 'nowhere')], () => {})
    expect(() => watching.close()).not.toThrow()
  }, 20_000)

  test('nothing fires after it is closed', async () => {
    let seen = 0
    const watching = watchDirectories([root], () => (seen += 1), 20)
    writeFileSync(join(root, 'a.ts'), 'x')
    watching.close()
    await soon(300)

    expect(seen).toBe(0)
  }, 20_000)

  test('a nested directory is watched too', async () => {
    mkdirSync(join(root, 'deep'), { recursive: true })
    let seen = 0
    const watching = watchDirectories([root], () => (seen += 1), 20)
    try {
      await untilNoticed(
        () => writeFileSync(join(root, 'deep', 'index.ts'), 'x'),
        () => seen > 0,
      )

      expect(seen).toBe(1)
    } finally {
      watching.close()
    }
  }, 20_000)
})
