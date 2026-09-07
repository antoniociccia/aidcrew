import { formatMoney } from './money.ts'

/** A line of an invoice, in cents. */
export type InvoiceLine = { description: string; cents: number }

export function invoiceTotal(lines: InvoiceLine[]): number {
  return lines.reduce((sum, line) => sum + line.cents, 0)
}

/** Kept for what imports it; the formatting lives in money.ts. */
export function formatInvoiceAmount(cents: number, currency: string): string {
  return formatMoney(cents, currency)
}

export function renderInvoice(lines: InvoiceLine[], currency: string): string {
  const body = lines.map((line) => `${line.description}: ${formatMoney(line.cents, currency)}`)
  return [...body, `total: ${formatMoney(invoiceTotal(lines), currency)}`].join('\n')
}
