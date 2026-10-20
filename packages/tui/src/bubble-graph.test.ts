import { expect, test } from 'bun:test'
import { bubbleConnections, bubbleLayout, bubbleRows } from './bubble-graph.ts'
import { widthOf } from './components/text-width.ts'

const agents = ['architect', 'coder', 'tester', 'tester-2', 'reviewer'].map((id) => ({
  id,
  role: id.replace(/-\d+$/, ''),
  status: id === 'architect' ? 'working' : 'idle',
}))
test('places bounded non-overlapping spatial bubbles with larger working nodes', () => {
  const nodes = bubbleLayout(agents, 'architect', 100, 20)
  expect(nodes).toHaveLength(5)
  expect(nodes.find((node) => node.id === 'architect')?.height).toBe(5)
  expect(nodes.find((node) => node.id === 'coder')?.height).toBe(3)
  for (const node of nodes) {
    expect(node.x).toBeGreaterThanOrEqual(0)
    expect(node.y).toBeGreaterThanOrEqual(0)
    expect(node.x + node.width).toBeLessThanOrEqual(100)
    expect(node.y + node.height).toBeLessThanOrEqual(20)
    for (const other of nodes.filter((other) => other.id !== node.id)) {
      expect(
        node.x + node.width <= other.x ||
          other.x + other.width <= node.x ||
          node.y + node.height <= other.y ||
          other.y + other.height <= node.y,
      ).toBe(true)
    }
  }
})
test('keeps the selected agent visible on small terminals', () => {
  expect(bubbleLayout(agents, 'tester-2', 30, 7).some((node) => node.id === 'tester-2')).toBe(true)
})
test('draws real directed connections between oval bubbles without card borders', () => {
  const rows = bubbleRows(
    agents,
    [{ from: 'architect', to: 'coder', count: 2, text: 'build' }],
    'architect',
    100,
    20,
  )
  const text = rows.map((row) => row.segments.map((part) => part.text).join('')).join('\n')
  expect(text).toContain('architect')
  expect(text).toContain('coder')
  expect(text).toMatch(/[▶◀▲▼]/)
  expect(text).toContain('2')
  expect(text).not.toContain('│')
  expect(rows).toHaveLength(20)
})

test('tiny canvases and wide labels remain bounded without terminal controls', () => {
  for (const width of [8, 12, 30]) {
    const rows = bubbleRows(
      [{ id: '测试-agent\u001b[2J', status: 'working' }],
      [],
      '测试-agent\u001b[2J',
      width,
      7,
    )
    expect(rows).toHaveLength(7)
    for (const row of rows) {
      const text = row.segments.map((segment) => segment.text).join('')
      expect(widthOf(text)).toBeLessThanOrEqual(width)
      expect(text).not.toContain('\u001b')
    }
  }
})

test('reciprocal edges use separate endpoints and keep both arrowheads', () => {
  const edges = [
    { from: 'architect', to: 'coder', count: 12, text: '' },
    { from: 'coder', to: 'architect', count: 3, text: '' },
  ]
  const nodes = bubbleLayout(agents, 'architect', 100, 20)
  const paths = bubbleConnections(nodes, edges, 100, 20)
  expect(paths.every((connection) => connection.path.length > 1)).toBe(true)
  expect(paths[0]?.path[0]).not.toEqual(paths[1]?.path.at(-1))
  const text = bubbleRows(agents, edges, 'architect', 100, 20)
    .map((row) => row.segments.map((part) => part.text).join(''))
    .join('\n')
  expect([...text.matchAll(/[▶◀▲▼]/g)]).toHaveLength(2)
  expect(text).toContain('12')
})

test('connection paths never enter an agent bubble', () => {
  const nodes = bubbleLayout(agents, 'architect', 80, 12)
  const edges = agents
    .slice(1)
    .map((agent) => ({ from: 'architect', to: agent.id, count: 1, text: '' }))
  for (const connection of bubbleConnections(nodes, edges, 80, 12)) {
    expect(connection.path.length).toBeGreaterThan(0)
    for (const point of connection.path) {
      expect(
        nodes.some(
          (node) =>
            point.x >= node.x &&
            point.x < node.x + node.width &&
            point.y >= node.y &&
            point.y < node.y + node.height,
        ),
      ).toBe(false)
    }
  }
})
