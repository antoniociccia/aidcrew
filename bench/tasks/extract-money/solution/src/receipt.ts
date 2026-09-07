import { formatMoney } from './money.ts'

/** An item on a till receipt, in cents. */
export type ReceiptItem = { name: string; cents: number }

/** Kept for what imports it; the formatting lives in money.ts. */
export function formatReceiptAmount(cents: number, currency: string): string {
  return formatMoney(cents, currency)
}

export function renderReceipt(items: ReceiptItem[], currency: string): string {
  const total = items.reduce((sum, item) => sum + item.cents, 0)
  const body = items.map((item) => `${item.name} ${formatMoney(item.cents, currency)}`)
  return [...body, `TOTAL ${formatMoney(total, currency)}`].join('\n')
}
