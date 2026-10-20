import { fileOf, taskOf } from './worktree.ts'

/**
 * Two agents about to edit the same lines, seen before git sees them.
 *
 * Every agent works in a checkout of its own, so nothing stops two of them
 * rewriting the same function at once — and nothing says so either, until the
 * second branch comes home and the merge fails. That is the most expensive
 * moment to find out: both turns have been paid for, and one of them has to
 * be done again.
 *
 * So the writes are watched. An agent's changed line ranges are remembered
 * while its job is open, and a write that lands on somebody else's ranges is
 * reported at once — to the person, and to both agents, who are the ones who
 * can do anything about it.
 *
 * Nothing is blocked. This repository says a guard that blocks the task gets
 * turned off within the hour, and it is right.
 */

export type Open = {
  agentId: string
  /** As the journal has it: the checkout is part of the path. */
  path: string
  ranges: [number, number][]
  at: number
}

export type Collision = {
  /** The file itself, which is what the two agents have in common. */
  file: string
  /** Whoever just wrote. */
  mine: string
  /** Whoever was already there. */
  theirs: string
  lines: [number, number]
  theirLines: [number, number]
  /** The job the other one is working in, when it is not the repository. */
  task?: string
  /** When the other one touched these lines. */
  since: number
}

/**
 * Lines this far apart still count as the same place.
 *
 * A merge does not compare line numbers, it compares regions with context
 * around them: two edits three lines apart are one conflict to git. Reporting
 * them as unrelated would be technically true and practically useless.
 */
const SLACK = 3

export function createRadar(slack = SLACK) {
  /** Where each agent has been, by file. Emptied when its job comes home. */
  const open = new Map<
    string,
    Map<string, { ranges: [number, number][]; at: number; path: string }>
  >()
  /** Pairs already reported, so a run of writes says it once. */
  const told = new Set<string>()

  return {
    /**
     * Records a write and answers with whatever it has just run into.
     *
     * The recording happens either way: an agent that collides with somebody
     * still holds the lines it wrote, and the third agent along has to be
     * told about both of them.
     */
    saw(one: Open): Collision[] {
      const file = fileOf(one.path)
      const hits: Collision[] = []

      for (const [agentId, files] of open) {
        if (agentId === one.agentId) continue
        const theirs = files.get(file)
        if (theirs === undefined) continue

        for (const mine of one.ranges) {
          const met = theirs.ranges.find((range) => meets(mine, range, slack))
          if (met === undefined) continue

          const pair = `${file}:${one.agentId}:${agentId}`
          if (told.has(pair)) continue
          told.add(pair)

          const task = taskOf(theirs.path)
          hits.push({
            file,
            mine: one.agentId,
            theirs: agentId,
            lines: mine,
            theirLines: met,
            ...(task === undefined ? {} : { task }),
            since: theirs.at,
          })
        }
      }

      const mine = open.get(one.agentId) ?? new Map()
      const before = mine.get(file)
      mine.set(file, {
        ranges: [...(before?.ranges ?? []), ...one.ranges],
        at: before?.at ?? one.at,
        path: one.path,
      })
      open.set(one.agentId, mine)

      return hits
    },

    /** An agent whose work has landed is no longer in anybody's way. */
    finished(agentId: string): void {
      open.delete(agentId)
      for (const pair of told) {
        if (pair.includes(`:${agentId}:`) || pair.endsWith(`:${agentId}`)) told.delete(pair)
      }
    },

    /** One collision, in the sentence both agents are given. */
    sentence(hit: Collision, now: number): string {
      const where = hit.task === undefined ? 'its own checkout' : `its own checkout (${hit.task})`
      return (
        `${hit.theirs} changed ${hit.file} lines ${hit.theirLines[0]}-${hit.theirLines[1]} ` +
        `in ${where} ${since(hit.since, now)}; your change to lines ${hit.lines[0]}-${hit.lines[1]} ` +
        'overlaps it, and the two will have to be merged.'
      )
    },
  }
}

/** Whether two line ranges are near enough to be one place. */
function meets(one: [number, number], other: [number, number], slack: number): boolean {
  return one[0] - slack <= other[1] && other[0] - slack <= one[1]
}

/** How long ago, in the roughness somebody reads at a glance. */
function since(when: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}
