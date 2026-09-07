export type Ini = Record<string, Record<string, string>>

/** Parses INI text into its sections; keys before any section header go under ''. */
export function parseIni(text: string): Ini {
  const ini: Ini = {}
  let section = ''
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue
    const header = /^\[(.*)\]$/.exec(line)
    if (header) {
      section = (header[1] ?? '').trim()
      ini[section] ??= {}
      continue
    }
    const at = line.indexOf('=')
    if (at < 1) {
      throw new SyntaxError(
        `line ${index + 1}: expected a section, a key = value pair or a comment`,
      )
    }
    const key = line.slice(0, at).trim()
    let value = line.slice(at + 1).trim()
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1)
    }
    const entries = ini[section] ?? {}
    entries[key] = value
    ini[section] = entries
  }
  return ini
}
