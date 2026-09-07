export type Plain = Record<string, unknown>

const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

function isPlain(value: unknown): value is Plain {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function clone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clone)
  if (isPlain(value)) {
    const out: Plain = {}
    for (const key of Object.keys(value)) {
      if (!FORBIDDEN.has(key)) out[key] = clone(value[key])
    }
    return out
  }
  return value
}

/** base with over laid on top, deeply. */
export function deepMerge(base: Plain, over: Plain): Plain {
  const out = clone(base) as Plain
  for (const key of Object.keys(over)) {
    if (FORBIDDEN.has(key)) continue
    const value = over[key]
    if (value === undefined) continue
    const existing = out[key]
    out[key] = isPlain(value) && isPlain(existing) ? deepMerge(existing, value) : clone(value)
  }
  return out
}
