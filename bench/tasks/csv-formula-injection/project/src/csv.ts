export type Cell = string | number

function field(cell: Cell): string {
  const text = String(cell)
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows as CSV lines, comma separated, LF terminated. */
export function toCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map(field).join(',')).join('\n') + '\n'
}
