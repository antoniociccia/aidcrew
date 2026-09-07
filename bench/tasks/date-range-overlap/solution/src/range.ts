/** A span of time, as ISO 8601 strings. The end is exclusive. */
export type Range = { start: string; end: string }

/** Whether two ranges share any moment. */
export function overlaps(a: Range, b: Range): boolean {
  const [aStart, aEnd] = instantsOf(a)
  const [bStart, bEnd] = instantsOf(b)
  if (aStart === aEnd || bStart === bEnd) return false
  return aStart < bEnd && bStart < aEnd
}

function instantsOf(range: Range): [number, number] {
  const start = Date.parse(range.start)
  if (Number.isNaN(start)) throw new TypeError(`not a date: ${range.start}`)
  const end = Date.parse(range.end)
  if (Number.isNaN(end)) throw new TypeError(`not a date: ${range.end}`)
  if (end < start)
    throw new RangeError(`the range ends before it starts: ${range.start} to ${range.end}`)
  return [start, end]
}
