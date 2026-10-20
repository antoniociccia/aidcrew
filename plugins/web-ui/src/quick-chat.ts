export function defaultChatAgent(
  agents: readonly { id: string }[],
  saved: unknown,
  target?: string,
): string {
  if (typeof saved === 'string' && agents.some((agent) => agent.id === saved)) return saved
  return (
    agents.find((agent) => agent.id === 'architect')?.id ??
    agents.find((agent) => agent.id === target)?.id ??
    agents[0]?.id ??
    ''
  )
}

export function chatMessages(
  lines: readonly { agentId: string; kind: string; text: string }[],
  agentId: string,
) {
  return lines
    .map((line, index) => ({ ...line, index }))
    .filter((line) => line.agentId === agentId && (line.kind === 'ask' || line.kind === 'say'))
    .slice(-100)
}
