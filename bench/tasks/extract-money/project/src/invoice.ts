/** A line of an invoice, in cents. */
export type InvoiceLine = { description: string; cents: number }

export function invoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0)
}

/** "1,234.50 EUR": thousands separated, two decimals, the currency after. */
export function formatInvoiceAmount(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : ''
  const whole = Math.floor(Math.abs(cents) / 100)
  const fraction = Math.abs(cents) % 100
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}.${fraction.toString().padStart(2, '0')} ${currency}`
}

export function renderInvoice(lines: InvoiceLine[], currency: string): string {
  const body = lines.map(
    (line) => `${line.description}: ${formatInvoiceAmount(line.cents, currency)}`,
  )
  return [...body, `total: ${formatInvoiceAmount(invoiceTotal(lines), currency)}`].join('\n')
}
