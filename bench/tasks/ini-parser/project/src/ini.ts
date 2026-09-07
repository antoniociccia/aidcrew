export type Ini = Record<string, Record<string, string>>

/** Parses INI text into its sections; keys before any section header go under ''. */
export function parseIni(text: string): Ini {
  throw new Error(`parseIni is not implemented yet (${text.length} characters given)`)
}
