import type { Task } from '@aidcrew/core'

type TaskAgent = {
  readonly id: string
  readonly task: string
  readonly status: string
  readonly model: string
  readonly provider?: string
  readonly cost?: number
  readonly estimated: boolean
}

/** A checkout's activity is not a completion verdict: idle work may still need review. */
export function taskCards(tasks: readonly Task[], agents: readonly TaskAgent[]) {
  return tasks.map((task) => {
    const assigned = agents.filter((agent) => agent.task === task.name)
    const priced = assigned.filter((agent) => agent.cost !== undefined)
    const activity = assigned.some((agent) => agent.status === 'working')
      ? 'working'
      : assigned.length
        ? 'idle'
        : 'unassigned'
    return {
      ...task,
      activity,
      agents: assigned,
      knownCost: priced.length
        ? priced.reduce((total, agent) => total + (agent.cost ?? 0), 0)
        : undefined,
      partialCost: priced.length < assigned.length,
      estimatedCost: priced.some((agent) => agent.estimated),
    }
  })
}
