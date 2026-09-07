/** A span of time, as ISO 8601 strings. The end is exclusive. */
export type Range = { start: string; end: string }

/** Whether two ranges share any moment. */
export function overlaps(a: Range, b: Range): boolean {
  const aStart = Date.parse(a.start)
  const aEnd = Date.parse(a.end)
  const bStart = Date.parse(b.start)
  const bEnd = Date.parse(b.end)
  return aStart <= bEnd && bStart <= aEnd
}
