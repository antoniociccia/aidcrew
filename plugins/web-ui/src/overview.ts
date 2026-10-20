import type { WebState } from './protocol.ts'

type OverviewAgent = {
  id: string
  role: string
  status: string
  queued: number
  task?: string
  provider?: string
  model?: string
}
type Activity = { kind: 'tool' | 'say' | 'error'; text: string }
type Group = 'working' | 'approval' | 'stopped' | 'idle'
type Assignment = { kind: 'ask' | 'note'; text: string }
type CrewRow = OverviewAgent & { group: Group; latest?: Activity; assignment?: Assignment }
type Pending = NonNullable<WebState['pending']>
type Attention =
  | { agentId: string; kind: 'approval'; pending: Pending }
  | { agentId: string; kind: 'stopped'; error: string }
type OverviewState = {
  agents: readonly OverviewAgent[]
  lines: WebState['lines']
  pending?: Pending
  target?: string
}

function latestActivities(lines: WebState['lines']): Map<string, Activity> {
  const latest = new Map<string, Activity>()
  for (const line of lines) {
    if (['tool', 'say', 'error'].includes(line.kind) && line.text.trim()) {
      latest.set(line.agentId, { kind: line.kind as Activity['kind'], text: line.text })
    }
  }
  return latest
}

function latestAssignments(lines: WebState['lines']): Map<string, Assignment> {
  const assignments = new Map<string, Assignment>()
  for (const line of lines) {
    if (
      line.text.trim() &&
      (line.kind === 'ask' || (line.kind === 'note' && line.text.startsWith('← ')))
    ) {
      assignments.set(line.agentId, { kind: line.kind as Assignment['kind'], text: line.text })
    }
  }
  return assignments
}

function groupFor(agent: OverviewAgent, pending?: Pending): Group {
  if (pending?.agentId === agent.id) return 'approval'
  if (agent.status === 'working') return 'working'
  if (agent.status === 'stopped') return 'stopped'
  return 'idle'
}

/** Reports observed state only: idle is not evidence that a task is complete. */
export function overview(state: OverviewState) {
  const latest = latestActivities(state.lines)
  const assignments = latestAssignments(state.lines)
  const crew: CrewRow[] = state.agents.map((agent) => {
    const activity = latest.get(agent.id)
    const assignment = assignments.get(agent.id)
    return {
      ...agent,
      group: groupFor(agent, state.pending),
      ...(activity ? { latest: activity } : {}),
      ...(assignment ? { assignment } : {}),
    }
  })
  const groups = {
    working: crew.filter((agent) => agent.group === 'working'),
    approval: crew.filter((agent) => agent.group === 'approval'),
    stopped: crew.filter((agent) => agent.group === 'stopped'),
    idle: crew.filter((agent) => agent.group === 'idle'),
  }
  const attention: Attention[] = []
  if (state.pending)
    attention.push({ agentId: state.pending.agentId, kind: 'approval', pending: state.pending })
  for (const agent of groups.stopped) {
    if (agent.latest?.kind === 'error')
      attention.push({ agentId: agent.id, kind: 'stopped', error: agent.latest.text })
  }
  const architect =
    crew.find((agent) => agent.id === 'architect') ??
    crew.find((agent) => agent.role.toLowerCase() === 'architect')
  const lead = architect ?? crew.find((agent) => agent.id === state.target) ?? crew[0]
  const request = architect
    ? state.lines.find(
        (line) => line.agentId === architect.id && line.kind === 'ask' && line.text.trim(),
      )
    : undefined
  const update = lead
    ? state.lines.findLast(
        (line) => line.agentId === lead.id && line.kind === 'say' && line.text.trim(),
      )
    : undefined
  return {
    hasHistory: state.lines.length > 0,
    ...(update ? { leadUpdate: { agentId: update.agentId, text: update.text } } : {}),
    crew,
    groups,
    counts: {
      total: crew.length,
      working: crew.filter((agent) => agent.status === 'working').length,
      approval: groups.approval.length,
      stopped: crew.filter((agent) => agent.status === 'stopped').length,
      idle: crew.filter((agent) => agent.status === 'idle').length,
      queued: crew.reduce((count, agent) => count + agent.queued, 0),
    },
    tasks: [...new Set(crew.flatMap((agent) => (agent.task ? [agent.task] : [])))],
    attention,
    ...(lead ? { lead } : {}),
    ...(request ? { startingRequest: { agentId: request.agentId, text: request.text } } : {}),
  }
}
