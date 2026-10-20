type GraphAgent = {
  id: string
  role: string
  status: string
  queued: number
  task?: string
  provider?: string
  model?: string
  lastText?: string
}
type GraphLine = { agentId: string; kind: string; text: string }
const bubbleSize = (status: string) =>
  status === 'working'
    ? { bubbleWidth: 220, bubbleHeight: 166 }
    : { bubbleWidth: 164, bubbleHeight: 118 }

export type HandoffMessage = {
  id: string
  from: string
  to: string
  text: string
  index: number
  source: 'outgoing' | 'paired-incoming'
}
export type GraphEdge = {
  id: string
  from: string
  to: string
  count: number
  text: string
  messages: HandoffMessage[]
  currentTasks: { agentId: string; task: string; source: 'current-agent-snapshot' }[]
}

function fullMessage(
  lines: readonly GraphLine[],
  index: number,
  from: string,
  to: string,
  text: string,
) {
  const mirror = lines[index + 1]
  const prefix = `← ${from}: `
  if (mirror?.agentId === to && mirror.kind === 'note' && mirror.text.startsWith(prefix)) {
    const complete = mirror.text.slice(prefix.length)
    const first = complete.split('\n').find((line) => line.trim() !== '') ?? ''
    // Runtime journals the first nonempty line, clipped to 90 code units.
    const preview = first.length > 90 ? `${first.slice(0, 90)}…` : first
    if (complete === text || preview === text) {
      return { text: complete, source: 'paired-incoming' as const }
    }
  }
  return { text, source: 'outgoing' as const }
}

function recordedEdges(agents: readonly GraphAgent[], lines: readonly GraphLine[]): GraphEdge[] {
  const known = new Map(agents.map((agent) => [agent.id, agent]))
  const edges = new Map<string, GraphEdge>()
  const occurrences = new Map<string, number>()
  lines.forEach((line, index) => {
    if (line.kind !== 'note' || !known.has(line.agentId)) return
    const match = /^→ ([^:]+): ?([\s\S]*)$/.exec(line.text)
    const to = match?.[1]
    if (!to || !known.has(to) || to === line.agentId) return
    const id = JSON.stringify([line.agentId, to])
    const message = fullMessage(lines, index, line.agentId, to, match?.[2] ?? '')
    const identity = JSON.stringify([line.agentId, to, message.text])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    const edge = edges.get(id) ?? {
      id,
      from: line.agentId,
      to,
      count: 0,
      text: '',
      messages: [],
      currentTasks: [line.agentId, to].flatMap((agentId) => {
        const task = known.get(agentId)?.task
        return task ? [{ agentId, task, source: 'current-agent-snapshot' as const }] : []
      }),
    }
    edge.messages.push({
      id: `${identity}:${occurrence}`,
      from: line.agentId,
      to,
      index,
      ...message,
    })
    edge.count = edge.messages.length
    edge.text = message.text
    edges.set(id, edge)
  })
  return [...edges.values()]
}

/** Only outgoing journal notes represent handoffs; incoming copies must not double-count. */
export function teamGraph(agents: readonly GraphAgent[], lines: readonly GraphLine[]) {
  const edges = recordedEdges(agents, lines)
  const sorted = [...agents].sort((a, b) => a.id.localeCompare(b.id))
  const roles = [
    ...new Set(sorted.map((agent) => (agent.role.trim() || agent.id).toLowerCase())),
  ].sort()
  const clusters = roles.map((key, index) => ({
    key,
    label:
      sorted.find((agent) => (agent.role.trim() || agent.id).toLowerCase() === key)?.role.trim() ||
      key,
    index,
    count: sorted.filter((agent) => (agent.role.trim() || agent.id).toLowerCase() === key).length,
  }))
  const width = Math.max(320, roles.length * 250 + 60)
  const height = Math.max(520, Math.max(0, ...clusters.map((cluster) => cluster.count)) * 190 + 160)
  const rows = new Map<string, number>()
  const nodes = sorted.map((agent) => {
    const role = (agent.role.trim() || agent.id).toLowerCase()
    const column = roles.indexOf(role)
    const row = rows.get(role) ?? 0
    rows.set(role, row + 1)
    const tags = [
      { kind: 'role', key: `role:${role}`, label: agent.role.trim() || agent.id },
      ...(agent.provider
        ? [{ kind: 'provider', key: `provider:${agent.provider}`, label: agent.provider }]
        : []),
      ...(agent.task ? [{ kind: 'task', key: `task:${agent.task}`, label: agent.task }] : []),
    ]
    const history = lines.filter((line) => line.agentId === agent.id && line.kind !== 'thinking')
    const assignment =
      history.findLast(
        (line) => line.kind === 'ask' || (line.kind === 'note' && line.text.startsWith('← ')),
      )?.text ?? ''
    const latest = history.findLast((line) => ['tool', 'say', 'error'].includes(line.kind))
    return {
      ...agent,
      assignment,
      ...bubbleSize(agent.status),
      tags,
      workKind: latest?.kind ?? 'say',
      work: latest?.text ?? agent.lastText ?? '',
      recent: history
        .filter((line) => ['tool', 'say', 'error', 'note'].includes(line.kind))
        .slice(-4),
      x: ((155 + column * 250) / width) * 100,
      y:
        ((height / 2 +
          (row - ((clusters[column]?.count ?? 1) - 1) / 2) * 190 +
          (column % 2 ? 12 : -12)) /
          height) *
        100,
    }
  })
  return { nodes, edges, clusters, width, height }
}

/** Attach to ellipse perimeters and bend around other bubbles, never through their labels. */
export function bubbleConnections(graph: ReturnType<typeof teamGraph>) {
  const nodes = graph.nodes.map((node) => ({
    ...node,
    cx: (node.x * graph.width) / 100,
    cy: (node.y * graph.height) / 100,
  }))
  return graph.edges.flatMap((edge) => {
    const from = nodes.find((node) => node.id === edge.from)
    const to = nodes.find((node) => node.id === edge.to)
    if (!from || !to) return []
    const dx = to.cx - from.cx,
      dy = to.cy - from.cy
    const length = Math.hypot(dx, dy) || 1
    const reciprocal = graph.edges.some((other) => other.from === edge.to && other.to === edge.from)
    const compact = from.bubbleWidth <= 24
    const bends = compact
      ? reciprocal
        ? [24, 50, 80]
        : [0, 35, -35, 75, -75]
      : reciprocal
        ? [100, 180, 260, 340]
        : [55, -55, 160, -160, 260, -260, 340, -340]
    const attach = (node: typeof from, control: { x: number; y: number }) => {
      const vx = control.x - node.cx,
        vy = control.y - node.cy
      const scale =
        1 /
        Math.sqrt((vx / (node.bubbleWidth / 2 + 6)) ** 2 + (vy / (node.bubbleHeight / 2 + 6)) ** 2)
      return { x: node.cx + vx * scale, y: node.cy + vy * scale }
    }
    const curves = bends.map((bend) => {
      const control = {
        x: (from.cx + to.cx) / 2 - (dy / length) * bend,
        y: (from.cy + to.cy) / 2 + (dx / length) * bend,
      }
      const start = attach(from, control),
        end = attach(to, control)
      const sample = (t: number) => ({
        x: (1 - t) ** 2 * start.x + 2 * (1 - t) * t * control.x + t * t * end.x,
        y: (1 - t) ** 2 * start.y + 2 * (1 - t) * t * control.y + t * t * end.y,
      })
      const points = Array.from({ length: 25 }, (_, index) => sample(index / 24))
      const collisions = points.filter(
        (point) =>
          point.x < 0 ||
          point.y < 0 ||
          point.x > graph.width ||
          point.y > graph.height ||
          nodes.some(
            (node) =>
              node.id !== from.id &&
              node.id !== to.id &&
              ((point.x - node.cx) / (node.bubbleWidth / 2 + 12)) ** 2 +
                ((point.y - node.cy) / (node.bubbleHeight / 2 + 12)) ** 2 <
                1,
          ),
      ).length
      return { ...edge, start, end, control, label: sample(0.5), collisions }
    })
    const curve =
      curves.find((curve) => curve.collisions === 0) ??
      curves.sort((a, b) => a.collisions - b.collisions)[0]
    return curve ? [curve] : []
  })
}

/** Current assignments are context, never evidence of a past message's task. */
export function agentInteractions(graph: ReturnType<typeof teamGraph>, agentId: string) {
  const incoming = graph.edges.filter((edge) => edge.to === agentId)
  const outgoing = graph.edges.filter((edge) => edge.from === agentId)
  const currentTask = graph.nodes.find((node) => node.id === agentId)?.task
  return {
    incoming,
    outgoing,
    messages: [...incoming, ...outgoing]
      .flatMap((edge) => edge.messages)
      .sort((a, b) => a.index - b.index),
    ...(currentTask ? { currentTask } : {}),
  }
}

/** A focused neighborhood keeps unrelated traffic out of the default reading path. */
export function focusGraph(
  graph: ReturnType<typeof teamGraph>,
  focus: string,
  direction: 'all' | 'incoming' | 'outgoing' = 'all',
): ReturnType<typeof teamGraph> {
  const center = graph.nodes.find((node) => node.id === focus)
  if (!center) return graph
  const incident = graph.edges.filter((edge) => edge.from === focus || edge.to === focus)
  const related = new Set(incident.flatMap((edge) => [edge.from, edge.to]))
  const peers = graph.nodes
    .filter((node) => node.id !== focus && related.has(node.id))
    .sort(
      (a, b) =>
        a.role.toLowerCase().localeCompare(b.role.toLowerCase()) || a.id.localeCompare(b.id),
    )
  const width = Math.max(860, peers.length * 95 + 290)
  const height = Math.max(600, peers.length * 65 + 210)
  const nodes = [
    { ...center, x: 50, y: 50, bubbleWidth: 186, bubbleHeight: 142 },
    ...peers.map((node, index) => {
      const angle = -Math.PI / 2 + (index * Math.PI * 2) / Math.max(1, peers.length)
      return {
        ...node,
        x: 50 + 34 * Math.cos(angle),
        y: 50 + 34 * Math.sin(angle),
        bubbleWidth: node.status === 'working' ? 164 : 150,
        bubbleHeight: node.status === 'working' ? 120 : 108,
      }
    }),
  ]
  const edges = incident.filter(
    (edge) =>
      direction === 'all' || (direction === 'incoming' ? edge.to === focus : edge.from === focus),
  )
  return { ...graph, nodes, edges, width, height }
}

/** A deterministic spring layout reflects recorded links without hiding isolated agents. */
export function networkGraph(graph: ReturnType<typeof teamGraph>): ReturnType<typeof teamGraph> {
  const width = Math.max(860, Math.sqrt(graph.nodes.length) * 310)
  const height = Math.max(560, Math.sqrt(graph.nodes.length) * 205)
  const points = [...graph.nodes]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node, index) => ({
      node,
      x: width * 0.43 + Math.cos(index * 2.39996) * Math.sqrt(index + 1) * 65,
      y: height * 0.5 + Math.sin(index * 2.39996) * Math.sqrt(index + 1) * 65,
    }))
  for (let iteration = 0; iteration < 220; iteration++) {
    const forces = points.map((point) => ({
      x: (width * 0.43 - point.x) * 0.008,
      y: (height * 0.5 - point.y) * 0.008,
    }))
    points.forEach((a, i) => {
      points.slice(i + 1).forEach((b, j) => {
        const other = i + j + 1,
          dx = b.x - a.x,
          dy = b.y - a.y,
          distance = Math.max(1, Math.hypot(dx, dy))
        const linked = graph.edges.some(
          (edge) =>
            (edge.from === a.node.id && edge.to === b.node.id) ||
            (edge.to === a.node.id && edge.from === b.node.id),
        )
        const sameRole = a.node.role === b.node.role
        const force =
          12000 / (distance * distance) - (linked || sameRole ? (distance - 180) * 0.018 : 0)
        const first = forces[i],
          second = forces[other]
        if (first && second) {
          first.x -= (dx / distance) * force
          first.y -= (dy / distance) * force
          second.x += (dx / distance) * force
          second.y += (dy / distance) * force
        }
      })
    })
    points.forEach((point, index) => {
      const force = forces[index]
      if (force) {
        point.x = Math.max(65, Math.min(width - 180, point.x + force.x))
        point.y = Math.max(65, Math.min(height - 65, point.y + force.y))
      }
    })
  }
  const minX = Math.min(...points.map((point) => point.x)),
    maxX = Math.max(...points.map((point) => point.x))
  const minY = Math.min(...points.map((point) => point.y)),
    maxY = Math.max(...points.map((point) => point.y))
  return {
    ...graph,
    width,
    height,
    nodes: points.map(({ node, x, y }) => ({
      ...node,
      x: maxX === minX ? 43 : 15 + ((x - minX) / (maxX - minX)) * 60,
      y: maxY === minY ? 50 : 17 + ((y - minY) / (maxY - minY)) * 66,
      bubbleWidth: node.status === 'working' ? 24 : 18,
      bubbleHeight: node.status === 'working' ? 24 : 18,
    })),
  }
}
