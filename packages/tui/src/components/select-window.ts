/**
 * Which slice of a long list to draw.
 *
 * A list that renders every item is a list that only works while it is short:
 * with sixty models the eleventh is unreachable, because the terminal has
 * already run out of rows and nothing scrolls.
 *
 * The cursor is kept away from both edges where there is room, so the items
 * either side of the choice are visible — which is most of what makes a list
 * readable rather than a peephole.
 */
export function windowAround(
  cursor: number,
  total: number,
  height: number,
): { start: number; end: number } {
  if (total <= height) return { start: 0, end: total }

  const margin = Math.floor(height / 2)
  const start = Math.min(Math.max(0, cursor - margin), total - height)

  return { start, end: start + height }
}
