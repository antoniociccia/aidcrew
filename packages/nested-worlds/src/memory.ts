// What an agent remembers is a projection of the event log, never a store of
// its own: the log is the truth, and turning memory off is just an empty view.
import type { AgentId, MemoryView, Pos, WorldEvent } from './contracts.ts'

export const EPISODES = 20
export const BOARD = 20

const at = (p: unknown) => {
  const pos = p as Pos
  return `(${pos.x},${pos.y})`
}

function episode(e: WorldEvent, me: AgentId): string | null {
  const p = e.payload
  if (e.type === 'said') {
    if (e.agentId === me) return `you said "${p.text}"`
    return (p.heardBy as AgentId[]).includes(me) ? `${e.agentId} said "${p.text}"` : null
  }
  if (e.agentId !== me) return null
  switch (e.type) {
    case 'moved':
      return `you moved to ${at(p.to)}`
    case 'action_rejected':
      return `your ${(p.action as { type: string }).type} failed: ${p.reason}`
    case 'picked':
      return `you picked up ${p.itemId}`
    case 'dropped':
      return `you dropped ${p.itemId} at ${at(p.pos)}`
    case 'item_vanished':
      return `${p.itemId} faded away where you dropped it at ${at(p.pos)}`
    case 'ate':
      return `you ate ${p.itemId} (energy ${p.before} -> ${p.after})`
    case 'inspected':
      return `you inspected ${p.itemId}: ${p.message}`
    case 'energy_changed':
      return `your energy went ${p.before} -> ${p.after}`
    case 'hypothesis':
      return `you supposed ${p.id}: ${p.statement}`
    case 'prediction':
      return `you predicted ${p.id} for tick ${(p.claim as { atTick: number }).atTick}`
    case 'prediction_resolved':
      return `your prediction ${p.predictionId} ${p.correct ? 'came true' : 'was wrong'}`
    case 'interface_response':
      return `the slab answered: "${p.message}"`
    default:
      return null
  }
}

export function memoryView(
  events: readonly WorldEvent[],
  agentId: AgentId,
  opts: { enabled: boolean },
): MemoryView {
  if (!opts.enabled) return { episodes: [], notes: [], board: [], strategy: '' }
  const episodes: string[] = []
  const notes: string[] = []
  const board: MemoryView['board'] = []
  let strategy = ''
  for (const e of events) {
    if (e.type === 'note') {
      const text = String(e.payload.text)
      const basedOn = (e.payload.basedOn as string[] | undefined) ?? []
      if (e.agentId === agentId) notes.push(text)
      if (e.payload.shared === true && e.agentId) {
        const provenance = basedOn.length > 0 ? ` (based on: ${basedOn.join(', ')})` : ''
        board.push({ by: e.agentId, tick: e.tick, text: text + provenance })
      }
      continue
    }
    if (e.type === 'strategy_revised' && e.agentId === agentId) {
      strategy = String(e.payload.text)
      continue
    }
    const line = episode(e, agentId)
    if (line) episodes.push(`t${e.tick}: ${line}`)
  }
  return { episodes: episodes.slice(-EPISODES), notes, board: board.slice(-BOARD), strategy }
}
