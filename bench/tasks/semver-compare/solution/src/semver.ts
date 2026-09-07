const SHAPE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

type Parsed = { core: number[]; pre: string[] }

function parse(version: string): Parsed {
  const match = SHAPE.exec(version)
  if (!match) throw new TypeError(`not a semantic version: ${version}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] === undefined ? [] : match[4].split('.'),
  }
}

function compareIdentifiers(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a)
  const bNumeric = /^\d+$/.test(b)
  if (aNumeric && bNumeric) return Number(a) - Number(b)
  if (aNumeric) return -1
  if (bNumeric) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** -1, 0 or 1: how a compares to b by semantic versioning. */
export function compareSemver(a: string, b: string): -1 | 0 | 1 {
  const left = parse(a)
  const right = parse(b)
  for (let at = 0; at < 3; at++) {
    const diff = (left.core[at] ?? 0) - (right.core[at] ?? 0)
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0
  if (left.pre.length === 0) return 1
  if (right.pre.length === 0) return -1
  const shared = Math.min(left.pre.length, right.pre.length)
  for (let at = 0; at < shared; at++) {
    const diff = compareIdentifiers(left.pre[at] ?? '', right.pre[at] ?? '')
    if (diff !== 0) return diff < 0 ? -1 : 1
  }
  if (left.pre.length === right.pre.length) return 0
  return left.pre.length < right.pre.length ? -1 : 1
}
