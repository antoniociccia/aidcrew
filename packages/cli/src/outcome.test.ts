import { describe, expect, test } from 'bun:test'
import type { TeamEvent } from '@aidcrew/core'
import { exitCodeOf, outcomeOf, summaryOf } from './outcome.ts'

const verified: TeamEvent = { type: 'job_verified', task: 'main', command: 'bun test' }
const merged: TeamEvent = {
  type: 'job_merged',
  task: 'main',
  detail: '1d5c819 Merge branch work/main',
}
const failedOnce: TeamEvent = {
  type: 'job_check_failed',
  task: 'main',
  reason: 'failed',
  command: 'bun test',
  detail: '1 fail',
  again: true,
}
const gaveUp: TeamEvent = { ...failedOnce, again: false }

describe('what became of each job', () => {
  test('a job checked and merged is done', () => {
    const [main] = outcomeOf([verified, merged])

    expect(main).toMatchObject({
      task: 'main',
      verified: 'bun test',
      merged: '1d5c819 Merge branch work/main',
    })
    expect(main?.done).toBe(true)
  })

  test('a check that failed and was then made to pass is still done', () => {
    // The leader was sent back once; what counts is where it ended.
    const [main] = outcomeOf([failedOnce, verified, merged])

    expect(main?.done).toBe(true)
    expect(main?.failures).toBe(1)
  })

  test('a job the harness gave up on is not done, and says why', () => {
    const [main] = outcomeOf([failedOnce, gaveUp])

    expect(main?.done).toBe(false)
    expect(main?.failures).toBe(2)
    // The second failure was the one it gave up on, not another trip back.
    expect(main?.sentBack).toBe(1)
    expect(main?.left).toContain('bun test')
    expect(main?.left).toContain('1 fail')
  })

  test('a job verified but not merged is not done either', () => {
    const [main] = outcomeOf([
      verified,
      { type: 'job_merge_failed', task: 'main', detail: 'CONFLICT in app.ts' },
    ])

    expect(main?.done).toBe(false)
    expect(main?.left).toContain('CONFLICT')
  })

  test('nothing to say for a run that touched nothing', () => {
    expect(outcomeOf([{ type: 'agent_killed', id: 'coder' }])).toEqual([])
  })
})

describe('the exit code of a headless run', () => {
  // A run that exits 0 having done half the work is a green tick on a
  // branch nobody reads again. Only a job every check agreed with exits 0.
  test('is 0 when every job is done, or when there was no job to speak of', () => {
    expect(exitCodeOf(outcomeOf([verified, merged]))).toBe(0)
    expect(exitCodeOf(outcomeOf([]))).toBe(0)
  })

  test('is 2 when a job was left undone', () => {
    expect(exitCodeOf(outcomeOf([failedOnce, gaveUp]))).toBe(2)
    expect(
      exitCodeOf(
        outcomeOf([
          verified,
          merged,
          {
            type: 'job_check_failed',
            task: 'docs',
            reason: 'uncommitted',
            detail: 'a.md',
            again: false,
          },
        ]),
      ),
    ).toBe(2)
  })
})

describe('the summary at the end', () => {
  test('says, per job, what was checked, whether it came home, and what it cost', () => {
    const lines = summaryOf(outcomeOf([failedOnce, verified, merged]), (task) =>
      task === 'main' ? 'this job: 156k tokens, 1.5¢ on glm-5.3-flash' : undefined,
    )

    expect(lines.join('\n')).toContain('main: done')
    expect(lines.join('\n')).toContain('bun test passed')
    expect(lines.join('\n')).toContain('merged')
    expect(lines.join('\n')).toContain('sent back once')
    expect(lines.join('\n')).toContain('156k tokens')
  })

  test('names what was left when a job was not done', () => {
    const lines = summaryOf(outcomeOf([failedOnce, gaveUp]), () => undefined)

    expect(lines.join('\n')).toContain('main: not done')
    expect(lines.join('\n')).toContain('1 fail')
  })
})

describe('what the verdict says about the verification itself', () => {
  test('a job with no check to run is not done, and says what to do', () => {
    const [main] = outcomeOf([
      {
        type: 'job_unverified',
        task: 'main',
        detail: 'no check to run — name one with [defaults] check',
      },
    ])

    expect(main?.done).toBe(false)
    expect(main?.left).toContain('[defaults] check')
    expect(
      exitCodeOf(outcomeOf([{ type: 'job_unverified', task: 'main', detail: 'no check to run' }])),
    ).toBe(2)
  })

  test('a pass that weakened the suite is done, and says so beside the pass', () => {
    const lines = summaryOf(
      outcomeOf([
        {
          type: 'job_verified',
          task: 'main',
          command: 'bun test',
          warnings: ['deleted app.test.ts'],
        },
        merged,
      ]),
      () => undefined,
    )

    expect(lines.join('\n')).toContain('main: done')
    expect(lines.join('\n')).toContain('deleted app.test.ts')
  })

  test('a conflict with the repository is named as what was left', () => {
    const [main] = outcomeOf([
      {
        type: 'job_check_failed',
        task: 'main',
        reason: 'conflict',
        detail: 'app.ts',
        again: false,
      },
    ])

    expect(main?.done).toBe(false)
    expect(main?.left).toContain('app.ts')
  })
})
