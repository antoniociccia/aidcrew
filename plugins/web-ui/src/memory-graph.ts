export type MemoryNode = {
  id: string
  kind: 'task' | 'author' | 'note' | 'summary'
  text: string
  task?: string
  author?: string
  at?: number
  x: number
  y: number
}

function identity(kind: string, ...parts: unknown[]): string {
  return `${kind}:${encodeURIComponent(JSON.stringify(parts))}`
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function memories(value: unknown): MemoryNode[] {
  if (!record(value)) return []
  const nodes: MemoryNode[] = []
  for (const [task, memory] of Object.entries(value)) {
    if (!record(memory)) continue
    if (typeof memory.summary === 'string' && memory.summary.trim()) {
      nodes.push({
        id: identity('summary', task, memory.summary),
        kind: 'summary',
        task,
        text: memory.summary,
        x: 0,
        y: 0,
      })
    }
    if (!Array.isArray(memory.notes)) continue
    for (const note of memory.notes) {
      if (
        !record(note) ||
        typeof note.from !== 'string' ||
        typeof note.text !== 'string' ||
        typeof note.at !== 'number' ||
        !Number.isFinite(note.at)
      )
        continue
      nodes.push({
        id: identity('note', task, note.from, note.text, note.at),
        kind: 'note',
        task,
        author: note.from,
        text: note.text,
        at: note.at,
        x: 0,
        y: 0,
      })
    }
  }
  return nodes
}

/** Links describe provenance only; proximity does not imply semantic similarity. */
export function memoryGraph(value: unknown, query = '') {
  const all = memories(value)
  const needle = query.trim().toLocaleLowerCase()
  const matched = all.filter((node) =>
    `${node.text} ${node.task} ${node.author ?? ''}`.toLocaleLowerCase().includes(needle),
  )
  const retained = matched.slice(-80)
  const tasks = [...new Set(retained.map((node) => node.task ?? ''))]
  const authors = [
    ...new Set(retained.flatMap((node) => (node.author === undefined ? [] : [node.author]))),
  ]
  const nodes: MemoryNode[] = []
  const edges: { from: string; to: string }[] = []
  for (const task of tasks)
    nodes.push({ id: identity('task', task), kind: 'task', text: task, task, x: 0, y: 0 })
  for (const author of authors)
    nodes.push({ id: identity('author', author), kind: 'author', text: author, author, x: 0, y: 0 })
  for (const node of retained) {
    nodes.push(node)
    edges.push({ from: identity('task', node.task), to: node.id })
    if (node.author !== undefined)
      edges.push({ from: identity('author', node.author), to: node.id })
  }
  return {
    nodes: constellation(nodes, edges, tasks),
    edges,
    total: all.length,
    matched: matched.length,
    shown: retained.length,
    omitted: matched.length - retained.length,
    tasks: tasks.length,
    authors: authors.length,
  }
}

/** Every relationship comes from a stored task or author field, never text similarity. */
export function memoryRelations(graph: ReturnType<typeof memoryGraph>, selected: string) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
  const edges = graph.edges.flatMap((edge) => {
    const fromNode = nodes.get(edge.from),
      toNode = nodes.get(edge.to)
    if (!fromNode || !toNode) return []
    return [
      {
        ...edge,
        id: JSON.stringify([edge.from, edge.to]),
        fromNode,
        toNode,
        relation: fromNode.kind === 'author' ? ('authored' as const) : ('contains' as const),
      },
    ]
  })
  return {
    incoming: edges.filter((edge) => edge.to === selected),
    outgoing: edges.filter((edge) => edge.from === selected),
  }
}

function hash(value: string): number {
  let result = 2166136261
  for (let index = 0; index < value.length; index++)
    result = Math.imul(result ^ value.charCodeAt(index), 16777619)
  return result >>> 0
}

/** A fixed-step spring simulation makes real shared authors connect task clusters. */
function constellation(
  nodes: MemoryNode[],
  edges: { from: string; to: string }[],
  tasks: string[],
) {
  const orderedTasks = [...tasks].sort()
  const anchors = new Map(
    orderedTasks.map((task, index) => {
      const angle = index * 2.399963
      const radius = orderedTasks.length === 1 ? 0 : 24 + 9 * Math.sqrt(index)
      return [task, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }]
    }),
  )
  const positions = nodes.map((node) => {
    const anchor = anchors.get(node.task ?? '') ?? { x: 0, y: 0 }
    const seed = hash(node.id),
      angle = (seed / 4294967296) * Math.PI * 2,
      radius = 4 + (seed % 17)
    return {
      node,
      x: anchor.x + Math.cos(angle) * radius,
      y: anchor.y + Math.sin(angle) * radius,
      anchor,
      vx: 0,
      vy: 0,
    }
  })
  const byId = new Map(positions.map((point) => [point.node.id, point]))
  for (let step = 0; step < 180; step++) {
    for (const [index, a] of positions.entries())
      for (const b of positions.slice(index + 1)) {
        const dx = a.x - b.x,
          dy = a.y - b.y,
          distance = Math.max(1, dx * dx + dy * dy)
        const force = 38 / distance
        a.vx += dx * force
        a.vy += dy * force
        b.vx -= dx * force
        b.vy -= dy * force
      }
    for (const edge of edges) {
      const a = byId.get(edge.from),
        b = byId.get(edge.to)
      if (!a || !b) continue
      const dx = b.x - a.x,
        dy = b.y - a.y,
        distance = Math.max(1, Math.hypot(dx, dy))
      const force = ((distance - 16) / distance) * 0.025
      a.vx += dx * force
      a.vy += dy * force
      b.vx -= dx * force
      b.vy -= dy * force
    }
    for (const point of positions) {
      point.vx += (point.anchor.x - point.x) * 0.012
      point.vy += (point.anchor.y - point.y) * 0.012
      point.x += Math.max(-3, Math.min(3, point.vx)) * 0.5
      point.y += Math.max(-3, Math.min(3, point.vy)) * 0.5
      point.vx *= 0.55
      point.vy *= 0.55
    }
  }
  const minX = Math.min(0, ...positions.map((point) => point.x)),
    maxX = Math.max(0, ...positions.map((point) => point.x))
  const minY = Math.min(0, ...positions.map((point) => point.y)),
    maxY = Math.max(0, ...positions.map((point) => point.y))
  const span = Math.max(40, maxX - minX, maxY - minY)
  return positions.map(({ node, x, y }) => ({
    ...node,
    x: 50 + ((x - (minX + maxX) / 2) / span) * 84,
    y: 50 + ((y - (minY + maxY) / 2) / span) * 84,
    color: node.task ? `hsl(${hash(node.task) % 360} 66% 64%)` : '#b7c8d3',
  }))
}
