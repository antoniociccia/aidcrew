/** What a run of csvtool prints, and how it exits. */
export type Result = { out: string; code: number }

/** The csvtool command line: reads the input, writes the result. */
export function run(args: string[], input: string): Result {
  if (args.includes('--upper')) return { out: input.toUpperCase(), code: 0 }
  if (args.includes('--count')) {
    const lines = input.split('\n').filter((line) => line !== '').length
    return { out: `${lines}\n`, code: 0 }
  }
  return { out: 'usage: csvtool --upper | --count\n', code: 2 }
}
