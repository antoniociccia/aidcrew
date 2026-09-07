export type Query = Record<string, string | string[]>

const decode = (text: string) => decodeURIComponent(text.replace(/\+/g, ' '))

export function parseQuery(text: string): Query {
  const query: Query = {}
  const body = text.startsWith('?') ? text.slice(1) : text
  if (body === '') return query
  for (const pair of body.split('&')) {
    if (pair === '') continue
    const at = pair.indexOf('=')
    const key = decode(at < 0 ? pair : pair.slice(0, at))
    const value = at < 0 ? '' : decode(pair.slice(at + 1))
    const existing = query[key]
    if (existing === undefined) query[key] = value
    else if (Array.isArray(existing)) existing.push(value)
    else query[key] = [existing, value]
  }
  return query
}

export function stringifyQuery(query: Query): string {
  const pairs: string[] = []
  for (const [key, value] of Object.entries(query)) {
    for (const one of Array.isArray(value) ? value : [value]) {
      pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(one)}`)
    }
  }
  return pairs.join('&')
}
