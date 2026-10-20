export type TileTree =
  | { kind: 'leaf'; agentId: string }
  | {
      kind: 'split'
      id: string
      axis: 'horizontal' | 'vertical'
      ratio: number
      first: TileTree
      second: TileTree
    }
export type TileEdge = 'left' | 'right' | 'top' | 'bottom' | 'center'
const MAX_AGENTS = 128
const validAxis = (axis: unknown): axis is 'horizontal' | 'vertical' =>
  axis === 'horizontal' || axis === 'vertical'
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const validId = (id: unknown): id is string =>
  typeof id === 'string' && id.length > 0 && id.length <= 240
const roster = (ids: readonly string[]) => [...new Set(ids.filter(validId))].slice(0, MAX_AGENTS)

export function tileAgents(tree: TileTree | null): string[] {
  if (!tree) return []
  return tree.kind === 'leaf'
    ? [tree.agentId]
    : [...tileAgents(tree.first), ...tileAgents(tree.second)]
}

function splitIds(tree: TileTree | null): string[] {
  if (!tree || tree.kind === 'leaf') return []
  return [tree.id, ...splitIds(tree.first), ...splitIds(tree.second)]
}

function nextId(tree: TileTree | null): string {
  const ids = new Set(splitIds(tree))
  let index = 1
  while (ids.has(`split-${index}`)) index++
  return `split-${index}`
}

export function balancedLayout(ids: readonly string[]): TileTree | null {
  let sequence = 0
  function build(agents: string[], depth: number): TileTree | null {
    const firstAgent = agents[0]
    if (firstAgent === undefined) return null
    if (agents.length === 1) return { kind: 'leaf', agentId: firstAgent }
    const id = `split-${++sequence}`
    const middle = Math.ceil(agents.length / 2)
    const first = build(agents.slice(0, middle), depth + 1)
    const second = build(agents.slice(middle), depth + 1)
    if (!first || !second) return first ?? second
    return {
      kind: 'split',
      id,
      axis: depth % 2 ? 'vertical' : 'horizontal',
      ratio: 0.5,
      first,
      second,
    }
  }
  return build(roster(ids), 0)
}

function prune(tree: TileTree | null, keep: Set<string>): TileTree | null {
  if (!tree) return null
  if (tree.kind === 'leaf') return keep.has(tree.agentId) ? tree : null
  const first = prune(tree.first, keep),
    second = prune(tree.second, keep)
  if (!first || !second) return first ?? second
  return { ...tree, first, second }
}

export function reconcileLayout(tree: TileTree | null, ids: readonly string[]): TileTree | null {
  const desired = roster(ids)
  const parsed = parseTileLayout(tree)
  if (!parsed) return balancedLayout(desired)
  let result = prune(parsed, new Set(desired))
  const existing = new Set(tileAgents(result))
  for (const agentId of desired) {
    if (existing.has(agentId)) continue
    const leaf: TileTree = { kind: 'leaf', agentId }
    result = result
      ? {
          kind: 'split',
          id: nextId(result),
          axis: 'horizontal',
          ratio: 0.5,
          first: result,
          second: leaf,
        }
      : leaf
  }
  // Repeated admissions must not create an unbounded-depth persistent tree.
  return parseTileLayout(result) ?? balancedLayout(desired)
}

function replace(tree: TileTree, agentId: string, replacement: TileTree): TileTree {
  if (tree.kind === 'leaf') return tree.agentId === agentId ? replacement : tree
  return {
    ...tree,
    first: replace(tree.first, agentId, replacement),
    second: replace(tree.second, agentId, replacement),
  }
}

export function moveTile(
  tree: TileTree | null,
  source: string,
  target: string,
  edge: TileEdge,
): TileTree | null {
  const agents = tileAgents(tree)
  if (!tree || source === target || !agents.includes(source) || !agents.includes(target))
    return tree
  if (edge === 'center') {
    function swap(node: TileTree): TileTree {
      if (node.kind === 'leaf')
        return {
          ...node,
          agentId:
            node.agentId === source ? target : node.agentId === target ? source : node.agentId,
        }
      return { ...node, first: swap(node.first), second: swap(node.second) }
    }
    return swap(tree)
  }
  const kept = prune(tree, new Set(agents.filter((id) => id !== source)))
  if (!kept) return tree
  const first: TileTree = { kind: 'leaf', agentId: source },
    second: TileTree = { kind: 'leaf', agentId: target }
  const before = edge === 'left' || edge === 'top'
  const result = replace(kept, target, {
    kind: 'split',
    id: nextId(tree),
    axis: edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical',
    ratio: 0.5,
    first: before ? first : second,
    second: before ? second : first,
  })
  return parseTileLayout(result) ? result : tree
}

export function resizeTile(tree: TileTree | null, splitId: string, ratio: number): TileTree | null {
  if (!tree || tree.kind === 'leaf' || !Number.isFinite(ratio)) return tree
  if (tree.id === splitId) return { ...tree, ratio: Math.max(0.15, Math.min(0.85, ratio)) }
  return {
    ...tree,
    first: resizeTile(tree.first, splitId, ratio) ?? tree.first,
    second: resizeTile(tree.second, splitId, ratio) ?? tree.second,
  }
}

/** Rebuilds untrusted persisted data into a bounded tree with globally unique IDs. */
export function parseTileLayout(value: unknown): TileTree | null {
  const agents = new Set<string>(),
    splits = new Set<string>()
  let count = 0
  function read(input: unknown, depth: number): TileTree | null {
    if (++count > 255 || depth > 24 || !isRecord(input)) return null
    const node = input
    if (node.kind === 'leaf') {
      if (!validId(node.agentId) || agents.has(node.agentId)) return null
      agents.add(node.agentId)
      return { kind: 'leaf', agentId: node.agentId }
    }
    if (
      node.kind !== 'split' ||
      !validId(node.id) ||
      splits.has(node.id) ||
      !validAxis(node.axis) ||
      typeof node.ratio !== 'number' ||
      !Number.isFinite(node.ratio) ||
      node.ratio < 0.15 ||
      node.ratio > 0.85
    )
      return null
    splits.add(node.id)
    const first = read(node.first, depth + 1),
      second = read(node.second, depth + 1)
    if (!first || !second) return null
    return {
      kind: 'split',
      id: node.id,
      axis: node.axis,
      ratio: node.ratio,
      first,
      second,
    }
  }
  return read(value, 0)
}

function layoutScore(
  agentCount: number,
  rows: number,
  availableWidth: number,
  availableHeight: number,
): number {
  const columns = Math.ceil(agentCount / rows)
  const neededWidth = columns * 250 + (columns - 1) * 6
  const neededHeight = rows * 200 + (rows - 1) * 6
  const canvasWidth = Math.max(availableWidth, neededWidth)
  const canvasHeight = Math.max(availableHeight, neededHeight)
  const paneHeight = (canvasHeight - (rows - 1) * 6) / rows
  let shape = 0
  for (let row = 0; row < rows; row++) {
    const count = Math.floor(agentCount / rows) + (row < agentCount % rows ? 1 : 0)
    const paneWidth = (canvasWidth - (count - 1) * 6) / count
    shape += (count * Math.abs(Math.log(paneWidth / paneHeight / 1.6))) / agentCount
  }
  return (
    shape +
    8 * Math.log(canvasWidth / availableWidth) +
    3 * Math.log(canvasHeight / availableHeight)
  )
}

/** Restore readable transcript proportions; prefer vertical overflow over sideways panning. */
export function optimalLayout(
  ids: readonly string[],
  width: number,
  height: number,
): TileTree | null {
  const agents = roster(ids)
  if (!agents.length) return null
  const availableWidth = Number.isFinite(width) && width > 0 ? width : 1000
  const availableHeight = Number.isFinite(height) && height > 0 ? height : 700
  let bestRows = 1
  let bestScore = Number.POSITIVE_INFINITY
  for (let rows = 1; rows <= agents.length; rows++) {
    const score = layoutScore(agents.length, rows, availableWidth, availableHeight)
    if (score < bestScore) {
      bestScore = score
      bestRows = rows
    }
  }
  let sequence = 0
  function combine(parts: TileTree[], axis: 'horizontal' | 'vertical'): TileTree | null {
    if (parts.length === 1) return parts[0] ?? null
    if (!parts.length) return null
    const middle = Math.ceil(parts.length / 2)
    const first = combine(parts.slice(0, middle), axis)
    const second = combine(parts.slice(middle), axis)
    if (!first || !second) return first ?? second
    return {
      kind: 'split',
      id: `split-${++sequence}`,
      axis,
      ratio: middle / parts.length,
      first,
      second,
    }
  }
  const bands: TileTree[] = []
  let offset = 0
  for (let row = 0; row < bestRows; row++) {
    const count = Math.floor(agents.length / bestRows) + (row < agents.length % bestRows ? 1 : 0)
    const band = combine(
      agents.slice(offset, offset + count).map((agentId) => ({ kind: 'leaf', agentId })),
      'horizontal',
    )
    if (band) bands.push(band)
    offset += count
  }
  return combine(bands, 'vertical')
}
