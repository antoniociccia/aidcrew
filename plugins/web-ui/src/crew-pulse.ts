type Agent = { id: string; status: string; queued: number; behind: number }
type Attention = { id: string; reason: 'decision' | 'stopped' | 'queued' | 'behind' }

function attentionReason(agent: Agent, pendingAgent?: string): Attention['reason'] | undefined {
  if (agent.id === pendingAgent) return 'decision'
  if (agent.status === 'stopped') return 'stopped'
  if (agent.queued > 0 && agent.status !== 'working') return 'queued'
  if (agent.behind > 0) return 'behind'
  return undefined
}

export function crewPulse(agents: readonly Agent[], pendingAgent?: string) {
  const attention: Attention[] = []
  for (const agent of agents) {
    const reason = attentionReason(agent, pendingAgent)
    if (reason) attention.push({ id: agent.id, reason })
  }
  const priority = { decision: 0, stopped: 1, queued: 2, behind: 3 }
  attention.sort((a, b) => priority[a.reason] - priority[b.reason])
  return {
    working: agents.filter((agent) => agent.status === 'working').length,
    queued: agents.reduce((sum, agent) => sum + agent.queued, 0),
    attention,
  }
}
