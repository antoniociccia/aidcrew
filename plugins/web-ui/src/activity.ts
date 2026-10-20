type Line = { agentId: string; kind: string; text: string }
export type ActivityFilter = 'all' | 'messages' | 'tools' | 'handoffs' | 'errors'
export type ActivityEntry = Line & {
  id: string
  index: number
  category: Exclude<ActivityFilter, 'all'> | 'notes' | 'changes'
  from?: string
  to?: string
}

type Options = { agent?: string; query?: string; filter?: ActivityFilter; limit?: number }
const categories: Record<string, ActivityEntry['category']> = {
  ask: 'messages',
  say: 'messages',
  tool: 'tools',
  error: 'errors',
  note: 'notes',
  diff: 'changes',
}
function mirrorText(next: Line | undefined, from: string, to: string, text: string) {
  const prefix = `← ${from}: `
  if (next?.kind !== 'note' || next.agentId !== to || !next.text.startsWith(prefix))
    return undefined
  const full = next.text.slice(prefix.length)
  const first = full.split('\n').find((part) => part.trim()) ?? ''
  const preview = first.length > 90 ? `${first.slice(0, 90)}…` : first
  return full === text || preview === text ? full : undefined
}

function handoff(line: Line, next?: Line) {
  const outgoing = /^→ ([^:]+): ?([\s\S]*)$/.exec(line.text)
  const incoming = /^← ([^:]+): ?([\s\S]*)$/.exec(line.text)
  if (outgoing) {
    const to = outgoing[1] ?? '',
      text = outgoing[2] ?? ''
    const full = mirrorText(next, line.agentId, to, text)
    if (full !== undefined) return { from: line.agentId, to, text: full, paired: true }
    return { from: line.agentId, to, text, paired: false }
  }
  return incoming
    ? { from: incoming[1] ?? '', to: line.agentId, text: incoming[2] ?? '', paired: false }
    : undefined
}

/** Journal indices are ordinal context, never synthesized timestamps or progress. */
function journalEntries(lines: readonly Line[]) {
  const entries: ActivityEntry[] = []
  const occurrences = new Map<string, number>()
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    if (!line || !['ask', 'say', 'tool', 'error', 'note', 'diff'].includes(line.kind)) continue
    const message = line.kind === 'note' ? handoff(line, lines[index + 1]) : undefined
    const category = message ? 'handoffs' : (categories[line.kind] ?? 'notes')
    const text = message?.text ?? line.text
    const identity = JSON.stringify([line.agentId, line.kind, message?.from, message?.to, text])
    const occurrence = occurrences.get(identity) ?? 0
    occurrences.set(identity, occurrence + 1)
    entries.push({
      ...line,
      text,
      index,
      category,
      id: `${identity}:${occurrence}`,
      ...(message ? { from: message.from, to: message.to } : {}),
    })
    if (message?.paired) index++
  }
  return entries
}

function matches(entry: ActivityEntry, options: Options, query: string) {
  if (options.agent && ![entry.agentId, entry.from, entry.to].includes(options.agent)) return false
  if (options.filter && options.filter !== 'all' && entry.category !== options.filter) return false
  return (
    !query ||
    `${entry.agentId} ${entry.from ?? ''} ${entry.to ?? ''} ${entry.text}`
      .toLocaleLowerCase()
      .includes(query)
  )
}

export function activityLog(lines: readonly Line[], options: Options = {}) {
  const query = options.query?.trim().toLocaleLowerCase() ?? ''
  const matching = journalEntries(lines).filter((entry) => matches(entry, options, query))
  const limit = Math.max(0, Math.min(400, Math.floor(options.limit ?? 400)))
  const shown = limit ? matching.slice(-limit) : []
  return { entries: shown, total: matching.length, omitted: matching.length - shown.length }
}
