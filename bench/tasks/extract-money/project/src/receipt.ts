/** An item on a till receipt, in cents. */
export type ReceiptItem = { name: string; cents: number }

/** "12.50 EUR": two decimals, the currency after. */
export function formatReceiptAmount(cents: number, currency: string): string {
  const whole = Math.floor(cents / 100)
  const fraction = cents % 100
  return `${whole}.${fraction.toString().padStart(2, '0')} ${currency}`
}

export function renderReceipt(items: ReceiptItem[], currency: string): string {
  const total = items.reduce((sum, item) => sum + item.cents, 0)
  const body = items.map((item) => `${item.name} ${formatReceiptAmount(item.cents, currency)}`)
  return [...body, `TOTAL ${formatReceiptAmount(total, currency)}`].join('\n')
}
