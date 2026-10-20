// What the viewer draws, one frame per tick. A frame is the world as the
// engine leaves it after that tick: the run is rebuilt from its seed and
// stepped with the actions it recorded, so the picture is the engine's, never
// a guess pieced together from event text.
import type {
  Action,
  AgentId,
  ItemId,
  ItemKind,
  Pos,
  RunStore,
  UpperState,
  WorldEvent,
  WorldParams,
} from '../contracts.ts'
import { hostFor } from '../runner.ts'
import type { Host } from '../upper/host.ts'
import { lightAt } from '../world/step.ts'

export interface Frame {
  tick: number
  /** 1 by day, lower at night, from the day length this tick ran with. */
  light: number
  params: WorldParams
  items: { id: ItemId; kind: ItemKind; pos: Pos }[]
  agents: {
    id: AgentId
    name: string
    pos: Pos
    energy: number
    alive: boolean
    inventory: { id: ItemId; kind: ItemKind }[]
  }[]
  /** Everything recorded at this tick, in every world. */
  events: WorldEvent[]
  upper: Pick<UpperState, 'unlocked' | 'registers' | 'log'>
}

function step(host: Host, tick: number, events: WorldEvent[]): Frame {
  const actions = new Map<AgentId, Action>()
  for (const e of events) {
    if (e.type === 'action' && e.path === '' && e.agentId !== null) {
      actions.set(e.agentId, e.payload.action as Action)
    }
  }
  const params = host.params()
  host.step(actions)
  const world = host.base
  const kindOf = new Map(world.items.map((i) => [i.id, i.kind]))
  return {
    tick,
    light: lightAt(tick, params.dayLength),
    params,
    items: world.items.flatMap((i) =>
      i.pos ? [{ id: i.id, kind: i.kind, pos: { ...i.pos } }] : [],
    ),
    agents: world.agents.map((a) => ({
      id: a.id,
      name: a.name,
      pos: { ...a.pos },
      energy: a.energy,
      alive: a.alive,
      inventory: a.inventory.map((id) => ({ id, kind: kindOf.get(id) ?? 'stone' })),
    })),
    events,
    upper: structuredClone({
      unlocked: host.upper.unlocked,
      registers: host.upper.registers,
      log: host.upper.log,
    }),
  }
}

export interface FrameCursor {
  /** Frames for the ticks written since the last call, oldest first. */
  advance(): Frame[]
}

/**
 * Steps the rebuilt world forward as far as the store goes. A tick is there
 * once its actions are: the runner writes a tick's events in one transaction.
 */
export function createFrameCursor(store: RunStore, runId: string): FrameCursor {
  const run = store.run(runId)
  if (!run) throw new Error(`no run ${runId}`)
  const host = hostFor(run.config)
  let tick = 0
  return {
    advance() {
      const out: Frame[] = []
      for (;;) {
        const events = store.events(runId, { fromTick: tick, toTick: tick })
        if (!events.some((e) => e.type === 'action')) return out
        out.push(step(host, tick, events))
        tick += 1
      }
    },
  }
}

export function framesOf(
  store: RunStore,
  runId: string,
  range: { from?: number; to?: number } = {},
): Frame[] {
  const from = range.from ?? 0
  const to = range.to ?? Number.POSITIVE_INFINITY
  return createFrameCursor(store, runId)
    .advance()
    .filter((f) => f.tick >= from && f.tick <= to)
}
