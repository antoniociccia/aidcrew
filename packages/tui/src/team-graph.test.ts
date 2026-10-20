import { expect, test } from 'bun:test'
import { graphEdges, groupRoles, planTiles } from './team-graph.ts'

test('counts outgoing handoffs without counting their mirrored incoming notes', () => {
  expect(
    graphEdges(
      ['architect', 'tester'],
      [
        { agentId: 'architect', kind: 'note', text: '→ tester: run tests' },
        { agentId: 'tester', kind: 'note', text: '← architect: run tests' },
        { agentId: 'architect', kind: 'say', text: '→ tester: invented' },
        { agentId: 'architect', kind: 'note', text: '→ missing: removed' },
      ],
    ),
  ).toEqual([{ from: 'architect', to: 'tester', count: 1, text: 'run tests' }])
})

test('tiles form balanced rows and remain inside the terminal', () => {
  const plan = planTiles(['a', 'b', 'c', 'd'], 120, 36)
  expect(new Set(plan.panes.map((pane) => pane.y)).size).toBe(2)
  expect(plan.panes).toHaveLength(4)
  for (const pane of plan.panes) {
    expect(pane.x + pane.width).toBeLessThanOrEqual(120)
    expect(pane.y + pane.height).toBeLessThanOrEqual(36)
  }
  expect(planTiles(['a', 'b'], 20, 12).panes.every((pane) => pane.x === 0)).toBe(true)
})

test('does not place overflow tiles outside a tiny terminal', () => {
  const plan = planTiles(
    Array.from({ length: 10 }, (_, i) => String(i)),
    20,
    3,
  )
  expect(plan.panes.every((pane) => pane.y + pane.height <= 3)).toBe(true)
})

test('groups clones by their declared role independently of roster position', () => {
  const agents = [
    { id: 'tester-2', role: 'tester' },
    { id: 'architect', role: 'architect' },
    { id: 'test-specialist', role: 'tester' },
    { id: 'coder', role: 'coder' },
  ] as const
  expect(groupRoles(agents)).toEqual([
    { role: 'tester', agents: [agents[0], agents[2]] },
    { role: 'architect', agents: [agents[1]] },
    { role: 'coder', agents: [agents[3]] },
  ])
  expect(agents.map((agent) => agent.id)).toEqual([
    'tester-2',
    'architect',
    'test-specialist',
    'coder',
  ])
})

test('uses clone base names only when role metadata is missing', () => {
  expect(
    groupRoles([{ id: 'tester-2' }, { id: 'tester' }, { id: 'tester-3', role: 'reviewer' }]).map(
      (group) => ({ role: group.role, ids: group.agents.map((agent) => agent.id) }),
    ),
  ).toEqual([
    { role: 'tester', ids: ['tester-2', 'tester'] },
    { role: 'reviewer', ids: ['tester-3'] },
  ])
})
