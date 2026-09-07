/** A path with its . and .. segments resolved and its slashes tidied. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/')
  const out: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      const last = out.at(-1)
      if (last !== undefined && last !== '..') out.pop()
      else if (!absolute) out.push('..')
      continue
    }
    out.push(segment)
  }
  if (absolute) return `/${out.join('/')}`
  return out.length === 0 ? '.' : out.join('/')
}
