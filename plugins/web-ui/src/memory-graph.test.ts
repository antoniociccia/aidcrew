import { expect, test } from 'bun:test'
import { memoryGraph, memoryRelations } from './memory-graph.ts'

test('connects notes only to their real task and author and never invents summary authors', () => {
  const graph = memoryGraph({
    main: { notes: [{ from: 'coder', text: 'Use SQLite', at: 123 }], summary: 'Earlier decisions' },
  })
  expect(graph.nodes.map((node) => node.kind).sort()).toEqual(['author', 'note', 'summary', 'task'])
  const note = graph.nodes.find((node) => node.kind === 'note')
  expect(note).toMatchObject({ text: 'Use SQLite', author: 'coder', task: 'main', at: 123 })
  expect(graph.edges.filter((edge) => edge.to === note?.id)).toHaveLength(2)
  const summary = graph.nodes.find((node) => node.kind === 'summary')
  expect(summary?.author).toBeUndefined()
  expect(graph.edges.filter((edge) => edge.to === summary?.id)).toHaveLength(1)
})

test('filters searchable content and limits notes while reporting omitted results', () => {
  const notes = Array.from({ length: 200 }, (_, index) => ({
    from: 'tester-2',
    text: `Evidence ${index}`,
    at: index,
  }))
  const graph = memoryGraph({ main: { notes } }, 'evidence')
  expect(graph.shown).toBe(80)
  expect(graph.matched).toBe(200)
  expect(graph.omitted).toBe(120)
  expect(memoryGraph({ main: { notes } }, 'absent').nodes).toEqual([])
  expect(memoryGraph({ main: { notes } }, 'tester-2').matched).toBe(200)
})

test('ignores malformed data and produces safe finite positions with opaque identifiers', () => {
  expect(memoryGraph(null).nodes).toEqual([])
  const graph = memoryGraph({
    '<svg>': {
      notes: [
        null,
        { from: 'a', text: 'b', at: 'bad' },
        { from: '<img>', text: '<script>', at: 1 },
      ],
    },
  })
  expect(graph.shown).toBe(1)
  expect(graph.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true)
  expect(graph.nodes.every((node) => !node.id.includes('<'))).toBe(true)
})

test('preserves note and source identity after append, filtering, or task insertion', () => {
  const note = { from: 'coder', text: 'Keep this selected', at: 1 }
  const before = memoryGraph({ main: { notes: [note] } })
  const after = memoryGraph(
    {
      earlier: { notes: [{ from: 'tester', text: 'Other', at: 0 }] },
      main: { notes: [note, { from: 'coder', text: 'New', at: 2 }] },
    },
    'Keep',
  )
  for (const node of before.nodes)
    expect(after.nodes.some((candidate) => candidate.id === node.id)).toBe(true)
})

test('exposes directed provenance with readable endpoints and no semantic links', () => {
  const graph = memoryGraph({
    world: {
      notes: [{ from: 'tester', text: 'Boundary verified', at: 1 }],
      summary: 'Earlier evidence',
    },
  })
  const note = graph.nodes.find((node) => node.kind === 'note')
  const relations = memoryRelations(graph, note?.id ?? '')
  expect(relations.outgoing).toEqual([])
  expect(relations.incoming.map((edge) => edge.relation).sort()).toEqual(['authored', 'contains'])
  expect(relations.incoming.map((edge) => edge.fromNode.text).sort()).toEqual(['tester', 'world'])
  expect(relations.incoming.every((edge) => edge.toNode.text === 'Boundary verified')).toBe(true)
  expect(new Set(relations.incoming.map((edge) => edge.id)).size).toBe(2)
  expect(memoryRelations(graph, 'missing')).toEqual({ incoming: [], outgoing: [] })
})

test('lays out a deterministic task-colored constellation without fixed source columns or invented points', () => {
  const memory = Object.fromEntries(
    ['world', 'evaluation', 'replay'].map((task, index) => [
      task,
      {
        notes: Array.from({ length: 8 }, (_, n) => ({
          from: `agent-${n % 3}`,
          text: `${task} evidence ${n}`,
          at: index * 10 + n,
        })),
      },
    ]),
  )
  const graph = memoryGraph(memory)
  expect(graph.nodes).toHaveLength(30)
  expect(graph.edges).toHaveLength(48)
  expect(memoryGraph(memory).nodes).toEqual(graph.nodes)
  expect(
    new Set(graph.nodes.filter((node) => node.kind === 'task').map((node) => node.x)).size,
  ).toBe(3)
  expect(
    new Set(graph.nodes.filter((node) => node.kind === 'author').map((node) => node.x)).size,
  ).toBe(3)
  expect(
    graph.nodes.every((node) => node.x >= 6 && node.x <= 94 && node.y >= 6 && node.y <= 94),
  ).toBe(true)
  for (const task of ['world', 'evaluation', 'replay'])
    expect(
      new Set(graph.nodes.filter((node) => node.task === task).map((node) => node.color)).size,
    ).toBe(1)
  expect(
    new Set(graph.nodes.filter((node) => node.kind === 'task').map((node) => node.color)).size,
  ).toBe(3)
})

test('keeps task colors stable across filtering and appended memory', () => {
  const note = { from: 'coder', text: 'Stable evidence', at: 1 }
  const original = memoryGraph({ world: { notes: [note] } }).nodes.find(
    (node) => node.kind === 'note',
  )
  const changed = memoryGraph(
    {
      extra: { notes: [{ from: 'tester', text: 'Other', at: 0 }] },
      world: { notes: [note, { from: 'coder', text: 'Appended', at: 2 }] },
    },
    'Stable',
  ).nodes.find((node) => node.kind === 'note')
  expect(changed?.color).toBe(original?.color)
  expect(changed?.id).toBe(original?.id)
})
