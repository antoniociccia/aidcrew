export type Money = { cents: number; currency: 'EUR' | 'USD' | 'GBP' }

const CURRENCIES: [RegExp, Money['currency']][] = [
  [/€|\bEUR\b/i, 'EUR'],
  [/\$|\bUSD\b/i, 'USD'],
  [/£|\bGBP\b/i, 'GBP'],
]

/** An amount as people write it, read into cents and a currency code. */
export function parseMoney(text: string): Money {
  const found = CURRENCIES.find(([shape]) => shape.test(text))
  if (!found) throw new TypeError(`no known currency in: ${text}`)
  const negative = /^\s*-|\(.*\)/.test(text)
  const digits = /[\d][\d ,.]*/.exec(text)?.[0]?.trim()
  if (!digits) throw new TypeError(`no amount in: ${text}`)
  const decimal = /[.,](\d{2})$/.exec(digits)
  const whole = (decimal ? digits.slice(0, -3) : digits).replace(/[ ,.]/g, '')
  const cents = Number(whole) * 100 + (decimal ? Number(decimal[1]) : 0)
  return { cents: negative ? -cents : cents, currency: found[1] }
}
