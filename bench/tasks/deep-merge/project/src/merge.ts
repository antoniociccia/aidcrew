export type Plain = Record<string, unknown>

/** base with over laid on top, deeply. */
export function deepMerge(base: Plain, over: Plain): Plain {
  throw new Error(
    `deepMerge is not implemented yet (${Object.keys(base).length} + ${Object.keys(over).length} keys)`,
  )
}
