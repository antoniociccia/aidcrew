/**
 * Moving one thing to where another one is, keeping everything else in order.
 *
 * Pulled out of the screen because it is the whole of what dragging a tab
 * means, and because the alternative is testing it by moving a mouse.
 */
export function moveTo<T>(items: T[], what: T, to: number): T[] {
  const from = items.indexOf(what)
  if (from < 0) return items
  const at = Math.max(0, Math.min(items.length - 1, to))
  if (at === from) return items

  const rest = [...items.slice(0, from), ...items.slice(from + 1)]
  return [...rest.slice(0, at), what, ...rest.slice(at)]
}

/**
 * Which tab a column falls in, given how many there are.
 *
 * The tabs share the width evenly, and the last one takes whatever the
 * division left over — so a click on the final column belongs to the last tab
 * rather than to one past the end.
 */
export function tabAt(column: number, columns: number, count: number): number | undefined {
  if (count <= 0 || columns <= 0) return undefined
  const cell = Math.floor(columns / count)
  if (cell <= 0) return undefined
  return Math.min(count - 1, Math.floor(column / cell))
}
