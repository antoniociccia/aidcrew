/** "1,234.50 EUR": thousands grouped, two decimals, a leading minus, the currency after. */
export function formatMoney(cents: number, currency: string): string {
  const sign = cents < 0 ? '-' : ''
  const whole = Math.floor(Math.abs(cents) / 100)
  const fraction = Math.abs(cents) % 100
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${sign}${grouped}.${fraction.toString().padStart(2, '0')} ${currency}`
}
