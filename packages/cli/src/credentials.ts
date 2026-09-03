import type { AgentDef } from '@aidcrew/core'
import type { SettingsStore } from './store.ts'

/**
 * Where an API key comes from.
 *
 * Keys are saved once from the interface and kept in the settings database.
 * Environment variables still work and win, for CI and one-off runs.
 *
 * The order is specific before general:
 *
 *   1. this agent's own key      env named by apiKeyEnv, then saved agent:<id>
 *   2. this provider's key       AIDCREW_API_KEY_<PROVIDER>, then saved provider:<id>
 *   3. the shared fallback       AIDCREW_API_KEY
 */

const PREFIX = 'AIDCREW_API_KEY'

export type Resolved = {
  apiKey: string
  baseUrl?: string
  /** Where it came from, for a settings screen and for error messages. */
  source: string
}

export type CredentialSources = {
  env: Record<string, string | undefined>
  store?: SettingsStore
}

export function scopeFor(kind: 'provider' | 'agent', id: string): string {
  return `${kind}:${id}`
}

/** The environment-variable spelling of a provider id. */
export function slug(providerId: string): string {
  return providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')
}

const found = (apiKey: string, source: string, baseUrl?: string): Resolved =>
  baseUrl === undefined ? { apiKey, source } : { apiKey, source, baseUrl }

function baseUrlFor(
  env: Record<string, string | undefined>,
  providerId: string,
  store?: SettingsStore,
): string | undefined {
  return (
    env[`AIDCREW_BASE_URL_${slug(providerId)}`] ??
    env.AIDCREW_BASE_URL ??
    store?.getCredential(scopeFor('provider', providerId))?.baseUrl
  )
}

export function keyForProvider(
  providerId: string,
  { env, store }: CredentialSources,
): Resolved | undefined {
  const baseUrl = baseUrlFor(env, providerId, store)
  const named = `${PREFIX}_${slug(providerId)}`

  const exported = env[named]
  if (exported) return found(exported, named, baseUrl)

  const saved = store?.getCredential(scopeFor('provider', providerId))
  if (saved) return found(saved.apiKey, `saved for ${providerId}`, baseUrl)

  const shared = env[PREFIX]
  if (shared) return found(shared, PREFIX, baseUrl)

  return undefined
}

export function keyForAgent(
  agent: AgentDef,
  providerId: string,
  sources: CredentialSources,
): Resolved | undefined {
  const { env, store } = sources
  const baseUrl = baseUrlFor(env, providerId, store)

  if (agent.apiKeyEnv) {
    const exported = env[agent.apiKeyEnv]
    if (exported) return found(exported, agent.apiKeyEnv, baseUrl)
  }

  const own = store?.getCredential(scopeFor('agent', agent.id))
  if (own) return found(own.apiKey, `saved for ${agent.id}`, own.baseUrl ?? baseUrl)

  return keyForProvider(providerId, sources)
}

export type TeamCredentials = {
  for(agentId: string): Resolved | undefined
  /**
   * Resolves a key for an agent that was not on the team when this ran.
   *
   * A team is not fixed: somebody adds a member from the team screen, or a
   * task starts a second of a role. Without this the new agent has no key,
   * spawning throws, and — because the screen only ever said "void" to that
   * promise — nothing appears and nothing explains why.
   *
   * False when there is no key to be had, so the caller can say which agent
   * and which service rather than starting something that cannot talk.
   */
  admit(agent: AgentDef): boolean
  /** Agents with no key, so the caller can name them all at once. */
  missing: { agentId: string; providerId: string }[]
}

/**
 * Resolves every agent's key up front, so a team fails before the first agent
 * starts rather than three agents in with two worktrees already open.
 */
export function resolveTeamCredentials(
  team: AgentDef[],
  defaultProvider: string,
  sources: CredentialSources,
  /**
   * Whether a provider needs a key at all. One serving a model on this
   * machine does not, nor does the demo's, and demanding one would mean
   * inventing a key to get past the check.
   */
  needsKey: (providerId: string) => boolean = () => true,
): TeamCredentials {
  const byAgent = new Map<string, Resolved>()
  const missing: { agentId: string; providerId: string }[] = []

  for (const agent of team) {
    const providerId = agent.provider ?? defaultProvider
    const resolved = keyForAgent(agent, providerId, sources)

    if (resolved) byAgent.set(agent.id, resolved)
    else if (needsKey(providerId)) missing.push({ agentId: agent.id, providerId })
    // Nothing to record for a provider that needs nothing: the agent runs, and
    // whatever it is talking to sorts out its own authorisation.
    else byAgent.set(agent.id, { apiKey: '', source: `${providerId}:no key needed` })
  }

  return {
    // A second of a role is spawned long after this ran, so it is not in the
    // team the keys were resolved for. It uses the same service on the same
    // plan as the one it copies, so it uses the same key — the alternative is
    // an agent that starts and then cannot say anything.
    for: (agentId) => byAgent.get(agentId) ?? byAgent.get(roleBehind(agentId)),

    admit: (agent) => {
      const providerId = agent.provider ?? defaultProvider
      const resolved = keyForAgent(agent, providerId, sources)
      if (resolved) {
        byAgent.set(agent.id, resolved)
        return true
      }
      if (needsKey(providerId)) return false

      byAgent.set(agent.id, { apiKey: '', source: `${providerId}:no key needed` })
      return true
    },

    missing,
  }
}

/**
 * The agent an id was made from: `coder` for `coder-2`, and for `feat/coder`.
 *
 * Both are spawned long after the keys were resolved — a second of a busy
 * role, an agent started on a task of its own — and both run on the same
 * service, on the same plan, as the one they copy. `/task feat coder` used to
 * produce an agent that appeared, took an instruction, and failed every turn
 * with "needs a key", because nothing stripped the task from its name.
 */
function roleBehind(agentId: string): string {
  return agentId.replace(/^.*\//, '').replace(/-\d+$/, '')
}
