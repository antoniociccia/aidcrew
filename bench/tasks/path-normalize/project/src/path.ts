/** A path with its . and .. segments resolved and its slashes tidied. */
export function normalizePath(path: string): string {
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '..') out.pop()
    else if (segment !== '' && segment !== '.') out.push(segment)
  }
  return out.join('/')
}
