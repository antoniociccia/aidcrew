import type {
  AgentState,
  HiddenRules,
  Item,
  ItemKind,
  Pos,
  Terrain,
  WorldState,
} from '../contracts.ts'
import { nextInt, seedState } from '../rng.ts'

export const WIDTH = 12
export const HEIGHT = 12
export const START_ENERGY = 60
export const AGENT_NAMES = ['Ada', 'Bo', 'Cyr', 'Dee', 'Eli', 'Fay', 'Gus', 'Hal'] as const

// Neutral fiction: the inscriptions must never name what the slab really is.
export const TABLET_TEXTS = [
  'The slab listens for three numbers. The first is the wait between harvests.',
  'The second is how long a lost stone sleeps before it wakes elsewhere.',
  'The third is the length of one day. Press them into the slab, in order.',
] as const

const DESCRIPTIONS: Record<ItemKind, string> = {
  food: 'A soft fruit. It looks edible.',
  stone: 'A grey stone, heavy for its size.',
  crystal: 'A pale crystal that hums faintly.',
  tablet: 'A clay tablet with words pressed into it.',
  slab: 'A wide flat slab, set into the ground. Its face takes the press of a hand.',
}

const BLOCKED_SHARE = 0.15

export function terrainAt(state: Pick<WorldState, 'terrain' | 'width'>, p: Pos): Terrain {
  return state.terrain[p.y * state.width + p.x] ?? 'rock'
}

export function generateWorld(seed: number, agentCount: number, path = ''): WorldState {
  if (!Number.isInteger(agentCount) || agentCount < 1 || agentCount > AGENT_NAMES.length) {
    throw new Error(`agentCount must be 1..${AGENT_NAMES.length}, got ${agentCount}`)
  }
  let rng = seedState(seed)
  const int = (min: number, max: number) => {
    const d = nextInt(rng, min, max)
    rng = d.state
    return d.value
  }

  const tiles: Pos[] = []
  for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) tiles.push({ x, y })
  shuffle(tiles, int)
  let cursor = 0
  const take = () => tiles[cursor++] as Pos

  const fertile = [take(), take(), take()]
  const glitchFrom = take()
  const glitchTo = take()
  const slabPos = take()
  const spawns = Array.from({ length: agentCount }, take)

  const rules: HiddenRules = {
    regrowthPeriod: int(5, 12),
    fertile,
    dayLength: int(12, 24),
    glitch: { from: glitchFrom, to: glitchTo, delay: int(3, 9) },
    resonance: { pairDistance: int(2, 4), energy: int(1, 3) },
  }

  const terrain: Terrain[] = Array.from({ length: WIDTH * HEIGHT }, () => 'ground')
  const target = Math.round(WIDTH * HEIGHT * BLOCKED_SHARE)
  let blocked = 0
  for (let i = cursor; i < tiles.length && blocked < target; i++) {
    const p = tiles[i] as Pos
    const idx = p.y * WIDTH + p.x
    terrain[idx] = int(0, 1) === 0 ? 'rock' : 'water'
    if (groundConnected(terrain)) blocked++
    else terrain[idx] = 'ground'
  }

  const free = tiles.slice(cursor).filter((p) => terrain[p.y * WIDTH + p.x] === 'ground')
  let freeCursor = 0
  const takeFree = () => {
    const p = free[freeCursor++]
    if (!p) throw new Error('world too crowded to place every item')
    return p
  }

  const items: Item[] = []
  const counts: Partial<Record<ItemKind, number>> = {}
  const place = (kind: ItemKind, pos: Pos, extra: Record<string, string | number> = {}) => {
    const n = (counts[kind] ?? 0) + 1
    counts[kind] = n
    items.push({
      id: `${kind}-${n}`,
      kind,
      pos,
      holder: null,
      props: { description: DESCRIPTIONS[kind], ...extra },
    })
  }
  for (const f of fertile) place('food', f)
  place('food', takeFree())
  for (let i = 0; i < 6; i++) place('stone', takeFree())
  for (let i = 0; i < 2; i++) place('crystal', takeFree())
  TABLET_TEXTS.forEach((text) => {
    place('tablet', takeFree(), { text })
  })
  place('slab', slabPos)

  const agents: AgentState[] = spawns.map((pos, i) => {
    const name = AGENT_NAMES[i] as string
    return { id: name.toLowerCase(), name, pos, energy: START_ENERGY, alive: true, inventory: [] }
  })

  return {
    path,
    seed,
    tick: 0,
    rng,
    width: WIDTH,
    height: HEIGHT,
    terrain,
    items,
    agents,
    rules,
    pending: [],
    params: { regrowthPeriod: rules.regrowthPeriod, dayLength: rules.dayLength },
    predictions: [],
    strategyTicks: {},
    itemSeq: items.length + 1,
  }
}

// An obstacle that cuts the ground in two could wall an agent off from the
// slab, and a run would then measure the map, not the agents.
function groundConnected(terrain: Terrain[]): boolean {
  const start = terrain.indexOf('ground')
  if (start < 0) return false
  const seen = new Uint8Array(terrain.length)
  seen[start] = 1
  const stack = [start]
  let reached = 1
  while (stack.length > 0) {
    for (const n of neighbours(stack.pop() as number)) {
      if (seen[n] || terrain[n] !== 'ground') continue
      seen[n] = 1
      reached++
      stack.push(n)
    }
  }
  return reached === terrain.filter((t) => t === 'ground').length
}

function neighbours(i: number): number[] {
  const x = i % WIDTH
  const y = Math.floor(i / WIDTH)
  const out: number[] = []
  if (x > 0) out.push(i - 1)
  if (x < WIDTH - 1) out.push(i + 1)
  if (y > 0) out.push(i - WIDTH)
  if (y < HEIGHT - 1) out.push(i + WIDTH)
  return out
}

function shuffle<T>(xs: T[], int: (min: number, max: number) => number): void {
  for (let i = xs.length - 1; i > 0; i--) {
    const j = int(0, i)
    ;[xs[i], xs[j]] = [xs[j] as T, xs[i] as T]
  }
}
