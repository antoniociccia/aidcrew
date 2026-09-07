import { parseCsv } from './csv.ts'

/** What a run of csvtool prints, and how it exits. */
export type Result = { out: string; code: number }

/** The csvtool command line: reads the input, writes the result. */
export function run(args: string[], input: string): Result {
  if (args.includes('--upper')) return { out: input.toUpperCase(), code: 0 }
  if (args.includes('--count')) {
    const lines = input.split('\n').filter((line) => line !== '').length
    return { out: `${lines}\n`, code: 0 }
  }
  if (args.includes('--json')) return toJson(input)
  return { out: 'usage: csvtool --upper | --count | --json\n', code: 2 }
}

function toJson(input: string): Result {
  const [header, ...rows] = parseCsv(input)
  if (!header) return { out: '[]\n', code: 0 }
  const objects: Record<string, string>[] = []
  for (const [index, row] of rows.entries()) {
    if (row.length !== header.length) {
      return {
        out: `line ${index + 2}: expected ${header.length} fields, got ${row.length}\n`,
        code: 1,
      }
    }
    objects.push(Object.fromEntries(header.map((name, at) => [name, row[at] ?? ''])))
  }
  return { out: `${JSON.stringify(objects)}\n`, code: 0 }
}
