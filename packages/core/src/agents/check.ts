import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The command a project is proved by, and how it is run.
 *
 * "Finished means checked" was a sentence in the briefing, and a sentence is
 * something a model can say without doing. The harness runs the check
 * itself before a job is called done: what is declared in the project's
 * config wins, and where nothing is declared the command is read off the
 * files every ecosystem leaves behind, so nobody has to tell a harness that
 * can see the package.json what `bun test` is.
 */

/** Files that say, unambiguously, what the check is. */
const KNOWN: [file: string, command: string][] = [
  ['pyproject.toml', 'pytest -q'],
  ['pytest.ini', 'pytest -q'],
  ['go.mod', 'go test ./...'],
  ['Cargo.toml', 'cargo test'],
]

/** The check for a directory, or nothing when there is no telling. */
export function detectCheck(root: string): string | undefined {
  const manifest = join(root, 'package.json')
  if (existsSync(manifest)) {
    const script = testScriptOf(manifest)
    if (script === undefined) return undefined
    // Bun's own test runner, or a lockfile of its, is a project on bun; a
    // test script with neither is run the way its author runs it.
    const onBun =
      /\bbun\b/.test(script) ||
      existsSync(join(root, 'bun.lock')) ||
      existsSync(join(root, 'bun.lockb')) ||
      existsSync(join(root, 'bunfig.toml'))
    return onBun ? 'bun test' : 'npm test'
  }
  for (const [file, command] of KNOWN) if (existsSync(join(root, file))) return command
  return undefined
}

function testScriptOf(manifest: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as {
      scripts?: Record<string, unknown>
    }
    const script = parsed.scripts?.test
    return typeof script === 'string' && script.trim() !== '' ? script : undefined
  } catch {
    return undefined
  }
}

export type Verdict = {
  passed: boolean
  code: number
  /** The end of what the command printed, on both streams, where a failure is. */
  output: string
}

/** How much of the output is kept: the last of it is where a failure says what it was. */
const OUTPUT_KEPT = 4000
/** Long enough for a real suite, short enough that a hung one does not hold a job for ever. */
const TIMEOUT_MS = 10 * 60_000

/**
 * Runs the check in a directory and says whether it passed.
 *
 * Through `bash -c`, the same way an agent's own shell tool runs a command,
 * so what passes for the harness is what would have passed for them.
 */
export async function runCheck(
  command: string,
  cwd: string,
  timeoutMs = TIMEOUT_MS,
): Promise<Verdict> {
  try {
    const proc = Bun.spawn(['bash', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: timeoutMs,
    })
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    const output = `${out}${err}`.trim().slice(-OUTPUT_KEPT)
    return { passed: code === 0, code, output }
  } catch (cause) {
    return {
      passed: false,
      code: -1,
      output: cause instanceof Error ? cause.message : String(cause),
    }
  }
}
