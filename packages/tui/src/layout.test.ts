import { describe, expect, test } from 'bun:test'
import { dividerAt, paneAt, planPanes, resize } from './layout.ts'

describe('placing panes', () => {
  test('splits the width between two agents, leaving a column for the rule', () => {
    const { panes, dividers } = planPanes(['a', 'b'], 101, 20)

    expect(panes.map((pane) => [pane.x, pane.width])).toEqual([
      [0, 50],
      [51, 50],
    ])
    expect(dividers.map((divider) => divider.x)).toEqual([50])
  })

  test('gives every pane the full height when they sit in one row', () => {
    const { panes } = planPanes(['a', 'b'], 100, 20)

    expect(panes.every((pane) => pane.y === 0 && pane.height === 20)).toBe(true)
  })

  test('wraps into two rows when the panes would be too narrow', () => {
    const { panes } = planPanes(['a', 'b', 'c', 'd'], 80, 20)

    expect(panes.map((pane) => pane.y)).toEqual([0, 0, 10, 10])
  })

  test('honours a weight, so a pane dragged wider stays wider', () => {
    const { panes } = planPanes(['a', 'b'], 101, 20, { a: 3, b: 1 })

    expect(panes[0]?.width).toBe(75)
    expect(panes[1]?.width).toBe(25)
  })

  test('never lets a weight squeeze a pane below readable', () => {
    const { panes } = planPanes(['a', 'b'], 101, 20, { a: 100, b: 1 })

    expect(panes[1]?.width).toBeGreaterThanOrEqual(24)
  })

  test('adds up to the width it was given', () => {
    const { panes, dividers } = planPanes(['a', 'b', 'c'], 120, 20)
    const used = panes.reduce((sum, pane) => sum + pane.width, 0) + dividers.length

    expect(used).toBe(120)
  })

  test('never places a pane past the right edge, whatever the weights', () => {
    // A divider dragged far over on a wide window, then the window shrunk:
    // the minimum width was applied after the room had been shared out, so
    // the last pane started past the edge and every row overran the terminal.
    const { panes } = planPanes(['a', 'b'], 80, 20, { a: 20, b: 1 })

    for (const pane of panes) expect(pane.x + pane.width).toBeLessThanOrEqual(80)
  })

  test('never places a pane past the right edge when there are too many for the room', () => {
    for (const [count, columns] of [
      [7, 90],
      [4, 40],
    ] as const) {
      const ids = Array.from({ length: count }, (_, at) => `agent-${at}`)
      const { panes } = planPanes(ids, columns, 20)
      for (const pane of panes) expect(pane.x + pane.width).toBeLessThanOrEqual(columns)
    }
  })

  test('has nothing to place for no agents', () => {
    expect(planPanes([], 100, 20)).toEqual({ panes: [], dividers: [] })
  })
})

describe('finding what was clicked', () => {
  const { panes, dividers } = planPanes(['a', 'b'], 101, 20)

  test('names the pane a point falls in', () => {
    expect(paneAt(panes, 10, 5)).toBe('a')
    expect(paneAt(panes, 60, 5)).toBe('b')
  })

  test('names nothing outside every pane', () => {
    expect(paneAt(panes, 10, 40)).toBeUndefined()
  })

  test('finds a rule slightly either side of it, since a border is thin', () => {
    expect(dividerAt(dividers, 50, 5)?.before).toBe('a')
    expect(dividerAt(dividers, 49, 5)?.before).toBe('a')
    expect(dividerAt(dividers, 30, 5)).toBeUndefined()
  })
})

describe('dragging a border', () => {
  const { panes } = planPanes(['a', 'b'], 101, 20)
  const boxes = { before: panes[0] as never, after: panes[1] as never }

  test('moves width from one pane to the other', () => {
    const weights = resize({}, 'a', 'b', 75, boxes)
    const { panes: after } = planPanes(['a', 'b'], 101, 20, weights)

    expect(after[0]?.width).toBeGreaterThan(70)
    expect(after[1]?.width).toBeLessThan(30)
  })

  test('leaves the pair as wide as it was, so the rest of the row is undisturbed', () => {
    const weights = resize({}, 'a', 'b', 75, boxes)

    expect((weights.a as number) + (weights.b as number)).toBeCloseTo(2)
  })

  test('refuses to drag a pane below readable', () => {
    const weights = resize({}, 'a', 'b', 2, boxes)
    const { panes: after } = planPanes(['a', 'b'], 101, 20, weights)

    expect(after[0]?.width).toBeGreaterThanOrEqual(24)
  })
})
