import { existsSync } from 'node:fs'
import { defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
import { insteadOf } from './instead.ts'

const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 600_000
/** Roughly 12k tokens: past this a command is flooding the context window. */
const MAX_OUTPUT_CHARS = 50_000
/** How long to go on reading the pipes after the command itself has exited. */
const PIPE_GRACE_MS = 50

/**
 * Runs a shell command in the workspace.
 *
 * There is no command deny-list here on purpose. A blocklist over an arbitrary
 * shell is trivially bypassed (`ec\ho`, `$(printf ...)`, a script file) and
 * buying false confidence is worse than none: the real control is the
 * approval hook the host installs around this tool.
 *
 * What this tool does guarantee is that a command cannot hang the agent
 * forever, and cannot fill the context window with its output.
 */
export const bashTool = defineTool({
  name: 'bash',
  description:
    'Run a shell command in the workspace root and return its combined output. ' +
    'For searching use grep, for finding files use glob, for counting use wc: they are ' +
    'faster, they skip build output, and they need no approval because they only read. ' +
    'Commands time out and long output is truncated, so prefer targeted commands ' +
    'over ones that print entire files.',
  schema: z.object({
    command: z.string().min(1).describe('The shell command to run.'),
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(MAX_TIMEOUT_MS)
      .optional()
      .describe('How long to wait before killing the command.'),
  }),
  async run({ command, timeoutMs = DEFAULT_TIMEOUT_MS }, { cwd, signal }) {
    // Spawning into a directory that is not there fails with `ENOENT ...
    // posix_spawn 'bash'`, which reads as "bash is not installed" — so an
    // agent whose worktree was removed while it worked goes looking for a
    // shell rather than learning that its checkout is gone. Watched: a whole
    // turn alternating `glob *` and `wc .` against a directory that had
    // stopped existing.
    if (!existsSync(cwd)) {
      return {
        content:
          `this agent's checkout is gone: ${cwd} no longer exists. Nothing here can be run ` +
          'and trying again will not help — say so and stop rather than looking for another way in.',
        isError: true,
      }
    }

    const timeout = AbortSignal.timeout(timeoutMs)
    const stop = AbortSignal.any([signal, timeout])

    // In a process group of its own, so that stopping it stops what it
    // started: a test runner that spawned a server, a script that spawned a
    // watcher. Killing bash alone left those running, still holding the
    // pipes, and the command was reported as over while its children were
    // not.
    const child = Bun.spawn(['bash', '-c', command], {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      detached: true,
      signal: stop,
    })
    stop.addEventListener('abort', () => killGroup(child.pid), { once: true })

    const stdout = drain(child.stdout)
    const stderr = drain(child.stderr)
    const exitCode = await child.exited

    // The command is over when bash is. Its pipes may not be: a process it
    // started and left behind — `node server.js &` — inherits them and holds
    // them open for as long as it runs, and waiting for end-of-file on them
    // waited for that instead of for the command. Watched: a command that had
    // finished in a second was reported thirty-five minutes later, as a
    // timeout, when the server was finally killed by hand. So what the pipes
    // hold is collected for a moment after the exit, and then they are let go.
    await Promise.race([Promise.all([stdout.finished, stderr.finished]), Bun.sleep(PIPE_GRACE_MS)])
    stdout.stop()
    stderr.stop()

    const printed = [stdout.text(), stderr.text()]
      .filter((part) => part !== '')
      .join('\n')
      .trim()

    if (timeout.aborted) {
      // What it printed before it was stopped is the part somebody can act
      // on: a test runner that hung names the test it hung in.
      const sofar = printed === '' ? '' : `\n${truncate(printed)}`
      return {
        content: `command timed out after ${timeoutMs}ms: ${command}${sofar}`,
        isError: true,
      }
    }
    if (signal.aborted) {
      return { content: 'command was cancelled', isError: true }
    }

    const combined = truncate(printed)

    if (exitCode !== 0) {
      const detail = combined === '' ? '' : `\n${combined}`
      return { content: `command failed with exit code ${exitCode}${detail}`, isError: true }
    }

    // Only on a command that worked: a failing one has its own thing to say,
    // and a suggestion underneath it reads as the harness talking over the
    // error.
    const instead = insteadOf(command) ?? ''
    return { content: (combined === '' ? '(no output)' : combined) + instead }
  },
})

/**
 * Keeps both ends: the start says what the command was doing, the end usually
 * holds the error message that explains why it stopped.
 */
function truncate(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) return output

  const half = Math.floor(MAX_OUTPUT_CHARS / 2)
  const omitted = output.length - MAX_OUTPUT_CHARS
  return `${output.slice(0, half)}\n\n... ${omitted} characters truncated ...\n\n${output.slice(-half)}`
}

/**
 * Reads a pipe as it fills, and can be told to stop before it ends.
 *
 * `new Response(stream).text()` waits for end-of-file, and end-of-file only
 * comes when the last process holding the pipe closes it — which is not the
 * command when the command left something running.
 */
function drain(stream: ReadableStream<Uint8Array>): {
  text(): string
  finished: Promise<void>
  stop(): void
} {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let text = ''
  const finished = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) return
        text += decoder.decode(value, { stream: true })
      }
    } catch {
      // Cancelled, or the pipe went away with the process: what was read stands.
    }
  })()
  return {
    text: () => text,
    finished,
    stop: () => void reader.cancel().catch(() => undefined),
  }
}

/**
 * Stops a command and everything it started.
 *
 * The negative pid is the process group, which the child leads because it was
 * spawned detached. A group that has already gone is not an error worth
 * anything: the aim was for it to be gone.
 */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // Already gone.
  }
}
