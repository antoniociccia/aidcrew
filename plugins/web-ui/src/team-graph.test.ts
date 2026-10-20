import { expect, test } from 'bun:test'
import {
  agentInteractions,
  bubbleConnections,
  focusGraph,
  networkGraph,
  teamGraph,
} from './team-graph.ts'

const agent = (id: string, overrides = {}) => ({
  id,
  role: id,
  status: 'idle',
  activity: [],
  queued: 0,
  ...overrides,
})

test('uses actual outgoing handoffs once and ignores quoted content and unknown teammates', () => {
  const result = teamGraph(
    [agent('architect'), agent('coder')],
    [
      { agentId: 'architect', kind: 'note', text: '→ coder: Build parser' },
      { agentId: 'coder', kind: 'note', text: '← architect: Build parser' },
      { agentId: 'architect', kind: 'say', text: '→ coder: imagined' },
      { agentId: 'architect', kind: 'note', text: '→ departed: old task' },
      { agentId: 'architect', kind: 'note', text: '→ coder: Add tests' },
    ],
  )
  expect(result.edges).toMatchObject([
    { from: 'architect', to: 'coder', count: 2, text: 'Add tests' },
  ])
})

test('reports latest public work and explicit roles without exposing reasoning', () => {
  const result = teamGraph(
    [agent('builder', { role: 'Implementation', status: 'working', activity: [2] })],
    [
      { agentId: 'builder', kind: 'ask', text: 'Build the parser' },
      { agentId: 'builder', kind: 'tool', text: 'read src/parser.ts' },
      { agentId: 'builder', kind: 'thinking', text: 'Private reasoning' },
    ],
  )
  expect(result.nodes[0]).toMatchObject({
    id: 'builder',
    role: 'Implementation',
    work: 'read src/parser.ts',
    assignment: 'Build the parser',
    status: 'working',
  })
  expect(JSON.stringify(result)).not.toContain('Private reasoning')
})

test('keeps positions stable when input order changes and handles empty teams', () => {
  expect(teamGraph([], [])).toMatchObject({ nodes: [], edges: [], clusters: [] })
  const forward = teamGraph([agent('z'), agent('a')], []).nodes
  expect(teamGraph([agent('a'), agent('z')], []).nodes).toEqual(forward)
  expect(forward.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
})

test('aligns same-role agents in vertical role clusters and assigns explicit role provider and task tags', () => {
  const result = teamGraph(
    [
      agent('tester-2', { role: ' Quality ', provider: 'opencode-go', task: 'world' }),
      agent('architect', { role: 'Architecture', provider: 'claude-code', task: 'main' }),
      agent('tester', { role: 'quality', provider: 'opencode-go', task: 'world' }),
    ],
    [],
  )
  const tester = result.nodes.find((node) => node.id === 'tester')
  const clone = result.nodes.find((node) => node.id === 'tester-2')
  expect(tester?.x).toBe(clone?.x)
  expect(tester?.y).not.toBe(clone?.y)
  expect(result.clusters.map((lane) => lane.key)).toEqual(['architecture', 'quality'])
  expect(tester?.tags).toContainEqual({ kind: 'role', key: 'role:quality', label: 'quality' })
  expect(tester?.tags).toContainEqual({
    kind: 'provider',
    key: 'provider:opencode-go',
    label: 'opencode-go',
  })
  expect(tester?.tags).toContainEqual({ kind: 'task', key: 'task:world', label: 'world' })
})

test('labels past errors separately from the current agent status', () => {
  const result = teamGraph(
    [agent('tester', { status: 'working' })],
    [{ agentId: 'tester', kind: 'error', text: 'Old request rejected' }],
  )
  expect(result.nodes[0]).toMatchObject({
    status: 'working',
    workKind: 'error',
    work: 'Old request rejected',
  })
})

test('sizes real ellipse nodes by activity and centers vertical role clusters without lanes', () => {
  const graph = teamGraph(
    [
      agent('architect', { status: 'working' }),
      agent('tester'),
      agent('tester-2', { role: 'tester' }),
    ],
    [],
  )
  const active = graph.nodes.find((node) => node.id === 'architect')
  const idle = graph.nodes.find((node) => node.id === 'tester')
  expect(active?.bubbleWidth).toBeGreaterThan(idle?.bubbleWidth ?? 0)
  expect(active?.bubbleHeight).toBeGreaterThan(idle?.bubbleHeight ?? 0)
  expect(graph.clusters).toHaveLength(2)
  expect(graph).not.toHaveProperty('lanes')
})

test('curves long handoffs around unrelated bubbles and keeps reciprocal paths distinct', () => {
  const graph = teamGraph(
    [agent('a'), agent('b'), agent('c')],
    [
      { agentId: 'a', kind: 'note', text: '→ c: Build' },
      { agentId: 'c', kind: 'note', text: '→ a: Done' },
    ],
  )
  const paths = bubbleConnections(graph)
  expect(paths).toHaveLength(2)
  expect(paths.every((path) => path.collisions === 0)).toBe(true)
  expect(paths[0]?.control).not.toEqual(paths[1]?.control)
  expect(paths.every((path) => Number.isFinite(path.start.x) && Number.isFinite(path.end.y))).toBe(
    true,
  )
})

test('retains chronological complete messages, restoring only the adjacent matching mirror', () => {
  const graph = teamGraph(
    [agent('a'), agent('b')],
    [
      { agentId: 'a', kind: 'note', text: '→ b: First line' },
      { agentId: 'b', kind: 'note', text: '← a: First line\nSecond line' },
      { agentId: 'b', kind: 'note', text: '→ a: Reply\nAlready complete' },
      { agentId: 'unknown', kind: 'note', text: '→ a: Not a member' },
      { agentId: 'a', kind: 'note', text: '→ b: Next' },
      { agentId: 'b', kind: 'note', text: '← a: Different message\nDo not attach' },
    ],
  )
  const interactions = agentInteractions(graph, 'a')
  expect(interactions.incoming).toHaveLength(1)
  expect(interactions.outgoing).toHaveLength(1)
  expect(interactions.messages.map((message) => [message.index, message.text])).toEqual([
    [0, 'First line\nSecond line'],
    [2, 'Reply\nAlready complete'],
    [4, 'Next'],
  ])
  expect(graph.edges.every((edge) => edge.count === edge.messages.length)).toBe(true)
  expect(graph.edges[0]?.messages[0]?.source).toBe('paired-incoming')
})

test('does not infer historical task provenance from current assignments', () => {
  const graph = teamGraph(
    [agent('a', { task: 'new-task' }), agent('b')],
    [{ agentId: 'a', kind: 'note', text: '→ b: Past decision' }],
  )
  expect(graph.edges[0]?.messages[0]).not.toHaveProperty('task')
  expect(graph.edges[0]?.currentTasks).toEqual([
    { agentId: 'a', task: 'new-task', source: 'current-agent-snapshot' },
  ])
  expect(agentInteractions(graph, 'missing')).toEqual({ incoming: [], outgoing: [], messages: [] })
})

test('keeps message identity stable across appended lines and distinguishes repeated messages', () => {
  const agents = [agent('a'), agent('b')]
  const line = { agentId: 'a', kind: 'note', text: '→ b: Same message' }
  const first = teamGraph(agents, [line, line])
  const next = teamGraph(agents, [line, line, { agentId: 'b', kind: 'say', text: 'Later' }])
  expect(first.edges[0]?.messages.map((message) => message.id)).toEqual(
    next.edges[0]?.messages.map((message) => message.id),
  )
  expect(new Set(first.edges[0]?.messages.map((message) => message.id)).size).toBe(2)
})

test('restores long handoffs from the exact runtime preview without losing leading blank lines', () => {
  const first = 'A'.repeat(120)
  const full = `\n\n${first}\nFull instruction body`
  const graph = teamGraph(
    [agent('a'), agent('b')],
    [
      { agentId: 'a', kind: 'note', text: `→ b: ${first.slice(0, 90)}…` },
      { agentId: 'b', kind: 'note', text: `← a: ${full}` },
    ],
  )
  expect(graph.edges[0]?.messages[0]?.text).toBe(full)
})

test('focuses a deterministic center with only actual incident edges and nearby role peers', () => {
  const graph = teamGraph(
    [
      agent('architect'),
      agent('coder'),
      agent('tester'),
      agent('tester-2', { role: 'tester' }),
      agent('observer'),
    ],
    [
      { agentId: 'architect', kind: 'note', text: '→ coder: Build' },
      { agentId: 'tester', kind: 'note', text: '→ architect: Tests passed' },
      { agentId: 'architect', kind: 'note', text: '→ tester-2: Verify' },
      { agentId: 'coder', kind: 'note', text: '→ tester: Review' },
    ],
  )
  const focused = focusGraph(graph, 'architect')
  expect(focused.nodes.find((node) => node.id === 'architect')).toMatchObject({ x: 50, y: 50 })
  expect(focused.nodes.map((node) => node.id)).not.toContain('observer')
  expect(focused.edges).toHaveLength(3)
  expect(focused.edges.every((edge) => edge.from === 'architect' || edge.to === 'architect')).toBe(
    true,
  )
  expect(focusGraph(graph, 'architect', 'incoming').edges.map((edge) => edge.from)).toEqual([
    'tester',
  ])
  expect(focusGraph(graph, 'architect', 'incoming').nodes).toEqual(focused.nodes)
  expect(focusGraph({ ...graph, nodes: [...graph.nodes].reverse() }, 'architect')).toEqual(focused)
  for (const a of focused.nodes)
    for (const b of focused.nodes.filter((node) => node.id !== a.id)) {
      const dx = (Math.abs(a.x - b.x) * focused.width) / 100,
        dy = (Math.abs(a.y - b.y) * focused.height) / 100
      expect(
        dx >= (a.bubbleWidth + b.bubbleWidth) / 2 || dy >= (a.bubbleHeight + b.bubbleHeight) / 2,
      ).toBe(true)
    }
})

test('keeps an isolated focused agent visible without fabricating relationships', () => {
  const graph = teamGraph([agent('solo'), agent('other')], [])
  const focused = focusGraph(graph, 'solo')
  expect(focused.nodes.map((node) => node.id)).toEqual(['solo'])
  expect(focused.edges).toEqual([])
  expect(focusGraph(graph, 'missing')).toEqual(graph)
})

test('places the complete team as deterministic compact network dots with label clearance', () => {
  const agents = [
    'architect',
    'coder',
    'reviewer',
    'tester',
    'tester-2',
    'writer',
    'researcher',
  ].map((id) => agent(id))
  const lines = agents
    .slice(1)
    .map((item) => ({ agentId: 'architect', kind: 'note', text: `→ ${item.id}: Check` }))
  const graph = networkGraph(teamGraph(agents, lines))
  expect(graph.nodes).toHaveLength(7)
  expect(graph.edges).toHaveLength(6)
  expect(networkGraph(teamGraph([...agents].reverse(), lines))).toEqual(graph)
  for (const node of graph.nodes) {
    expect(node.bubbleWidth).toBeLessThanOrEqual(24)
    expect(node.bubbleWidth).toBe(node.bubbleHeight)
    expect(node.x).toBeGreaterThan(5)
    expect(node.x).toBeLessThan(85)
    for (const peer of graph.nodes.filter((peer) => peer.id !== node.id)) {
      expect(
        Math.hypot(
          ((node.x - peer.x) * graph.width) / 100,
          ((node.y - peer.y) * graph.height) / 100,
        ),
      ).toBeGreaterThan(100)
    }
  }
})
