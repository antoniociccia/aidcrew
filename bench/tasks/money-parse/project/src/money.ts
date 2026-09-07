export type Money = { cents: number; currency: 'EUR' | 'USD' | 'GBP' }

/** An amount as people write it, read into cents and a currency code. */
export function parseMoney(text: string): Money {
  throw new Error(`parseMoney is not implemented yet (${text})`)
}
