export type Interval = [number, number]

/** The intervals with overlaps and touches merged, sorted by start. */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  for (const [start, end] of intervals) {
    if (end < start) throw new RangeError(`interval ends before it starts: [${start}, ${end}]`)
  }
  const sorted = intervals.map(([start, end]): Interval => [start, end]).sort((a, b) => a[0] - b[0])
  const out: Interval[] = []
  for (const interval of sorted) {
    const last = out.at(-1)
    if (last && interval[0] <= last[1]) last[1] = Math.max(last[1], interval[1])
    else out.push(interval)
  }
  return out
}
