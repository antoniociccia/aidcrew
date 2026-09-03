import { describe, expect, test } from 'bun:test'
import { describeTask, readTasks } from './tasks.ts'

/** Answers the git commands `readTasks` asks, and records what was asked. */
function fakeGit(answers: Record<string, string>, asked: string[] = []) {
  return async (args: string[], cwd?: string): Promise<string> => {
    const key = `${args.join(' ')}${cwd ? ` @${cwd}` : ''}`
    asked.push(key)
    return answers[key] ?? ''
  }
}

const LISTED = `worktree /repo
HEAD aaaa111
branch refs/heads/main

worktree /repo/.aidcrew/wt/auth
HEAD bbbb222
detached

worktree /repo/.aidcrew/wt/billing
HEAD aaaa111
detached
`

describe('reading the jobs a repository has open', () => {
  test('lists the worktrees, and the repository among them', async () => {
    // Working in the repository itself is a legitimate choice, and leaving it
    // out of the list would make it the option nobody can see.
    const tasks = await readTasks(
      '/repo',
      fakeGit({
        'worktree list --porcelain': LISTED,
        'rev-parse HEAD': 'aaaa111\n',
      }),
    )

    expect(tasks.map((task) => task.name)).toEqual(['main', 'auth', 'billing'])
    expect(tasks[0]?.main).toBe(true)
  })

  test('the main job\'s own checkout is the repository\'s row, not a second "main"', async () => {
    // Agents on the main job work in `.aidcrew/wt/main`, and that checkout now
    // outlives the session. Listed on its own it was a second row called
    // `main` under the first, and the one with the work in it was the one
    // that said nothing about being the repository.
    const tasks = await readTasks(
      '/repo',
      fakeGit({
        'worktree list --porcelain': `${LISTED}\nworktree /repo/.aidcrew/wt/main\nHEAD aaaa111\ndetached\n`,
        'rev-parse HEAD': 'aaaa111\n',
        'status --porcelain @/repo/.aidcrew/wt/main': ' M app.ts\n?? new.ts\n',
      }),
    )

    expect(tasks.map((task) => task.name)).toEqual(['main', 'auth', 'billing'])
    expect(tasks[0]).toMatchObject({ main: true, changed: 2, path: '/repo/.aidcrew/wt/main' })
  })

  test('says how much unfinished work is in each', async () => {
    // The first of the two questions somebody choosing has: is there already
    // work in here.
    const tasks = await readTasks(
      '/repo',
      fakeGit({
        'worktree list --porcelain': LISTED,
        'rev-parse HEAD': 'aaaa111\n',
        'status --porcelain @/repo/.aidcrew/wt/auth': ' M src/a.ts\n?? src/b.ts\n',
      }),
    )

    expect(tasks.find((task) => task.name === 'auth')?.changed).toBe(2)
    expect(tasks.find((task) => task.name === 'billing')?.changed).toBe(0)
  })

  test('says how far behind the repository each one is', async () => {
    // The second question: is what I would be working from still current.
    const tasks = await readTasks(
      '/repo',
      fakeGit({
        'worktree list --porcelain': LISTED,
        'rev-parse HEAD': 'aaaa111\n',
        'rev-list --count bbbb222..HEAD': '4\n',
      }),
    )

    expect(tasks.find((task) => task.name === 'auth')?.behind).toBe(4)
    // Already at the tip, so nothing is asked and nothing is behind.
    expect(tasks.find((task) => task.name === 'billing')?.behind).toBe(0)
  })

  test('leaves alone a worktree this program did not make', async () => {
    // Somebody else's worktree, in some other directory, is theirs.
    const tasks = await readTasks(
      '/repo',
      fakeGit({
        'worktree list --porcelain': `worktree /repo\nHEAD aaaa111\nbranch refs/heads/main\n\nworktree /elsewhere/experiment\nHEAD cccc333\ndetached\n`,
        'rev-parse HEAD': 'aaaa111\n',
      }),
    )

    expect(tasks.map((task) => task.name)).toEqual(['main'])
  })

  test('a repository with nothing open still has itself', async () => {
    const tasks = await readTasks(
      '/repo',
      fakeGit({
        'worktree list --porcelain': 'worktree /repo\nHEAD aaaa111\nbranch refs/heads/main\n',
        'rev-parse HEAD': 'aaaa111\n',
      }),
    )

    expect(tasks).toHaveLength(1)
  })
})

describe('what to say about a task', () => {
  const task = { name: 'auth', path: '/x', head: 'b', changed: 0, behind: 0, main: false }

  test('the two numbers that decide whether to work in it', () => {
    expect(describeTask({ ...task, changed: 3, behind: 2 })).toBe('3 changed, 2 behind')
  })

  test('says it is clean rather than saying nothing', () => {
    expect(describeTask(task)).toBe('clean')
    expect(describeTask({ ...task, main: true })).toBe('the repository itself')
  })
})
