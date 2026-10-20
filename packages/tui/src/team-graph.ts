import type { Plan } from './layout.ts'
import type { Line } from './screens/session.tsx'

export type TeamEdge = { from: string; to: string; count: number; text: string }

export function graphEdges(ids: readonly string[], lines: readonly Line[]): TeamEdge[] {
  const known = new Set(ids)
  const edges = new Map<string, TeamEdge>()
  for (const line of lines) {
    if (line.kind !== 'note' || !known.has(line.agentId)) continue
    const match = /^→ ([^:]+): (.*)/.exec(line.text)
    const to = match?.[1]
    if (!to || !known.has(to) || to === line.agentId) continue
    const key = `${line.agentId}\0${to}`
    edges.set(key, {
      from: line.agentId,
      to,
      count: (edges.get(key)?.count ?? 0) + 1,
      text: match?.[2] ?? '',
    })
  }
  return [...edges.values()]
}

/** Terminal cells are taller than they are wide; two columns give readable work tiles. */
export function planTiles(ids: string[], columns: number, rows: number): Plan {
  if (!ids.length || columns < 1 || rows < 1) return { panes: [], dividers: [] }
  const across = Math.min(Math.max(1, Math.floor(columns / 36)), Math.ceil(Math.sqrt(ids.length)))
  const displayed = ids.slice(0, across * rows)
  const bands = Math.ceil(displayed.length / across)
  const height = Math.max(1, Math.floor(rows / bands))
  const panes: Plan['panes'] = []
  const dividers: Plan['dividers'] = []
  for (let i = 0; i < displayed.length; i++) {
    const band = Math.floor(i / across)
    const offset = i % across
    const count = Math.min(across, displayed.length - band * across)
    const width = Math.floor((columns - count + 1) / count)
    const x = offset * (width + 1)
    const id = ids[i]
    if (!id) continue
    panes.push({
      id,
      x,
      y: band * height,
      width: offset === count - 1 ? columns - x : width,
      height,
    })
    const before = ids[i - 1]
    if (offset && before) dividers.push({ x: x - 1, y: band * height, height, before, after: id })
  }
  return { panes, dividers }
}

/** Explicit role metadata wins: a named specialist can still belong to the tester group. */
export function groupRoles<T extends { id: string; role?: string }>(
  agents: readonly T[],
): { role: string; agents: T[] }[] {
  const grouped = new Map<string, T[]>()
  for (const agent of agents) {
    const role = agent.role?.trim() || agent.id.replace(/-\d+$/, '')
    const peers = grouped.get(role) ?? []
    peers.push(agent)
    grouped.set(role, peers)
  }
  return [...grouped].map(([role, peers]) => ({ role, agents: peers }))
}
