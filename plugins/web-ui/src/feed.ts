type Line = { agentId: string; kind: string; text: string }
type Options = {
  agent?: string
  query?: string
  filter?: 'all' | 'conversation' | 'tools' | 'changes' | 'errors' | 'notes'
  reasoning?: boolean
  limit?: number
}

/** Group before filtering so matching edits retain their filename and context. */
export function selectFeed(lines: readonly Line[], options: Options) {
  const groups: Line[][] = []
  let previous: Line | undefined
  for (const line of lines) {
    if (line.kind === 'diff' && previous?.kind === 'diff' && previous.agentId === line.agentId)
      groups.at(-1)?.push(line)
    else groups.push([line])
    previous = line
  }
  const query = options.query?.trim().toLowerCase() ?? ''
  const kinds = {
    all: undefined,
    conversation: ['ask', 'say'],
    tools: ['tool'],
    changes: ['diff'],
    errors: ['error'],
    notes: ['note'],
  }[options.filter ?? 'all']
  const matching = groups.filter((group) => {
    const first = group[0]
    return (
      first &&
      (options.agent === undefined || first.agentId === options.agent) &&
      (options.reasoning || first.kind !== 'thinking') &&
      (!kinds || kinds.includes(first.kind)) &&
      (!query ||
        first.agentId.toLowerCase().includes(query) ||
        group.some((line) => line.text.toLowerCase().includes(query)))
    )
  })
  const limit = Math.max(0, options.limit ?? 400)
  return { groups: limit ? matching.slice(-limit) : [], total: matching.length }
}
