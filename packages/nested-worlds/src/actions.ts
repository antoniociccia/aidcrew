// Everything a decider returns is untrusted until it passes here: a model may
// answer with anything, and the world only ever steps on what this accepts.
import { z } from 'zod'
import type { Action, ActionType, EventType } from './contracts.ts'

const Id = z.string().min(1).max(64)
const Tick = z.number().int().min(0)
const PosSchema = z.object({ x: z.number().int(), y: z.number().int() })

const EVENT_TYPES = [
  'decision',
  'action',
  'action_rejected',
  'moved',
  'picked',
  'dropped',
  'ate',
  'inspected',
  'said',
  'item_spawned',
  'item_vanished',
  'item_reappeared',
  'resonance',
  'energy_changed',
  'agent_died',
  'note',
  'hypothesis',
  'prediction',
  'prediction_resolved',
  'strategy_revised',
  'interface_request',
  'interface_response',
  'upper_unlocked',
  'upper_write',
  'world_param_changed',
  'sim_created',
  'sim_stepped',
  'checkpoint',
  'budget_exhausted',
  'run_status',
] as const satisfies readonly EventType[]

const ClaimSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('item_at'),
    itemKind: z.enum(['food', 'stone', 'crystal', 'tablet', 'slab']),
    pos: PosSchema,
    atTick: Tick,
    present: z.boolean(),
  }),
  z.object({
    kind: z.literal('event_at'),
    eventType: z.enum(EVENT_TYPES),
    atTick: Tick,
    occurs: z.boolean(),
  }),
  z.object({
    kind: z.literal('energy_at'),
    agentId: Id,
    atTick: Tick,
    min: z.number(),
    max: z.number(),
  }),
])

const InterfaceSchema = z.discriminatedUnion('op', [
  z.object({
    type: z.literal('interface'),
    itemId: Id,
    op: z.literal('press'),
    values: z.array(z.number().int().min(0).max(1000)).max(8),
  }),
  z.object({ type: z.literal('interface'), itemId: Id, op: z.literal('read') }),
  z.object({
    type: z.literal('interface'),
    itemId: Id,
    op: z.literal('turn'),
    dial: z.enum(['harvest', 'day']),
    value: z.number().int().min(2).max(30),
  }),
])

export const ActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('wait') }),
  z.object({ type: z.literal('move'), dir: z.enum(['N', 'S', 'E', 'W']) }),
  z.object({ type: z.literal('pick'), itemId: Id }),
  z.object({ type: z.literal('drop'), itemId: Id }),
  z.object({ type: z.literal('use'), itemId: Id }),
  z.object({ type: z.literal('inspect'), itemId: Id }),
  z.object({ type: z.literal('say'), text: z.string().max(280) }),
  z.object({
    type: z.literal('note'),
    text: z.string().max(500),
    shared: z.boolean(),
    basedOn: z.array(Id).max(16).exactOptional(),
  }),
  z.object({ type: z.literal('hypothesize'), id: Id, statement: z.string().max(300) }),
  z.object({
    type: z.literal('predict'),
    id: Id,
    hypothesisId: Id.exactOptional(),
    claim: ClaimSchema,
  }),
  z.object({
    type: z.literal('revise_strategy'),
    text: z.string().max(1200),
    reason: z.string().max(300),
  }),
  InterfaceSchema,
]) satisfies z.ZodType<Action, unknown>

export const ALL_ACTIONS: ActionType[] = [
  'wait',
  'move',
  'pick',
  'drop',
  'use',
  'inspect',
  'say',
  'note',
  'hypothesize',
  'predict',
  'revise_strategy',
  'interface',
]

export type ParseResult = { ok: true; action: Action } | { ok: false; error: string }

export function parseAction(raw: unknown, allowed: readonly ActionType[]): ParseResult {
  const parsed = ActionSchema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: z.prettifyError(parsed.error) }
  const action: Action = parsed.data
  if (!allowed.includes(action.type)) {
    return { ok: false, error: `action "${action.type}" is not allowed now` }
  }
  return { ok: true, action }
}
