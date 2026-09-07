const TABLE: [number, string][] = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
]

const SHAPE = /^M{0,3}(CM|CD|D?C{0,3})(XC|XL|L?X{0,3})(IX|IV|V?I{0,3})$/

export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999)
    throw new RangeError(`cannot write ${n} as a Roman numeral`)
  let left = n
  let out = ''
  for (const [value, digits] of TABLE) {
    while (left >= value) {
      out += digits
      left -= value
    }
  }
  return out
}

export function fromRoman(text: string): number {
  const upper = text.toUpperCase()
  if (upper === '' || !SHAPE.test(upper)) throw new SyntaxError(`not a Roman numeral: ${text}`)
  let total = 0
  let rest = upper
  for (const [value, digits] of TABLE) {
    while (rest.startsWith(digits)) {
      total += value
      rest = rest.slice(digits.length)
    }
  }
  return total
}
