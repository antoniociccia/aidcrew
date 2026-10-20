import { stripVTControlCharacters } from 'node:util'
import { agentAvatar } from '@aidcrew/core'
import type { PaintedRow } from './components/paint.ts'
import type { Segment } from './components/row.ts'
import { cutAt, widthOf } from './components/text-width.ts'
import { groupRoles, type TeamEdge } from './team-graph.ts'

export function terminalLabel(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: terminal labels must never execute control sequences
  return stripVTControlCharacters(text).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
}

type BubbleAgent = { id: string; role?: string; status: string }
export type Bubble = BubbleAgent & { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }

export function bubbleLayout(
  agents: readonly BubbleAgent[],
  target: string,
  width: number,
  height: number,
): Bubble[] {
  if (width < 8 || height < 3) return []
  const ordered = groupRoles(agents).flatMap((group) => group.agents)
  const nodes: Bubble[] = []
  // Stable orbital positions keep role peers adjacent; focus only takes priority when space is scarce.
  const priority = [...ordered].sort((a, b) => Number(b.id === target) - Number(a.id === target))
  for (const agent of priority) {
    const at = ordered.findIndex((item) => item.id === agent.id)
    const angle = -Math.PI / 2 + (2 * Math.PI * at) / Math.max(1, ordered.length)
    const wide = Math.min(
      width,
      Math.max(agent.status === 'working' ? 24 : 20, Math.min(32, widthOf(agent.id) + 6)),
    )
    const tall = agent.status === 'working' && height >= 5 && width >= 12 ? 5 : 3
    const aim = {
      x: width / 2 + Math.cos(angle) * width * 0.32 - wide / 2,
      y: height / 2 + Math.sin(angle) * height * 0.31 - tall / 2,
    }
    const candidates: Point[] = []
    for (let y = 0; y <= height - tall; y++)
      for (let x = 0; x <= width - wide; x += 2) candidates.push({ x, y })
    candidates.sort(
      (a, b) =>
        Math.hypot((a.x - aim.x) / 2, a.y - aim.y) - Math.hypot((b.x - aim.x) / 2, b.y - aim.y),
    )
    const spot = candidates.find((candidate) =>
      nodes.every(
        (node) =>
          candidate.x + wide + 2 <= node.x ||
          node.x + node.width + 2 <= candidate.x ||
          candidate.y + tall + 1 <= node.y ||
          node.y + node.height + 1 <= candidate.y,
      ),
    )
    if (spot) nodes.push({ ...agent, ...spot, width: wide, height: tall })
  }
  return nodes
}

function ports(node: Bubble): Point[] {
  return [
    { x: node.x - 1, y: node.y + Math.floor(node.height / 2) },
    { x: node.x + node.width, y: node.y + Math.floor(node.height / 2) },
    { x: node.x + Math.floor(node.width / 2), y: node.y - 1 },
    { x: node.x + Math.floor(node.width / 2), y: node.y + node.height },
  ]
}

/** Route through free terminal cells so a connection never overwrites an agent label. */
function route(
  from: Bubble,
  to: Bubble,
  nodes: Bubble[],
  width: number,
  height: number,
  reserved: Set<number>,
): Point[] {
  const blocked = (point: Point) =>
    point.x < 0 ||
    point.y < 0 ||
    point.x >= width ||
    point.y >= height ||
    reserved.has(point.y * width + point.x) ||
    nodes.some(
      (node) =>
        point.x >= node.x &&
        point.x < node.x + node.width &&
        point.y >= node.y &&
        point.y < node.y + node.height,
    )
  const key = (point: Point) => point.y * width + point.x
  const ends = new Set(
    ports(to)
      .filter((point) => !blocked(point))
      .map(key),
  )
  const queue = ports(from).filter((point) => !blocked(point))
  const before = new Map<number, Point | undefined>(queue.map((point) => [key(point), undefined]))
  for (let i = 0; i < queue.length; i++) {
    const point = queue[i]
    if (!point) continue
    if (ends.has(key(point))) {
      const path: Point[] = [point]
      let previous = before.get(key(point))
      while (previous) {
        path.push(previous)
        previous = before.get(key(previous))
      }
      return path.reverse()
    }
    for (const next of [
      { x: point.x + 1, y: point.y },
      { x: point.x - 1, y: point.y },
      { x: point.x, y: point.y + 1 },
      { x: point.x, y: point.y - 1 },
    ]) {
      if (blocked(next) || before.has(key(next))) continue
      before.set(key(next), point)
      queue.push(next)
    }
  }
  return []
}

export function bubbleConnections(
  nodes: Bubble[],
  edges: readonly TeamEdge[],
  width: number,
  height: number,
): { edge: TeamEdge; path: Point[] }[] {
  const reserved = new Set<number>()
  const starts = new Map<string, Point>()
  return edges.flatMap((edge) => {
    const from = nodes.find((node) => node.id === edge.from)
    const to = nodes.find((node) => node.id === edge.to)
    if (!from || !to) return []
    const reverseStart = starts.get(`${edge.to}\0${edge.from}`)
    const unavailable = new Set(reserved)
    if (reverseStart) unavailable.add(reverseStart.y * width + reverseStart.x)
    const path = route(from, to, nodes, width, height, unavailable)
    const start = path[0]
    if (start) starts.set(`${edge.from}\0${edge.to}`, start)
    const end = path.at(-1)
    if (end) reserved.add(end.y * width + end.x)
    return [{ edge, path }]
  })
}

export function bubbleRows(
  agents: readonly BubbleAgent[],
  edges: readonly TeamEdge[],
  target: string,
  width: number,
  height: number,
  nodes = bubbleLayout(agents, target, width, height),
): PaintedRow[] {
  const cells: Segment[][] = Array.from({ length: height }, () =>
    Array.from({ length: width }, () => ({ text: ' ' })),
  )
  const put = (x: number, y: number, text: string, color: string, bold = false) => {
    for (const { segment } of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(
      text,
    )) {
      const size = widthOf(segment)
      if (cells[y]?.[x] && x + size <= width) {
        cells[y][x] = { text: segment, color, bold }
        for (let offset = 1; offset < size; offset++) cells[y][x + offset] = { text: '' }
      }
      x += size
    }
  }
  const markers: { point: Point; text: string; color: string }[] = []
  const focused = edges.filter((edge) => edge.from === target || edge.to === target)
  const other =
    width < 100 ? [] : edges.filter((edge) => edge.from !== target && edge.to !== target)
  const paths = bubbleConnections(nodes, [...focused, ...other], width, height)
  paths.sort(
    (a, b) =>
      Number(a.edge.from === target || a.edge.to === target) -
      Number(b.edge.from === target || b.edge.to === target),
  )
  for (const { edge, path } of paths) {
    const from = nodes.find((node) => node.id === edge.from)
    const to = nodes.find((node) => node.id === edge.to)
    if (!from || !to) continue
    const active = edge.from === target || edge.to === target
    const color = edge.from === target ? '#5eead4' : edge.to === target ? '#c4b5fd' : '#52525b'
    for (let i = 0; i < path.length; i++) {
      const point = path[i]
      if (!point) continue
      const previous = path[i - 1]
      const next = path[i + 1]
      const horizontal = next ? next.y === point.y : previous?.y === point.y
      const up = previous?.y === point.y - 1 || next?.y === point.y - 1
      const down = previous?.y === point.y + 1 || next?.y === point.y + 1
      const right = previous?.x === point.x + 1 || next?.x === point.x + 1
      const left = previous?.x === point.x - 1 || next?.x === point.x - 1
      const corner =
        up && right ? '┗' : up && left ? '┛' : down && right ? '┏' : down && left ? '┓' : undefined
      put(
        point.x,
        point.y,
        corner ?? (active ? (horizontal ? '━' : '┃') : horizontal ? '┄' : '┊'),
        color,
      )
    }
    const end = path.at(-1)
    if (end)
      markers.push({
        point: end,
        text: end.x < to.x ? '▶' : end.x >= to.x + to.width ? '◀' : end.y < to.y ? '▼' : '▲',
        color,
      })
    const count = String(edge.count)
    const middle = path.find(
      (point, index) =>
        index > 1 &&
        index + count.length < path.length - 1 &&
        path
          .slice(index, index + count.length)
          .every((step, offset) => step.y === point.y && step.x === point.x + offset),
    )
    if (middle) markers.unshift({ point: middle, text: count, color })
  }
  for (const marker of markers) put(marker.point.x, marker.point.y, marker.text, marker.color, true)
  for (const node of nodes) {
    const color = agentAvatar(node.role ?? node.id).color
    const selected = node.id === target
    const middle = Math.floor(node.height / 2)
    for (let row = 0; row < node.height; row++) {
      const inset = Math.abs(row - middle) * 2
      const span = node.width - inset * 2
      const text =
        row === 0
          ? `╭${'─'.repeat(span - 2)}╮`
          : row === node.height - 1
            ? `╰${'─'.repeat(span - 2)}╯`
            : `(${' '.repeat(span - 2)})`
      put(node.x + inset, node.y + row, text, color, selected)
    }
    const label = cutAt(
      `${selected ? '◉' : node.status === 'working' ? '●' : '○'} ${terminalLabel(node.id)}`,
      node.width - 4,
    )[0]
    put(
      node.x + Math.floor((node.width - widthOf(label)) / 2),
      node.y + middle,
      label,
      color,
      selected,
    )
  }
  return cells.map((segments) => ({ segments }))
}
