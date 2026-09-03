import type { AgentDef, LoadedSources, Loader, Skill } from '@aidcrew/core'
import type { SourcePaths } from './workspace.ts'

export type SourceLoadResult = LoadedSources & {
  /** Paths a loader choked on; reported, never fatal. */
  failures: { path: string; reason: string }[]
  /**
   * Where each agent was found. A project's own agents and the ones sitting in
   * a home directory are not the same thing: only the first belong to a team
   * by default.
   */
  agentSources: Map<string, string>
}

/**
 * Reads every configured path with every registered loader.
 *
 * Loaders are tried in order and their results are concatenated: two formats
 * can describe the same kind of source, and a path one loader does not
 * understand is simply skipped by it.
 *
 * Later definitions win on a name collision, so a project's `reviewer` shadows
 * the user's — the same way the closer config file does.
 */
export async function collectSources(
  loaders: Loader[],
  paths: SourcePaths,
): Promise<SourceLoadResult> {
  const result: SourceLoadResult = {
    instructions: [],
    skills: [],
    agents: [],
    failures: [],
    agentSources: new Map(),
  }

  for (const loader of loaders) {
    for (const path of paths.instructions) {
      const loaded = await attempt(() => loader.loadInstructions?.(path), path, result)
      result.instructions.push(...(loaded ?? []))
    }

    for (const path of paths.skills) {
      const loaded = await attempt(() => loader.loadSkills?.(path), path, result)
      result.skills = mergeByKey(result.skills, loaded ?? [], (skill) => skill.name)
    }

    for (const path of paths.agents) {
      const loaded = await attempt(() => loader.loadAgents?.(path), path, result)
      for (const agent of loaded ?? []) result.agentSources.set(agent.id, path)
      result.agents = mergeByKey(result.agents, loaded ?? [], (agent) => agent.id)
    }
  }

  return result
}

async function attempt<T>(
  read: () => Promise<T> | undefined,
  path: string,
  result: SourceLoadResult,
): Promise<T | undefined> {
  try {
    return await read()
  } catch (cause) {
    result.failures.push({
      path,
      reason: cause instanceof Error ? cause.message : String(cause),
    })
    return undefined
  }
}

/** Concatenates, with later entries replacing earlier ones of the same name. */
function mergeByKey<T extends Skill | AgentDef>(
  existing: T[],
  incoming: T[],
  key: (item: T) => string,
): T[] {
  const byKey = new Map(existing.map((item) => [key(item), item]))
  for (const item of incoming) byKey.set(key(item), item)
  return [...byKey.values()]
}
