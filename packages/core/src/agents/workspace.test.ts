import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceManager } from './workspace.ts'

let repo: string

async function git(args: string[], cwd = repo): Promise<string> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  })
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  if (code !== 0)
    throw new Error(`git ${args.join(' ')} failed: ${await new Response(proc.stderr).text()}`)
  return out
}

beforeEach(async () => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-wt-')))
  await git(['init', '-q', '-b', 'main'])
  writeFileSync(join(repo, 'app.ts'), 'export const version = 1\n')
  await git(['add', '.'])
  await git(['commit', '-qm', 'initial'])
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

/**
 * Work in a checkout outlives the session that made it.
 *
 * Every worktree used to be removed with `--force` when the session ended, on
 * the theory that the diff had already travelled with the handoff. Watched, on
 * a real run: a coder built a whole project over two hours, never committed,
 * the person closed the terminal for the evening, and the next morning the
 * checkout was an empty directory. Nothing had travelled anywhere. A harness
 * that destroys uncommitted work on exit is a harness people learn not to
 * close, which is worse than a directory left on disk.
 */
describe('work in a checkout outlives the session', () => {
  test('a checkout with uncommitted work in it stays when its task is removed', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('main')
    writeFileSync(join(workspace.path, 'new.ts'), 'export const fresh = true\n')

    const outcome = await manager.remove('main')

    expect(outcome).toBe('kept')
    expect(readFileSync(join(workspace.path, 'new.ts'), 'utf8')).toBe('export const fresh = true\n')
  })

  test('a commit made in a checkout lands on the branch made for its task, which is what keeps it', async () => {
    // The checkout used to start on a detached HEAD, so a commit in it was on
    // no branch and went with the directory — unless every agent remembered
    // to make a branch first, which is the step they most often skipped.
    // Now the branch is made with the checkout, and a commit is safe by
    // default: the checkout can go, the branch stays.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('main')
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'bump'], workspace.path)

    expect(await manager.remove('main')).toBe('removed')
    expect(existsSync(workspace.path)).toBe(false)
    expect(await git(['log', '--oneline', 'work/main'])).toContain('bump')
  })

  test('what the harness itself leaves in a checkout does not count as work', async () => {
    // The guard keeps its undo snapshots under `.aidcrew/` in the agent's
    // directory, and a project that has not committed an ignore rule for it
    // shows them as untracked. Counted as work, every checkout was kept for
    // ever and every diff began with `+++ new file: .aidcrew/undo/…`.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('main')
    mkdirSync(join(workspace.path, '.aidcrew', 'undo'), { recursive: true })
    writeFileSync(join(workspace.path, '.aidcrew', 'undo', 'journal.jsonl'), '{}\n')

    expect(await manager.changed('main')).toBe(0)
    expect(await manager.remove('main')).toBe('removed')
  })

  test('a clean checkout goes, as it always did', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('main')

    expect(await manager.remove('main')).toBe('removed')
    expect(existsSync(workspace.path)).toBe(false)
  })

  test('a checkout whose work is on a branch goes, because the branch keeps it', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('main')
    await git(['switch', '-qc', 'work/bump'], workspace.path)
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'bump'], workspace.path)

    expect(await manager.remove('main')).toBe('removed')
    expect(existsSync(workspace.path)).toBe(false)
    expect(await git(['branch', '--list', 'work/bump'])).toContain('work/bump')
  })

  test('removing everything says what it kept', async () => {
    const manager = new WorkspaceManager(repo)
    const kept = await manager.create('with-work')
    await manager.create('clean')
    writeFileSync(join(kept.path, 'new.ts'), '')

    const outcome = await manager.removeAll()

    expect(outcome.kept.map((one) => one.taskId)).toEqual(['with-work'])
    expect(existsSync(kept.path)).toBe(true)
  })

  test('the next session picks the checkout up where it was left', async () => {
    const earlier = new WorkspaceManager(repo)
    const before = await earlier.create('main')
    writeFileSync(join(before.path, 'new.ts'), 'left behind\n')
    await earlier.removeAll()

    const later = new WorkspaceManager(repo)
    const after = await later.create('main')

    expect(after.path).toBe(before.path)
    expect(after.isolated).toBe(true)
    expect(after.resumed).toBe(true)
    expect(readFileSync(join(after.path, 'new.ts'), 'utf8')).toBe('left behind\n')
  })

  test('a checkout made fresh is not called resumed', async () => {
    const manager = new WorkspaceManager(repo)

    expect((await manager.create('main')).resumed).toBeFalsy()
  })

  test('a checkout somebody deleted by hand is made again rather than refused', async () => {
    // git still lists it — "missing but already registered" — and refuses to
    // add another at the same path until told to prune. That refusal used to
    // leave the agent with the project directory and no isolation, silently.
    const earlier = new WorkspaceManager(repo)
    const before = await earlier.create('main')
    writeFileSync(join(before.path, 'new.ts'), '')
    rmSync(before.path, { recursive: true, force: true })

    const later = new WorkspaceManager(repo)
    const after = await later.create('main')

    expect(after.isolated).toBe(true)
    expect(after.path).toBe(before.path)
    expect(existsSync(join(after.path, 'app.ts'))).toBe(true)
  })
})

describe('WorkspaceManager in a git repository', () => {
  test('gives a task a worktree of its own', async () => {
    const manager = new WorkspaceManager(repo)

    const workspace = await manager.create('main')

    expect(workspace.isolated).toBe(true)
    expect(existsSync(join(workspace.path, 'app.ts'))).toBe(true)
    expect(workspace.path).not.toBe(repo)

    await manager.removeAll()
  })

  test('everyone on one task gets the same checkout', async () => {
    // A team on one job has to see one another's work. Asking twice for the
    // same task is the second agent joining the first, not starting somewhere
    // else — which is what made a reviewer unable to find what a coder wrote.
    const manager = new WorkspaceManager(repo)
    const first = await manager.create('main')
    const second = await manager.create('main')

    expect(second.path).toBe(first.path)

    writeFileSync(join(first.path, 'app.ts'), 'export const version = 2\n')
    expect(readFileSync(join(second.path, 'app.ts'), 'utf8')).toBe('export const version = 2\n')

    await manager.removeAll()
  })

  test('keeps one task invisible to another', async () => {
    // The boundary that matters: two jobs running at once must not see each
    // other's half-finished work.
    const manager = new WorkspaceManager(repo)
    const coder = await manager.create('auth')
    const reviewer = await manager.create('billing')

    writeFileSync(join(coder.path, 'app.ts'), 'export const version = 2\n')

    expect(readFileSync(join(reviewer.path, 'app.ts'), 'utf8')).toBe('export const version = 1\n')
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toBe('export const version = 1\n')

    await manager.removeAll()
  })

  test('shows what an agent changed', async () => {
    const manager = new WorkspaceManager(repo)
    const coder = await manager.create('coder')
    writeFileSync(join(coder.path, 'app.ts'), 'export const version = 2\n')

    const diff = await manager.diff('coder')

    expect(diff).toContain('-export const version = 1')
    expect(diff).toContain('+export const version = 2')

    await manager.removeAll()
  })

  test('reports no changes for an agent that touched nothing', async () => {
    const manager = new WorkspaceManager(repo)
    await manager.create('idle')

    expect(await manager.diff('idle')).toBe('')

    await manager.removeAll()
  })

  test('removes the worktree it created', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('temp')

    await manager.remove('temp')

    expect(existsSync(workspace.path)).toBe(false)
  })

  test('cleans up every worktree at the end of a session', async () => {
    const manager = new WorkspaceManager(repo)
    const paths = [await manager.create('a'), await manager.create('b')].map((w) => w.path)

    await manager.removeAll()

    for (const path of paths) expect(existsSync(path)).toBe(false)
  })

  test('reuses the existing worktree when an agent is created twice', async () => {
    const manager = new WorkspaceManager(repo)

    const first = await manager.create('coder')
    const second = await manager.create('coder')

    expect(second.path).toBe(first.path)

    await manager.removeAll()
  })

  test('keeps worktrees out of the way, under .aidcrew', async () => {
    const manager = new WorkspaceManager(repo)

    const workspace = await manager.create('coder')

    expect(workspace.path).toContain('.aidcrew')

    await manager.removeAll()
  })
})

describe('WorkspaceManager outside a git repository', () => {
  let plain: string

  beforeEach(() => {
    plain = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-plain-')))
  })

  afterEach(() => rmSync(plain, { recursive: true, force: true }))

  test('falls back to the shared directory and says it is not isolated', async () => {
    // Refusing to run would be worse; pretending it is isolated would be far
    // worse still, because agents would quietly overwrite each other.
    const manager = new WorkspaceManager(plain)

    const workspace = await manager.create('coder')

    expect(workspace.isolated).toBe(false)
    expect(workspace.path).toBe(plain)
  })

  test('has no diff to show without git', async () => {
    const manager = new WorkspaceManager(plain)
    await manager.create('coder')

    expect(await manager.diff('coder')).toBe('')
  })

  test('carries on when the checkout it was given is gone', async () => {
    // Running git *in* a directory that no longer exists throws rather than
    // exiting non-zero, and this promised an empty string "if git failed for
    // any reason". It did not: the error came out of the periodic sweep and
    // printed a stack trace over the whole interface, again and again.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('vanishing')
    rmSync(workspace.path, { recursive: true, force: true })

    try {
      expect(await manager.behind('vanishing')).toBe(0)
      expect(await manager.diff('vanishing')).toBe('')
      expect(await manager.refresh('vanishing')).toBe('kept')
    } finally {
      await manager.removeAll()
    }
  })
})

describe('keeping an agent up to date with the repository', () => {
  test('moves a worktree that has nothing of its own onto the newest commit', async () => {
    // A worktree stands still from the moment it is made. One left running
    // through an afternoon read the repository as it had been that morning
    // and wrote a careful, specific, entirely wrong plan.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')

    writeFileSync(join(repo, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-aqm', 'moved on'])

    expect(await manager.refresh('coder')).toBe('moved')
    expect(readFileSync(join(workspace.path, 'app.ts'), 'utf8')).toContain('version = 2')

    await manager.removeAll()
  })

  test('leaves a worktree alone when the agent has work in it', async () => {
    // Mid-task there is uncommitted work in there, and moving the ground under
    // it would destroy exactly what the agent was asked to produce.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')
    writeFileSync(join(workspace.path, 'app.ts'), 'half a change\n')

    await git(['commit', '-aqm', 'moved on', '--allow-empty'])

    expect(await manager.refresh('coder')).toBe('kept')
    expect(readFileSync(join(workspace.path, 'app.ts'), 'utf8')).toBe('half a change\n')

    await manager.removeAll()
  })

  test('says there is nothing to do when it is already current', async () => {
    const manager = new WorkspaceManager(repo)
    await manager.create('coder')

    expect(await manager.refresh('coder')).toBe('kept')

    await manager.removeAll()
  })

  test('says so for an agent that has no worktree of its own', async () => {
    // Outside a repository there is nothing to be behind, and nothing to move.
    const plain = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-plain-')))
    try {
      const manager = new WorkspaceManager(plain)
      await manager.create('coder')

      expect(await manager.refresh('coder')).toBe('not isolated')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

/**
 * A repository with nothing in it yet.
 *
 * `git worktree add --detach <path> HEAD` fails with `fatal: invalid
 * reference: HEAD` when nothing has been committed — and that is the most
 * likely repository there is: you make a project, run `git init`, and put the
 * team on it.
 *
 * The failure was swallowed, so `create` handed back a path to a directory
 * that had never been made and said it was isolated. Every tool then failed on
 * it, for ever, and the agent had no way to learn why. Watched: a whole turn
 * spent against `…/shop/.aidcrew/wt/main`, which git had declined to create.
 */
describe('a repository with no commits', () => {
  let repo: string

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-empty-')))
    Bun.spawnSync(['git', 'init', '-q'], { cwd: repo })
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('shares the project directory rather than promising a checkout', async () => {
    const workspace = await new WorkspaceManager(repo).create('main')

    expect(workspace.path).toBe(repo)
    expect(workspace.isolated).toBe(false)
  })

  test('never hands back a directory that is not there', async () => {
    // The whole of the bug: `isolated: true` and a path nothing created.
    const workspace = await new WorkspaceManager(repo).create('main')

    expect(existsSync(workspace.path)).toBe(true)
  })

  test('isolates properly once there is something to check out', async () => {
    Bun.spawnSync(
      [
        'git',
        '-c',
        'user.email=t@t',
        '-c',
        'user.name=t',
        'commit',
        '-qm',
        'first',
        '--allow-empty',
      ],
      { cwd: repo },
    )

    const workspace = await new WorkspaceManager(repo).create('main')

    expect(workspace.isolated).toBe(true)
    expect(existsSync(workspace.path)).toBe(true)
  })
})

describe('the state directory the first checkout is made under', () => {
  test('is kept out of git before the checkout exists', async () => {
    // `.aidcrew/wt/` is a directory of whole checkouts. Without an ignore
    // file beside it, `git add .aidcrew` — the way a team is shared — adds
    // every file of every worktree to the repository a second time.
    const manager = new WorkspaceManager(repo)

    await manager.create('t')

    const ignore = readFileSync(join(repo, '.aidcrew', '.gitignore'), 'utf8')
    expect(ignore).toContain('wt/')
    expect(ignore).toContain('undo/')
  })
})

describe('the branch a task works on', () => {
  test('is made with the checkout and named for the task', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')

    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], workspace.path)).trim()).toBe(
      'work/coder',
    )

    await manager.removeAll()
  })

  test('is picked up again when the checkout is made again', async () => {
    // The checkout goes at the end of a session; the branch does not. The
    // next session's checkout for the same task starts from the branch, so
    // the work is where the agent left it and not where the repository was.
    const manager = new WorkspaceManager(repo)
    const first = await manager.create('coder')
    writeFileSync(join(first.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'bump'], first.path)
    await manager.removeAll()

    const again = await new WorkspaceManager(repo).create('coder')

    expect(readFileSync(join(again.path, 'app.ts'), 'utf8')).toContain('version = 2')
    expect((await git(['rev-parse', '--abbrev-ref', 'HEAD'], again.path)).trim()).toBe('work/coder')
  })

  test('is left alone by a refresh when it has commits of its own', async () => {
    // Moving a checkout onto the repository's newest commit is only safe when
    // the checkout has nothing the repository does not; a branch with its own
    // commits is exactly that, even with a clean status.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'theirs'], workspace.path)
    writeFileSync(join(repo, 'other.ts'), 'export const other = 1\n')
    await git(['add', '.'])
    await git(['commit', '-qm', 'moved on'])

    expect(await manager.refresh('coder')).toBe('kept')
    expect(readFileSync(join(workspace.path, 'app.ts'), 'utf8')).toContain('version = 2')

    await manager.removeAll()
  })
})

describe('bringing a task home', () => {
  test('merges its branch into the repository and says so', async () => {
    // The step that went missing most often was the last one: the work was
    // committed, on a branch, verified, and reached nobody, because merging
    // was left to a model with a shell. It is the harness's to do.
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'bump'], workspace.path)

    const outcome = await manager.merge('coder')

    expect(outcome.result).toBe('merged')
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toContain('version = 2')
    expect(await git(['log', '--oneline', '-1'])).toMatch(/Merge branch 'work\/coder'/)

    await manager.removeAll()
  })

  test('says when there is nothing to bring', async () => {
    const manager = new WorkspaceManager(repo)
    await manager.create('coder')

    expect((await manager.merge('coder')).result).toBe('up-to-date')

    await manager.removeAll()
  })

  test('backs out of a merge that conflicts, leaving the repository as it was', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'theirs'], workspace.path)
    writeFileSync(join(repo, 'app.ts'), 'export const version = 3\n')
    await git(['commit', '-qam', 'ours'])

    const outcome = await manager.merge('coder')

    expect(outcome.result).toBe('conflict')
    expect(outcome.detail).toContain('app.ts')
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toContain('version = 3')
    expect(await git(['status', '--porcelain', '--', '.', ':(exclude).aidcrew'])).toBe('')

    await manager.removeAll()
  })

  test('has nothing to merge for a task that shares the project directory', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'aidcrew-plain-'))
    const manager = new WorkspaceManager(plain)
    await manager.create('coder')

    expect((await manager.merge('coder')).result).toBe('not isolated')
  })
})

describe('a checkout that moved to a branch of its own', () => {
  // The branch made for the job is a default, not a cage: an agent that makes
  // its own branch inside its checkout has not left the job. What the harness
  // counts, and what it merges, is the branch the checkout is actually on.
  test('its commits count as the job being ahead', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')
    await git(['switch', '-qc', 'work/coder-own'], workspace.path)
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'theirs'], workspace.path)

    expect(await manager.ahead('coder')).toBe(1)

    await manager.removeAll()
  })

  test('and that branch is the one merged', async () => {
    const manager = new WorkspaceManager(repo)
    const workspace = await manager.create('coder')
    await git(['switch', '-qc', 'work/coder-own'], workspace.path)
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'theirs'], workspace.path)

    const outcome = await manager.merge('coder')

    expect(outcome.result).toBe('merged')
    expect(outcome.detail).toContain('work/coder-own')
    expect(readFileSync(join(repo, 'app.ts'), 'utf8')).toContain('version = 2')

    await manager.removeAll()
  })
})

describe('bringing a task home where git has no identity', () => {
  test("still merges, under a name of the harness's own", async () => {
    // A merge commit needs an author, and a fresh machine — a CI runner, a
    // container, a laptop on its first day — has told git nothing. The
    // harness merging on somebody's behalf should not fail on their behalf.
    const nobody = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const manager = new WorkspaceManager(repo, { env: nobody })
    const workspace = await manager.create('coder')
    writeFileSync(join(workspace.path, 'app.ts'), 'export const version = 2\n')
    await git(['commit', '-qam', 'bump'], workspace.path)

    const outcome = await manager.merge('coder')

    expect(outcome.result).toBe('merged')
    expect(await git(['log', '-1', '--format=%an <%ae>'], repo)).toContain('aidcrew')

    await manager.removeAll()
  })
})
