// mulberry32 with its state held outside, in WorldState.rng, so that a
// checkpoint carries the generator and a resumed run draws the same numbers.

export interface Draw {
  value: number
  state: number
}

export function seedState(seed: number): number {
  return seed >>> 0
}

export function next(state: number): Draw {
  const s = (state + 0x6d2b79f5) >>> 0
  let t = s
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return { value: ((t ^ (t >>> 14)) >>> 0) / 4294967296, state: s }
}

/** An integer in [min, max], both ends included. */
export function nextInt(state: number, min: number, max: number): Draw {
  const r = next(state)
  return { value: min + Math.floor(r.value * (max - min + 1)), state: r.state }
}
