import type { AgentSnapshot } from '@aidcrew/core'
import { z } from 'zod'

const id = z.string().min(1).max(240)
export const actionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('send'), agent: id, text: z.string().min(1).max(100_000) }),
  z.object({ type: z.literal('command'), agent: id, text: z.string().min(1).max(10_000) }),
  z.object({
    type: z.enum(['cancel', 'clearQueue', 'forget', 'kill', 'diff', 'merge']),
    agent: id,
  }),
  z.object({ type: z.literal('model'), agent: id, model: id, provider: id.optional() }),
  z.object({ type: z.literal('yolo'), agent: id, on: z.boolean() }),
  z.object({ type: z.literal('memory'), on: z.boolean() }),
  z.object({ type: z.literal('spawn'), role: id, model: id.optional(), provider: id.optional() }),
  z.object({ type: z.literal('task'), name: id, roles: z.array(id).min(1).max(30) }),
  z.object({ type: z.literal('answer'), request: id, key: id }),
  z.object({ type: z.literal('inspect') }),
  z.object({ type: z.literal('open'), cwd: id }),
  z.object({ type: z.literal('models'), provider: id }),
  z.object({ type: z.literal('theme'), name: id }),
  z.object({ type: z.literal('credentials'), scope: id, key: z.string().min(1).max(8000) }),
  z.object({ type: z.literal('forgetCredential'), scope: id }),
  z.object({ type: z.literal('default'), setting: z.enum(['provider', 'model']), value: id }),
  z.object({
    type: z.literal('appearance'),
    fill: z.enum(['hairline', 'solid']).optional(),
    hidePaths: z.boolean().optional(),
  }),
  z.object({
    type: z.literal('sources'),
    kind: z.enum(['instructions', 'skills', 'agents', 'orchestration']),
    paths: z.array(id).max(100),
  }),
  z.object({
    type: z.literal('agentDefinition'),
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100),
    description: z.string().max(1000),
    systemPrompt: z.string().min(1).max(50_000),
    tools: z.array(id).optional(),
    provider: id.optional(),
    model: id.optional(),
  }),
  z.object({
    type: z.literal('removeDefinition'),
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100),
  }),
])
export type WebAction = z.infer<typeof actionSchema>
export type WebState = {
  sessionId: string
  cwd: string
  ready: boolean
  agents: (AgentSnapshot & { cost?: number; estimated: boolean })[]
  lines: { agentId: string; kind: string; text: string }[]
  target: string
  total?: number
  sharedMemory: boolean
  memory?: Record<string, unknown>
  outstanding: number
  plugins: { name: string; version?: string; tools: string[] }[]
  themes: string[]
  pending?: {
    id: string
    agentId: string
    because: string
    summary: string
    answers: { key: string; label: string; tone: string }[]
  }
}
/** A surface observes and commands the existing session; it never owns another team. */
export type SessionBridge = {
  snapshot(): WebState
  dispatch(action: WebAction): Promise<unknown>
}
