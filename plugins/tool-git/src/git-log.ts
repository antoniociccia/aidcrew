import { realpathSync } from 'node:fs'
import { relative } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'

/**
 * What happened to a path, from git, without the shell.
 *
 * `bash git log` needs an approval every time — the harness cannot tell one
 * git subcommand from another — and comes back formatted however the user's
 * own git config decided, which a model then has to parse. This is bounded,
 * parsed, and needs no approval, because reading history changes nothing.
 */

const DEFAULT_COUNT = 10
const MAX_COUNT = 50
/** How long to wait for git. A repository with a hundred thousand commits is still fast. */
const TIMEOUT_MS = 15_000

/**
 * The separator between fields.
 *
 * A unit separator, which is a control character git will not put in a
 * subject and nobody types. Splitting on whitespace or a punctuation mark
 * would take `fix: handle "quotes", | pipes` apart in the middle.
 */
const FIELD = String.fromCharCode(31)

export const gitLogTool = defineTool({
  name: 'git-log',
  reads: true,
  description:
    'The commits touching a path, newest first: short hash, date, author, subject. ' +
    'Use it instead of running git log through bash — it needs no approval because ' +
    'it only reads, it comes back parsed, and it is bounded.',
  schema: z.object({
    path: z
      .string()
      .optional()
      .describe('File or directory, relative to the workspace. Omit for the whole repository.'),
    count: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(`How many commits, newest first. Default ${DEFAULT_COUNT}, at most ${MAX_COUNT}.`),
  }),
  async run({ path, count = DEFAULT_COUNT }, { cwd, signal }) {
    if (count > MAX_COUNT) {
      return {
        content: `${count} commits is more than this tool returns; ask for ${MAX_COUNT} or fewer`,
        isError: true,
      }
    }

    let inside: string | undefined
    if (path !== undefined) {
      try {
        // Against the real root, not the one we were handed: on macOS a
        // temporary directory is a symlink, and a pathspec resolved through
        // it came out as `../../private/var/…`, which git reads as a path
        // outside the repository and answers with nothing at all.
        inside = relative(realpathSync(cwd), resolveInWorkspace(cwd, path))
      } catch (cause) {
        return { content: cause instanceof Error ? cause.message : String(cause), isError: true }
      }
    }

    // One more than asked for, so "there are more" is known rather than
    // guessed at from a full page.
    const args = ['log', `--max-count=${count + 1}`, `--format=%h${FIELD}%aI${FIELD}%an${FIELD}%s`]
    if (inside !== undefined) args.push('--', inside)

    const git = await run(args, cwd, signal)
    if (git.code !== 0) return refusal(git.stderr, path)

    const lines = git.stdout.split('\n').filter((line) => line !== '')
    if (lines.length === 0) {
      return {
        content:
          path === undefined
            ? 'no commits yet in this repository'
            : `no commits touch ${path} — it may be new, or never committed`,
      }
    }

    const shown = lines.slice(0, count).map((line) => line.split(FIELD).join('  '))
    const more =
      lines.length > count
        ? `\n… and more, past the ${count} asked for; raise count to see them`
        : ''
    return { content: shown.join('\n') + more }
  },
})

/**
 * Why git said no, in words the model can act on.
 *
 * Two answers matter. Not a repository at all is a fact about the workspace
 * and worth saying plainly; a repository with nothing in it yet is what a
 * project looks like ten seconds after `git init`, and git reports that as a
 * bad revision rather than as an empty history.
 */
function refusal(stderr: string, path: string | undefined): { content: string; isError?: true } {
  const said = stderr.trim()
  if (/not a git repository/i.test(said)) {
    return {
      content: 'this workspace is not inside a git repository, so there is no history to read',
      isError: true,
    }
  }
  if (/does not have any commits yet|bad revision|unknown revision/i.test(said)) {
    return {
      content:
        path === undefined
          ? 'no commits yet in this repository'
          : `no commits touch ${path} — it may be new, or never committed`,
    }
  }
  return { content: `git log failed: ${said || 'no reason given'}`, isError: true }
}

async function run(
  args: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ code: number; stdout: string; stderr: string }> {
  // Never through a shell: the arguments carry a model's output, and a shell
  // would give the quoting in them a second meaning.
  const child = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    signal: AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]),
  })

  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}
