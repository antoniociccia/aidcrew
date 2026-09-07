export type Params = Record<string, string>

const segments = (path: string) =>
  path
    .split('?')[0]
    ?.split('/')
    .filter((segment) => segment !== '') ?? []

/** The parameters a path gives a pattern, or undefined when it does not match. */
export function match(pattern: string, path: string): Params | undefined {
  const wanted = segments(pattern)
  const starAt = wanted.indexOf('*')
  if (starAt >= 0 && starAt !== wanted.length - 1)
    throw new TypeError(`* must be last in ${pattern}`)
  const given = segments(path)
  const params: Params = {}
  for (const [at, segment] of wanted.entries()) {
    if (segment === '*') {
      const rest = given.slice(at)
      if (rest.length === 0) return undefined
      params.rest = rest.map(decodeURIComponent).join('/')
      return params
    }
    const actual = given[at]
    if (actual === undefined) return undefined
    if (segment.startsWith(':')) params[segment.slice(1)] = decodeURIComponent(actual)
    else if (segment !== actual) return undefined
  }
  return given.length === wanted.length ? params : undefined
}
