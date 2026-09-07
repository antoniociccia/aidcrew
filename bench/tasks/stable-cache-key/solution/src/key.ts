function ordered(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) return value.map(ordered)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const record = value as Record<string, unknown>
    for (const key of Object.keys(record).sort()) {
      const inner = record[key]
      if (inner === undefined || typeof inner === 'function') continue
      out[key] = ordered(inner)
    }
    return out
  }
  return value
}

/** One string per distinct value, for a cache to look up. */
export function cacheKey(value: unknown): string {
  return JSON.stringify(ordered(value))
}
