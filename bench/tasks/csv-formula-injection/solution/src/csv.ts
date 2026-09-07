export type Cell = string | number

const FORMULA = /^[=+\-@\t\r]/

function field(cell: Cell): string {
  if (typeof cell === 'number') return String(cell)
  // A cell a spreadsheet would evaluate is shown as text instead.
  const text = FORMULA.test(cell) ? `'${cell}` : cell
  return FORMULA.test(cell) || /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** Rows as CSV lines, comma separated, LF terminated. */
export function toCsv(rows: Cell[][]): string {
  return rows.map((row) => row.map(field).join(',')).join('\n') + '\n'
}
