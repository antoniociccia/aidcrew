export type Params = Record<string, string>

/** The parameters a path gives a pattern, or undefined when it does not match. */
export function match(pattern: string, path: string): Params | undefined {
  throw new Error(`match is not implemented yet (${pattern} against ${path})`)
}
