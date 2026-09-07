export type Query = Record<string, string | string[]>

export function parseQuery(text: string): Query {
  throw new Error(`parseQuery is not implemented yet (${text.length} characters)`)
}

export function stringifyQuery(query: Query): string {
  throw new Error(`stringifyQuery is not implemented yet (${Object.keys(query).length} keys)`)
}
