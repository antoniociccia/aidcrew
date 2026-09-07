/** One string per distinct value, for a cache to look up. */
export function cacheKey(value: unknown): string {
  return JSON.stringify(value)
}
