import type { TeamEvent } from '@aidcrew/core'

/**
 * What became of each job in a headless run, read off the events.
 *
 * `idle()` says nobody is busy; it does not say the work is done. A run used
 * to exit 0 at that point having done half the job — a green tick on a
 * branch nobody reads again — because the only thing it asked was whether
 * anybody was still waiting. The harness now checks and merges each job, and
 * says so in events; this reads them back into one verdict per job, the exit
 * code a pipeline can trust, and the summary a person can.
 */
export type JobOutcome = {
  task: string
  /** The command that passed, when one did. */
  verified?: string
  /** The merge commit, when the branch came home. */
  merged?: string
  /** How many times a check failed, the last time it was not sent back included. */
  failures: number
  /** How many of those times the leader was sent back to fix it. */
  sentBack: number
  /** What was left undone, in the harness's words, when the job is not done. */
  left?: string
  /** What the branch did to the verification itself, for the review to see. */
  warnings?: string[]
  done: boolean
}

/** One outcome per job that anything happened to, in the order they were first seen. */
export function outcomeOf(events: TeamEvent[]): JobOutcome[] {
  const jobs = new Map<string, JobOutcome>()
  const of = (task: string): JobOutcome => {
    const known = jobs.get(task)
    if (known) return known
    const fresh: JobOutcome = { task, failures: 0, sentBack: 0, done: false }
    jobs.set(task, fresh)
    return fresh
  }

  for (const event of events) {
    if (event.type === 'job_verified') {
      const job = of(event.task)
      job.verified = event.command
      if (event.warnings && event.warnings.length > 0) job.warnings = event.warnings
      delete job.left
    } else if (event.type === 'job_merged') {
      const job = of(event.task)
      job.merged = event.detail
      job.done = true
      delete job.left
    } else if (event.type === 'job_check_failed') {
      const job = of(event.task)
      job.failures += 1
      if (event.again) job.sentBack += 1
      job.done = false
      const what =
        event.reason === 'uncommitted'
          ? `work not committed: ${event.detail}`
          : event.reason === 'conflict'
            ? `the repository conflicts with the branch in ${event.detail}`
            : `${event.command ?? 'the check'} failed: ${event.detail}`
      job.left = event.again ? `${what} (sent back)` : what
    } else if (event.type === 'job_unverified') {
      const job = of(event.task)
      job.done = false
      job.left = `unverified: ${event.detail}`
    } else if (event.type === 'job_merge_failed') {
      const job = of(event.task)
      job.done = false
      job.left = `not merged: ${event.detail}`
    }
  }

  return [...jobs.values()]
}

/** 0 when every job is done or there was none; 2 when a job was left undone. */
export function exitCodeOf(outcomes: JobOutcome[]): 0 | 2 {
  return outcomes.every((job) => job.done) ? 0 : 2
}

/**
 * The lines a person reads at the end: one per job, saying what was checked,
 * whether it came home, how many times it was sent back, and what it cost.
 */
export function summaryOf(
  outcomes: JobOutcome[],
  costOf: (task: string) => string | undefined,
): string[] {
  return outcomes.flatMap((job) => {
    const lines = [`${job.task}: ${job.done ? 'done' : 'not done'}`]
    if (job.verified) lines.push(`  ${job.verified} passed`)
    for (const warning of job.warnings ?? [])
      lines.push(`  but the verification itself changed: ${warning}`)
    if (job.merged) lines.push(`  merged: ${job.merged}`)
    if (job.sentBack > 0) {
      lines.push(
        `  sent back ${job.sentBack === 1 ? 'once' : job.sentBack === 2 ? 'twice' : `${job.sentBack} times`}`,
      )
    }
    if (!job.done && job.left) lines.push(`  left: ${job.left}`)
    const cost = costOf(job.task)
    if (cost) lines.push(`  ${cost}`)
    return lines
  })
}
