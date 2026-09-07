const SECRET_KEY = /password|passwd|secret|token|api[-_]?key|authorization/i
const BEARER = /Bearer\s+\S+/g

/** value with every secret masked, at any depth; the input is untouched. */
export function redact(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(BEARER, 'Bearer [redacted]')
  if (Array.isArray(value)) return value.map(redact)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(inner)
    }
    return out
  }
  return value
}
