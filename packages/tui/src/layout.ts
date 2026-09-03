/**
 * Where each agent's pane is on the screen.
 *
 * Worked out here, once, rather than inside the drawing: the same answer is
 * needed to draw a pane and to know which pane was clicked, and two versions
 * of that arithmetic drift apart the first time one of them is adjusted.
 */

export type PaneBox = {
  id: string
  x: number
  y: number
  width: number
  height: number
}

export type DividerBox = {
  x: number
  y: number
  height: number
  /** The panes either side, which is what a drag moves width between. */
  before: string
  after: string
}

export type Plan = {
  panes: PaneBox[]
  dividers: DividerBox[]
}

/** Under this, a pane shows three words at a time and stops being readable. */
const NARROWEST = 24

/**
 * Lays agents out side by side, in rows of them once they get too narrow.
 *
 * `weights` are relative, not absolute: a pane dragged wider keeps its share
 * when the window is resized, which is what makes the adjustment stick.
 */
export function planPanes(
  ids: string[],
  columns: number,
  rows: number,
  weights: Record<string, number> = {},
): Plan {
  if (ids.length === 0 || columns <= 0 || rows <= 0) return { panes: [], dividers: [] }

  const perRow = columns >= ids.length * 34 ? ids.length : Math.ceil(ids.length / 2)
  const bands: string[][] = []
  for (let at = 0; at < ids.length; at += perRow) bands.push(ids.slice(at, at + perRow))

  const bandHeight = Math.floor(rows / bands.length)
  const panes: PaneBox[] = []
  const dividers: DividerBox[] = []

  for (const [index, band] of bands.entries()) {
    const y = index * bandHeight
    // A column each for the rules between panes, taken before sharing out the
    // rest, so the panes never overrun the screen by the number of rules.
    const room = columns - (band.length - 1)
    const widths = share(band, room, weights)

    let x = 0
    for (const [at, id] of band.entries()) {
      if (at > 0) {
        dividers.push({
          x,
          y,
          height: bandHeight,
          before: band[at - 1] as string,
          after: id,
        })
        x += 1
      }
      panes.push({ id, x, y, width: widths[at] as number, height: bandHeight })
      x += widths[at] as number
    }
  }

  return { panes, dividers }
}

/** Whole columns in proportion to the weights, the remainder going to the last. */
function share(ids: string[], room: number, weights: Record<string, number>): number[] {
  const total = ids.reduce((sum, id) => sum + (weights[id] ?? 1), 0)
  const widths = ids.map((id) =>
    Math.max(NARROWEST, Math.floor((room * (weights[id] ?? 1)) / total)),
  )

  // Whatever rounding and the minimum left over lands on the last pane, so the
  // row adds up to the screen exactly rather than to a column short of it.
  const used = widths.slice(0, -1).reduce((sum, width) => sum + width, 0)
  widths[widths.length - 1] = Math.max(NARROWEST, room - used)

  // The minimum was applied after the room had been shared out, so a divider
  // dragged far over on a wide window and then the window shrunk left the
  // last pane starting past the edge, and every row overran the terminal.
  // Taken back from the widest panes first; and when even the minimum does
  // not fit, the room is simply divided, because a narrow pane beats one
  // drawn off the screen.
  let over = widths.reduce((sum, width) => sum + width, 0) - room
  while (over > 0) {
    const widest = widths.indexOf(Math.max(...widths))
    const give = Math.min(over, (widths[widest] ?? 0) - NARROWEST)
    if (give <= 0) break
    widths[widest] = (widths[widest] ?? 0) - give
    over -= give
  }
  if (over > 0) {
    const each = Math.floor(room / ids.length)
    for (let at = 0; at < widths.length; at++) widths[at] = each
    widths[widths.length - 1] = room - each * (ids.length - 1)
  }

  return widths
}

/** Which pane a point is in, if any. */
export function paneAt(panes: PaneBox[], column: number, row: number): string | undefined {
  return panes.find(
    (pane) =>
      column >= pane.x &&
      column < pane.x + pane.width &&
      row >= pane.y &&
      row < pane.y + pane.height,
  )?.id
}

/** Which divider a point is on, within `grab` columns either side of it. */
export function dividerAt(
  dividers: DividerBox[],
  column: number,
  row: number,
  grab = 1,
): DividerBox | undefined {
  return dividers.find(
    (divider) =>
      Math.abs(column - divider.x) <= grab && row >= divider.y && row < divider.y + divider.height,
  )
}

/**
 * How far one press moves a divider. Four columns is a nudge you can see and
 * still land where you meant after a few of them.
 */
export const DIVIDER_STEP = 4

/**
 * The divider beside the pane in focus, moved by some columns.
 *
 * A mouse could drag a divider and a keyboard could not — and neither can a
 * recording, so the one thing side by side is for could only ever be shown
 * to somebody sitting at the terminal. The divider on the focused pane's
 * right moves; from the last pane, the one on its left. No divider, no
 * change.
 */
export function nudge(
  weights: Record<string, number>,
  plan: Plan,
  focused: string,
  by: number,
): Record<string, number> {
  const divider =
    plan.dividers.find((one) => one.before === focused) ??
    plan.dividers.find((one) => one.after === focused) ??
    plan.dividers[0]
  if (!divider) return weights

  const before = plan.panes.find((pane) => pane.id === divider.before)
  const after = plan.panes.find((pane) => pane.id === divider.after)
  if (!before || !after) return weights

  return resize(weights, divider.before, divider.after, divider.x + by, { before, after })
}

/**
 * Moves width from one pane to its neighbour, in weights rather than columns.
 *
 * Expressed as a share of what the two of them have between them: the pair
 * keeps its combined width, so dragging one border never disturbs the panes
 * further along the row.
 */
export function resize(
  weights: Record<string, number>,
  before: string,
  after: string,
  atColumn: number,
  boxes: { before: PaneBox; after: PaneBox },
): Record<string, number> {
  const span = boxes.before.width + boxes.after.width
  if (span <= 0) return weights

  const wanted = atColumn - boxes.before.x
  const clamped = Math.min(span - NARROWEST, Math.max(NARROWEST, wanted))
  const pair = (weights[before] ?? 1) + (weights[after] ?? 1)

  return {
    ...weights,
    [before]: (pair * clamped) / span,
    [after]: (pair * (span - clamped)) / span,
  }
}
