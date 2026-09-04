import { existsSync, readdirSync, rmdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { keepStateOutOfGit } from './state-dir.ts'

export type AgentWorkspace = {
  /** The task this checkout belongs to, which several agents may share. */
  taskId: string
  path: string
  /**
   * False when the task shares the project directory with everyone else,
   * which happens outside a git repository. Callers must not treat the two
   * cases as equivalent.
   */
  isolated: boolean
  /**
   * True when the checkout was already there and was picked up rather than
   * made: an earlier session left work in it. Whoever spawns an agent into it
   * should say so, because the agent is starting in the middle of something.
   */
  resumed?: boolean
}

/**
 * What became of a checkout that was asked to go.
 *
 * `kept` is the important one. A worktree with uncommitted changes, or with
 * commits that no branch can reach, is the only copy of that work — removing
 * it is not cleaning up, it is deleting somebody's afternoon.
 */
export type RemoveOutcome = 'removed' | 'kept' | 'none'

/** Where worktrees live: inside the project, but out of the way and gitignored. */
const WORKTREE_ROOT = join('.aidcrew', 'wt')

/**
 * A checkout per task, shared by the agents working on it.
 *
 * It was one per agent, and that was wrong. A team on one job needs to see one
 * another's work: a coder wrote four files and the reviewer, in a checkout of
 * its own, found nothing — so it spent turns hunting and ended up reading
 * absolute paths into somebody else's directory through the shell, which
 * works, wastes a turn each time, and makes the isolation decorative.
 *
 * The boundary that matters is between jobs, not between colleagues. Two tasks
 * running at once must not see each other's half-finished work; two agents on
 * the same task must. Which is how people work: a branch each, not a clone
 * each.
 *
 * Outside a git repository there is nothing to isolate with, so everything
 * shares the project directory and `isolated` says so. Refusing to run there
 * would be unhelpful; claiming isolation that does not exist would be worse.
 */
/** What came of merging a task's branch into the repository. */
export type MergeOutcome = {
  result: 'merged' | 'up-to-date' | 'conflict' | 'not isolated' | 'no branch'
  /** The merge commit, the reason, or the conflict, in git's words. */
  detail: string
}

/** The branch a task's checkout is on: made with it, kept after it. */
export function branchOf(taskId: string): string {
  return `work/${taskId}`
}

export class WorkspaceManager {
  readonly #root: string
  readonly #workspaces = new Map<string, AgentWorkspace>()
  #isRepo: boolean | undefined

  constructor(root: string) {
    this.#root = root
  }

  async create(taskId: string): Promise<AgentWorkspace> {
    // Made once per task and handed out again after that: the second agent on
    // a job joins the first rather than starting somewhere else.
    const existing = this.#workspaces.get(taskId)
    if (existing) return existing

    const workspace = (await this.#gitAvailable())
      ? await this.#createWorktree(taskId)
      : { taskId, path: this.#root, isolated: false }

    this.#workspaces.set(taskId, workspace)
    return workspace
  }

  /** What this agent changed, against the commit its worktree started from. */
  async diff(taskId: string): Promise<string> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return ''

    const tracked = await this.#git(['diff'], workspace.path)
    const untracked = await this.#git(
      ['ls-files', '--others', '--exclude-standard'],
      workspace.path,
    )

    if (untracked.trim() === '') return tracked
    const listed = untracked
      .trim()
      .split('\n')
      .map((file) => `+++ new file: ${file}`)
      .join('\n')
    return tracked === '' ? listed : `${tracked}\n${listed}`
  }

  /**
   * Lets a task's checkout go — unless the work in it would go with it.
   *
   * Every worktree used to be removed with `--force` when the session ended,
   * on the theory that the diff had already travelled with the handoff.
   * Watched, on a real run: a coder built a whole project over two hours,
   * never committed, the person closed the terminal for the evening, and the
   * next morning the checkout was an empty directory. Nothing had travelled
   * anywhere. So a checkout with uncommitted changes, or with commits on no
   * branch, stays where it is and is picked up by the next session; only a
   * clean one, or one whose work a branch already holds, is taken away.
   */
  async remove(taskId: string): Promise<RemoveOutcome> {
    const workspace = this.#workspaces.get(taskId)
    this.#workspaces.delete(taskId)
    if (!workspace?.isolated) return 'none'

    if (await this.#holdsWork(workspace.path)) return 'kept'

    // --force because a clean checkout can still have build output and the
    // like in it, which git would otherwise stop to ask about.
    await this.#git(['worktree', 'remove', '--force', workspace.path])
    return 'removed'
  }

  /** Every checkout, at the end of a session; says which ones it left. */
  async removeAll(): Promise<{ kept: AgentWorkspace[] }> {
    const kept: AgentWorkspace[] = []
    for (const taskId of [...this.#workspaces.keys()]) {
      const workspace = this.#workspaces.get(taskId)
      if ((await this.remove(taskId)) === 'kept' && workspace) kept.push(workspace)
    }
    return { kept }
  }

  /** Whether a task's checkout holds anything that only it holds. */
  async hasWork(taskId: string): Promise<boolean> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return false
    return this.#holdsWork(workspace.path)
  }

  /** Files changed in a task's checkout and not committed. */
  async changed(taskId: string): Promise<number> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return 0
    const status = await this.#status(workspace.path)
    return status === '' ? 0 : status.split('\n').length
  }

  /**
   * What is changed in a checkout, leaving out what the harness put there.
   *
   * The guard keeps its undo snapshots under `.aidcrew/` in the agent's own
   * directory, and a project that has not committed an ignore rule for it
   * shows them as untracked. Counted, every checkout held "work" for ever and
   * every handoff's diff began with `+++ new file: .aidcrew/undo/…`.
   */
  async #status(path: string): Promise<string> {
    return (
      await this.#git(['status', '--porcelain', '--', '.', ':(exclude).aidcrew'], path)
    ).trim()
  }

  list(): AgentWorkspace[] {
    return [...this.#workspaces.values()]
  }

  /**
   * How many commits an agent's copy is behind the repository.
   *
   * Zero for one that is current, and for one that has no worktree of its own.
   */
  async behind(taskId: string): Promise<number> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return 0

    const at = (await this.#git(['rev-parse', 'HEAD'], workspace.path)).trim()
    if (at === '') return 0

    const count = (await this.#git(['rev-list', '--count', `${at}..HEAD`])).trim()
    return Number.parseInt(count, 10) || 0
  }

  /**
   * Brings an agent's worktree up to what the repository says now.
   *
   * A worktree is made once and then stands still, so an agent's view of the
   * code ages from the moment it was spawned. One left running through an
   * afternoon read the repository as it had been that morning, diagnosed
   * problems that had been fixed hours earlier, and wrote a careful, specific,
   * entirely wrong plan — which is worse than an agent that says it does not
   * know, because it is convincing.
   *
   * Only when it has nothing of its own. An agent mid-task has uncommitted
   * work in there, and moving the ground under it would destroy exactly what
   * it was asked to produce.
   */
  async refresh(taskId: string): Promise<'moved' | 'kept' | 'not isolated'> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return 'not isolated'

    if ((await this.#status(workspace.path)) !== '') return 'kept'

    const head = (await this.#git(['rev-parse', 'HEAD'])).trim()
    const at = (await this.#git(['rev-parse', 'HEAD'], workspace.path)).trim()
    // `at` empty means the checkout does not answer — deleted by hand, or
    // never made. Reporting a move nobody could have made would be a lie in
    // the one place a person looks to find out whether it happened.
    if (head === '' || at === '' || head === at) return 'kept'
    // Commits of its own — on its branch, reachable from nowhere the
    // repository has moved to — are work, whatever the status says.
    const behind = await this.#run(['merge-base', '--is-ancestor', at, head], workspace.path)
    if (behind.code !== 0) return 'kept'

    // Nothing of the agent's can be lost by this: it had nothing. On the
    // task's branch the branch itself moves; a detached checkout moves alone.
    const onBranch = (await this.#git(['symbolic-ref', '--quiet', 'HEAD'], workspace.path)).trim()
    if (onBranch !== '') await this.#git(['reset', '--hard', '--quiet', head], workspace.path)
    else await this.#git(['checkout', '--detach', '--quiet', head], workspace.path)
    return 'moved'
  }

  async #createWorktree(taskId: string): Promise<AgentWorkspace> {
    const path = join(this.#root, WORKTREE_ROOT, taskId)

    // Left by an earlier session, with work in it: picked up, not replaced.
    // This is the other half of `remove` keeping it.
    if (await this.#isWorktree(path)) return { taskId, path, isolated: true, resumed: true }

    // A checkout somebody deleted by hand is still on git's list — "missing
    // but already registered" — and git refuses to add another at that path
    // until told to prune. An empty directory in the way is the same story
    // from the other side. Both used to fail the add silently.
    keepStateOutOfGit(this.#root)
    await this.#git(['worktree', 'prune'])
    if (existsSync(path) && readdirSync(path).length === 0) rmdirSync(path)

    // On a branch made for the task, so a commit in the checkout is safe from
    // the moment it is made. The checkout used to start detached, which left
    // committing to a branch to the agent — the step most often skipped, and
    // the one whose omission cost the most. A branch left by an earlier
    // session is taken up again, work and all; one git will not hand over
    // (checked out somewhere else) leaves a detached checkout as before.
    const branch = branchOf(taskId)
    if (await this.#branchExists(branch)) {
      await this.#git(['worktree', 'add', '--quiet', path, branch])
    } else {
      await this.#git(['worktree', 'add', '--quiet', '-b', branch, path, 'HEAD'])
    }
    if (!(await this.#isWorktree(path))) {
      await this.#git(['worktree', 'add', '--detach', '--quiet', path, 'HEAD'])
    }

    // Checked, because git can decline and this used to believe it had not.
    // The commonest reason is the commonest repository: `git worktree add
    // --detach <path> HEAD` fails with `fatal: invalid reference: HEAD` when
    // nothing has been committed yet, which is what a project looks like ten
    // seconds after `git init`.
    //
    // The failure was swallowed and the path returned anyway, marked
    // isolated — so every tool the agent called failed on a directory that
    // had never been made, for ever, with nothing to say why. Sharing the
    // project directory is the same answer as for somewhere that is not a
    // repository at all: worse than a checkout, and honest.
    if (!(await this.#isWorktree(path))) return { taskId, path: this.#root, isolated: false }

    return { taskId, path, isolated: true }
  }

  /**
   * Whether a directory is the root of a checkout of this repository.
   *
   * Asked of git rather than of the filesystem: a plain directory under the
   * project is "inside a work tree" too, so the question is whether the
   * checkout's own root is this path.
   */
  async #isWorktree(path: string): Promise<boolean> {
    if (!existsSync(path)) return false
    const top = (await this.#git(['rev-parse', '--show-toplevel'], path)).trim()
    return top !== '' && resolve(top) === resolve(path)
  }

  /**
   * Whether a checkout holds work that exists nowhere else.
   *
   * Two ways it can: files changed and not committed, and commits made on the
   * detached HEAD the worktree started on — reachable from no branch, so they
   * go with the directory. A checkout git cannot answer for is treated as
   * holding work, because the cost of the two mistakes is not symmetrical.
   */
  async #holdsWork(path: string): Promise<boolean> {
    if (!existsSync(path)) return false
    if ((await this.#status(path)) !== '') return true
    const head = (await this.#git(['rev-parse', 'HEAD'], path)).trim()
    if (head === '') return true
    // `for-each-ref` rather than `branch --contains`, which answers a detached
    // checkout with "(no branch)" — a line, and so a branch, to anything that
    // only checks for output.
    const holding = await this.#git(
      ['for-each-ref', '--contains', head, '--format=%(refname)', 'refs/heads'],
      path,
    )
    return holding.trim() === ''
  }

  /** Commits on a task's branch that the repository's own HEAD does not have. */
  async ahead(taskId: string): Promise<number> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return 0
    const branch = branchOf(taskId)
    if (!(await this.#branchExists(branch))) return 0
    const count = (await this.#git(['rev-list', '--count', `HEAD..${branch}`])).trim()
    return count === '' ? 0 : Number(count)
  }

  /** The files changed and not committed in a task's checkout, as git lists them. */
  async changedFiles(taskId: string): Promise<string[]> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) return []
    const status = await this.#status(workspace.path)
    return status === '' ? [] : status.split('\n').map((line) => line.slice(3).trim())
  }

  /**
   * Merges a task's branch into the repository, or says why not.
   *
   * The step that went missing most often was this one: work committed, on a
   * branch, verified, and reaching nobody, because merging was left to a
   * model with a shell and a paragraph of instructions. A merge that
   * conflicts is backed out at once, so the repository is left exactly as it
   * was, with the conflict named for whoever will resolve it.
   */
  async merge(taskId: string): Promise<MergeOutcome> {
    const workspace = this.#workspaces.get(taskId)
    if (!workspace?.isolated) {
      return {
        result: 'not isolated',
        detail: 'this task shares the project directory, so there is nothing to merge',
      }
    }
    const branch = branchOf(taskId)
    if (!(await this.#branchExists(branch))) {
      return { result: 'no branch', detail: `${branch} does not exist` }
    }

    const attempt = await this.#run(['merge', '--no-ff', '--no-edit', branch])
    if (attempt.code === 0) {
      if (/Already up to date/.test(attempt.out)) {
        return { result: 'up-to-date', detail: `${branch} has nothing the repository does not` }
      }
      return { result: 'merged', detail: (await this.#git(['log', '-1', '--oneline'])).trim() }
    }

    // Best effort: when the merge never started there is nothing to abort,
    // and git says so to nobody.
    await this.#run(['merge', '--abort'])
    return { result: 'conflict', detail: `${attempt.out}${attempt.err}`.trim() }
  }

  async #branchExists(branch: string): Promise<boolean> {
    const found = await this.#run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
    return found.code === 0
  }

  /** Like #git, but with the exit code and stderr, for the calls that need a verdict. */
  async #run(
    args: string[],
    cwd = this.#root,
  ): Promise<{ code: number; out: string; err: string }> {
    try {
      const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { code, out, err }
    } catch (cause) {
      return { code: -1, out: '', err: cause instanceof Error ? cause.message : String(cause) }
    }
  }

  async #gitAvailable(): Promise<boolean> {
    if (this.#isRepo !== undefined) return this.#isRepo
    const inside = await this.#git(['rev-parse', '--is-inside-work-tree'])
    this.#isRepo = inside.trim() === 'true'
    return this.#isRepo
  }

  /**
   * Returns stdout, or an empty string if git failed for any reason.
   *
   * Including the reasons that throw instead of exiting non-zero: git missing
   * from the PATH, or a checkout deleted from under us, both of which surface
   * as ENOENT out of the spawn itself. This is called from a sweep that runs
   * on a timer, so an error escaping here painted a stack trace over the
   * interface every few seconds with nothing a person could do about it.
   */
  async #git(args: string[], cwd = this.#root): Promise<string> {
    try {
      const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
      const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      return code === 0 ? out : ''
    } catch {
      return ''
    }
  }
}
