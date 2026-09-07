/** Where target goes in a sorted list of numbers: the first index whose element is not below it. */
export function insertionIndex(sorted: readonly number[], target: number): number {
  let low = 0
  let high = sorted.length
  while (low < high) {
    const mid = (low + high) >>> 1
    if ((sorted[mid] as number) < target) low = mid + 1
    else high = mid
  }
  return low
}
