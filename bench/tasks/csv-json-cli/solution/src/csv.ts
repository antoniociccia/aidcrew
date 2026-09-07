/** Parses CSV text into rows of fields: quotes may hold commas, a doubled quote is one quote. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let at = 0
  while (at < text.length) {
    const char = text[at] ?? ''
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        field += '"'
        at += 2
        continue
      }
      if (char === '"') {
        quoted = false
        at += 1
        continue
      }
      field += char
      at += 1
      continue
    }
    if (char === '"') {
      quoted = true
    } else if (char === ',') {
      row.push(field)
      field = ''
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[at + 1] === '\n') at += 1
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += char
    }
    at += 1
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}
