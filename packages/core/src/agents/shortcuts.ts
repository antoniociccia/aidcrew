/**
 * The ways a check is made to pass without the work.
 *
 * A green suite proves the suite, not the request. An agent that cannot make
 * a test pass and deletes it, or the assertion inside it, or skips it, or
 * points the test script at `echo ok`, gets a green suite too — and most
 * often without meaning to cheat: the test looked wrong, the assertion
 * looked stale. None of this is forbidden. All of it is said out loud, in
 * the verdict and beside the merge, where the review will see it.
 */

const TEST_FILE =
  /(\.(test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)tests?\/|(^|\/)test_[^/]*\.py$|_test\.py$|(^|\/)spec\/)/
const ASSERTION = /\b(expect|assert\w*|t\.(Error|Fatal)\w*|require\.\w+)\s*[(!]/
const SKIPPED =
  /\b(test|it|describe)\.(skip|only|todo)\s*\(|\bx(it|test|describe)\s*\(|@pytest\.mark\.skip|\bt\.Skip\w*\(/

type Change = { path: string; deleted: boolean; removed: string[]; added: string[] }

/** What a unified diff says was done to the verification, one line each; nothing when nothing was. */
export function shortcutsIn(diff: string): string[] {
  const found: string[] = []
  for (const change of changesIn(diff)) {
    if (change.path === 'package.json') {
      if (change.removed.some((line) => /"test"\s*:/.test(line))) {
        found.push('the test script in package.json changed')
      }
      continue
    }
    if (change.path.endsWith('.aidcrew/config.toml')) {
      if ([...change.removed, ...change.added].some((line) => /^\s*check\s*=/.test(line))) {
        found.push(`the check in ${change.path} changed`)
      }
      continue
    }
    if (!TEST_FILE.test(change.path)) continue
    if (change.deleted) {
      found.push(`deleted ${change.path}`)
      continue
    }
    const assertions =
      change.removed.filter((line) => ASSERTION.test(line)).length -
      change.added.filter((line) => ASSERTION.test(line)).length
    if (assertions > 0) {
      found.push(`${change.path}: ${assertions} assertion${assertions === 1 ? '' : 's'} removed`)
    }
    const skipped =
      change.added.filter((line) => SKIPPED.test(line)).length -
      change.removed.filter((line) => SKIPPED.test(line)).length
    if (skipped > 0) {
      found.push(`${change.path}: ${skipped} test${skipped === 1 ? '' : 's'} skipped`)
    }
  }
  return found
}

function changesIn(diff: string): Change[] {
  const changes: Change[] = []
  let current: Change | undefined
  for (const line of diff.split('\n')) {
    const header = /^diff --git a\/(.*?) b\/(.*)$/.exec(line)
    if (header) {
      current = { path: header[2] ?? '', deleted: false, removed: [], added: [] }
      changes.push(current)
      continue
    }
    if (!current) continue
    if (line.startsWith('deleted file mode')) current.deleted = true
    else if (line.startsWith('+++') || line.startsWith('---')) continue
    else if (line.startsWith('-')) current.removed.push(line.slice(1))
    else if (line.startsWith('+')) current.added.push(line.slice(1))
  }
  return changes
}
