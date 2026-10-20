import type { AgentId, Observation, WorldState } from '../contracts.ts'
import { terrainAt } from './generate.ts'
import { chebyshev, lightAt } from './step.ts'

export const DAY_RADIUS = 3
export const NIGHT_RADIUS = 1

/** What one agent can see: no props, no rules, nothing of another agent but where it stands. */
export function observe(
  state: WorldState,
  agentId: AgentId,
  heard: Observation['heard'],
  lastResult: Observation['lastResult'],
): Observation {
  const me = state.agents.find((a) => a.id === agentId)
  if (!me) throw new Error(`no agent ${agentId} in world "${state.path}"`)
  const light = lightAt(state.tick, state.params.dayLength)
  const radius = light < 0.5 ? NIGHT_RADIUS : DAY_RADIUS
  const tiles: Observation['tiles'] = []
  for (
    let y = Math.max(0, me.pos.y - radius);
    y <= Math.min(state.height - 1, me.pos.y + radius);
    y++
  ) {
    for (
      let x = Math.max(0, me.pos.x - radius);
      x <= Math.min(state.width - 1, me.pos.x + radius);
      x++
    ) {
      tiles.push({ pos: { x, y }, terrain: terrainAt(state, { x, y }) })
    }
  }
  const kindOf = new Map(state.items.map((i) => [i.id, i.kind]))
  return {
    tick: state.tick,
    light,
    self: {
      id: me.id,
      name: me.name,
      pos: { ...me.pos },
      energy: me.energy,
      inventory: me.inventory.flatMap((id) => {
        const kind = kindOf.get(id)
        return kind ? [{ id, kind }] : []
      }),
    },
    tiles,
    items: state.items.flatMap((i) =>
      i.pos && chebyshev(i.pos, me.pos) <= radius
        ? [{ id: i.id, kind: i.kind, pos: { ...i.pos } }]
        : [],
    ),
    agents: state.agents.flatMap((a) =>
      a.alive && a.id !== me.id && chebyshev(a.pos, me.pos) <= radius
        ? [{ id: a.id, name: a.name, pos: { ...a.pos } }]
        : [],
    ),
    heard: heard.map((h) => ({ ...h })),
    lastResult: lastResult ? { ...lastResult } : null,
  }
}
