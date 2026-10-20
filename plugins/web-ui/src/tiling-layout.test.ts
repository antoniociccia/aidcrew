import { expect, test } from 'bun:test'
import type { TileTree } from './tiling-layout.ts'
import {
  balancedLayout,
  moveTile,
  optimalLayout,
  parseTileLayout,
  reconcileLayout,
  resizeTile,
  tileAgents,
} from './tiling-layout.ts'

test('balances a unique roster and handles empty or single-agent workspaces', () => {
  expect(balancedLayout([])).toBeNull()
  expect(balancedLayout(['a'])).toEqual({ kind: 'leaf', agentId: 'a' })
  expect(tileAgents(balancedLayout(['a', 'b', 'a', 'c']))).toEqual(['a', 'b', 'c'])
})

test('moves agents to every edge without duplicates and swaps the center immutably', () => {
  const initial = balancedLayout(['a', 'b', 'c', 'd'])
  const saved = JSON.stringify(initial)
  for (const edge of ['left', 'right', 'top', 'bottom', 'center'] as const) {
    const moved = moveTile(initial, 'a', 'c', edge)
    expect(tileAgents(moved).sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(parseTileLayout(moved)).toEqual(moved)
  }
  expect(tileAgents(moveTile(initial, 'a', 'c', 'center'))).toEqual(['c', 'b', 'a', 'd'])
  expect(JSON.stringify(initial)).toBe(saved)
  expect(moveTile(initial, 'missing', 'c', 'left')).toEqual(initial)
  expect(moveTile(initial, 'a', 'a', 'left')).toEqual(initial)
})

test('keeps surviving branch ratios while reconciling removed and new agents', () => {
  const initial = balancedLayout(['a', 'b'])
  if (initial?.kind !== 'split') throw Error('Expected split')
  const resized = resizeTile(initial, initial.id, 0.7)
  const reconciled = reconcileLayout(resized, ['a', 'b', 'c'])
  expect(reconciled?.kind === 'split' ? reconciled.first : null).toEqual(resized)
  expect(tileAgents(reconcileLayout(reconciled, ['a', 'c']))).toEqual(['a', 'c'])
  expect(reconcileLayout(reconciled, [])).toBeNull()
  expect(reconcileLayout(resized, ['a', 'b'])).toEqual(resized)
})

test('clamps ratios and rejects malformed persisted trees with a bounded parser', () => {
  const initial = balancedLayout(['a', 'b'])
  if (initial?.kind !== 'split') throw Error('Expected split')
  expect(resizeTile(initial, initial.id, 9)).toMatchObject({ ratio: 0.85 })
  expect(resizeTile(initial, initial.id, -1)).toMatchObject({ ratio: 0.15 })
  expect(resizeTile(initial, initial.id, NaN)).toEqual(initial)
  for (const bad of [
    { ...initial, ratio: Infinity },
    { ...initial, axis: 'diagonal' },
    { ...initial, second: initial.first },
    { kind: 'leaf', agentId: '' },
    { ...initial, ratio: 0 },
  ])
    expect(parseTileLayout(bad)).toBeNull()
  let deep: unknown = { kind: 'leaf', agentId: 'last' }
  for (let i = 0; i < 30; i++)
    deep = {
      kind: 'split',
      id: `s${i}`,
      axis: 'horizontal',
      ratio: 0.5,
      first: { kind: 'leaf', agentId: `a${i}` },
      second: deep,
    }
  expect(parseTileLayout(deep)).toBeNull()
  expect(parseTileLayout(JSON.parse(JSON.stringify(initial)))).toEqual(initial)
})

test('rejects duplicate split ids and excessive nodes and recovers invalid stored layout', () => {
  const initial = balancedLayout(['a', 'b', 'c', 'd'])
  if (initial?.kind !== 'split' || initial.first.kind !== 'split')
    throw Error('Expected nested split')
  expect(parseTileLayout({ ...initial, first: { ...initial.first, id: initial.id } })).toBeNull()
  let sequence = 0
  function build(depth: number): unknown {
    const id = String(sequence++)
    return depth === 0
      ? { kind: 'leaf', agentId: id }
      : {
          kind: 'split',
          id,
          axis: 'horizontal',
          ratio: 0.5,
          first: build(depth - 1),
          second: build(depth - 1),
        }
  }
  expect(parseTileLayout(build(8))).toBeNull()
  expect(reconcileLayout(parseTileLayout({ bad: true }), ['a', 'b'])).toEqual(
    balancedLayout(['a', 'b']),
  )
})

test('places directional drops in their requested axis and order', () => {
  const initial = balancedLayout(['a', 'b'])
  for (const [edge, axis, order] of [
    ['left', 'horizontal', ['a', 'b']],
    ['right', 'horizontal', ['b', 'a']],
    ['top', 'vertical', ['a', 'b']],
    ['bottom', 'vertical', ['b', 'a']],
  ] as const) {
    const moved = moveTile(initial, 'a', 'b', edge)
    expect(moved).toMatchObject({ kind: 'split', axis })
    expect(tileAgents(moved)).toEqual([...order])
  }
})

test('preserves all unique agents across repeated rearrangements', () => {
  const ids = Array.from({ length: 12 }, (_, index) => `agent-${index}`)
  const edges = ['left', 'right', 'top', 'bottom', 'center'] as const
  let tree = balancedLayout(ids)
  for (let step = 0; step < 80; step++) {
    tree = moveTile(
      tree,
      ids[step % ids.length] ?? '',
      ids[(step * 7 + 1) % ids.length] ?? '',
      edges[step % edges.length] ?? 'left',
    )
    expect(tileAgents(tree).sort()).toEqual([...ids].sort())
    expect(parseTileLayout(tree)).toEqual(tree)
  }
})

test('restores an optimal split for wide and tall viewports', () => {
  const wide = optimalLayout(['a', 'b'], 1400, 400)
  const tall = optimalLayout(['a', 'b'], 400, 1400)
  expect(wide?.kind === 'split' && wide.axis).toBe('horizontal')
  expect(tall?.kind === 'split' && tall.axis).toBe('vertical')
  expect(optimalLayout(['only'], 0, 0)).toEqual({ kind: 'leaf', agentId: 'only' })
})

test('restores seven panes within a usable desktop viewport and keeps mobile vertical', () => {
  const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
  const layout = optimalLayout(ids, 1400, 700)
  expect(tileAgents(layout)).toEqual(ids)
  const dimensions = (
    tree: TileTree | null,
    width: number,
    height: number,
  ): { width: number; height: number }[] => {
    if (!tree) return []
    if (tree.kind === 'leaf') return [{ width, height }]
    return tree.axis === 'horizontal'
      ? [
          ...dimensions(tree.first, (width - 6) * tree.ratio, height),
          ...dimensions(tree.second, (width - 6) * (1 - tree.ratio), height),
        ]
      : [
          ...dimensions(tree.first, width, (height - 6) * tree.ratio),
          ...dimensions(tree.second, width, (height - 6) * (1 - tree.ratio)),
        ]
  }
  expect(
    dimensions(layout, 1400, 700).every((pane) => pane.width >= 250 && pane.height >= 200),
  ).toBe(true)
  const mobile = optimalLayout(ids, 390, 700)
  expect(dimensions(mobile, 390, 1400).every((pane) => pane.width === 390)).toBe(true)
  expect(parseTileLayout(layout)).toEqual(layout)
})
