import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * How the interface was left, remembered per project.
 *
 * Which agents were side by side, how wide you dragged them and who you were
 * talking to are properties of the work, not of the machine — so they live in
 * the project, next to the worktrees, the way an editor keeps a workspace
 * file. Open the same repo tomorrow and the team is arranged as you left it.
 *
 * It holds no secrets and nothing a person had to type, so it is safe to
 * commit; it is also unremarkable if it is not, which is why nothing depends
 * on it existing.
 */

export type UiState = {
  /** Agents shown side by side; empty means one at a time. */
  split: string[]
  /** Relative pane widths, by agent id. */
  weights: Record<string, number>
  /** Who was being addressed. */
  target: string
  /** Whether reasoning was being shown. */
  reasoning: boolean
  /**
   * The job that was being worked in.
   *
   * A worktree outlives the session that made it, which makes a task a small
   * project of its own: leaving one half-done and coming back to it tomorrow
   * is the normal way to use them, and reopening in the wrong one is a way to
   * do an afternoon's work in a directory nobody meant.
   */
  task: string
  /**
   * Agents that were acting without being asked.
   *
   * Kept because the alternative is worse in both directions: forgetting it
   * means an agent you deliberately turned loose starts asking again, and
   * silently remembering it in the project config would make a decision taken
   * for one afternoon permanent. Here it is per project and per person, and
   * visible in the tab the moment the session opens.
   */
  unleashed: string[]
  /**
   * The order the tabs were dragged into, by agent id.
   *
   * Kept for the same reason the pane widths are: arranging a team is work,
   * and doing it again every morning is work nobody agreed to. Names not on
   * the team any more are ignored, and anybody new goes on the end — so a
   * remembered order never hides an agent that has just been added.
   */
  order: string[]
}

export const EMPTY: UiState = {
  split: [],
  weights: {},
  target: '',
  reasoning: false,
  task: 'main',
  unleashed: [],
  order: [],
}

export const UI_FILE = join('.aidcrew', 'ui.json')

export function pathOf(cwd: string): string {
  return join(cwd, UI_FILE)
}

/**
 * Reads what was saved, and is not upset by anything it finds.
 *
 * A file that is missing, unreadable, or has been edited into nonsense means
 * the interface opens at its defaults — never that it fails to open. Every
 * field is checked, because this file is on disk and disks are not a promise.
 */
export function readUiState(cwd: string): UiState {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(pathOf(cwd), 'utf8'))
  } catch {
    return EMPTY
  }

  if (typeof raw !== 'object' || raw === null) return EMPTY
  const found = raw as Record<string, unknown>

  return {
    split: strings(found.split),
    weights: numbers(found.weights),
    target: typeof found.target === 'string' ? found.target : '',
    reasoning: found.reasoning === true,
    // A file written before tabs could be dragged has none, and opens in the
    // order the team is declared in — which is where it always opened.
    order: strings(found.order),
    // A file written before tasks existed has neither, and opens on the main
    // one with nobody loose — which is what it was doing anyway.
    task: typeof found.task === 'string' && found.task !== '' ? found.task : 'main',
    unleashed: strings(found.unleashed),
  }
}

/** Writes it, and says nothing if it cannot: a layout is not worth an error. */
export function writeUiState(cwd: string, state: UiState): void {
  try {
    const path = pathOf(cwd)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(state, undefined, 2)}\n`)
  } catch {
    // Read-only checkout, a directory someone else owns: the session carries
    // on exactly as well without it.
  }
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []
}

function numbers(value: unknown): Record<string, number> {
  if (typeof value !== 'object' || value === null) return {}

  const out: Record<string, number> = {}
  for (const [key, one] of Object.entries(value)) {
    // A weight that is not a finite positive number would divide the screen
    // into nothing, or into NaN columns.
    if (typeof one === 'number' && Number.isFinite(one) && one > 0) out[key] = one
  }
  return out
}

/**
 * The team in the order it was left, with anybody new on the end.
 *
 * Applied rather than trusted: a remembered order is a list of names, and the
 * team changes. One that is no longer there is dropped, and one that has just
 * been added goes last — which is where somebody looks for it, and is never
 * nowhere.
 */
export function inOrder<T extends { id: string }>(agents: T[], order: string[]): T[] {
  if (order.length === 0) return agents
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const known = order.map((id) => byId.get(id)).filter((agent): agent is T => agent !== undefined)
  const seen = new Set(known.map((agent) => agent.id))
  return [...known, ...agents.filter((agent) => !seen.has(agent.id))]
}
