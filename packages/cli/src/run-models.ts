import { homedir } from 'node:os'
import { setAgentModel } from './agent-config.ts'
import type { Host } from './host.ts'
import { collectSources } from './sources.ts'
import type { SettingsStore } from './store.ts'
import { loadWorkspaceConfig } from './workspace.ts'

/**
 * Listing what a provider actually offers, and setting one as the default.
 *
 * A model id is exactly the kind of string nobody remembers and everybody
 * mistypes, and the failure it causes — "Model x is not supported" — arrives
 * after a request, with no clue as to what would have worked instead.
 */

export type ModelsIo = {
  write(text: string): void
  writeError(text: string): void
}

export class ModelsError extends Error {
  override readonly name = 'ModelsError'
}

export async function runModels(
  rest: string[],
  host: Host,
  store: SettingsStore,
  env: Record<string, string | undefined>,
  io: ModelsIo,
  cwd: string = process.cwd(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const [action, argument] = rest

  const providerId = env.AIDCREW_PROVIDER ?? store.get('default.provider') ?? 'zen'
  const definition = host.registry.provider(providerId)

  if (!definition) {
    throw new ModelsError(
      `unknown provider "${providerId}". Available: ${host.registry
        .providers()
        .map((provider) => provider.id)
        .join(', ')}`,
    )
  }

  if (action === 'use') {
    if (!argument) throw new ModelsError('usage: aidcrew models use <model-id> [--all]')

    store.set('default.model', argument)
    io.write(`${providerId} · default model is now ${argument}\n`)

    // --all also rewrites every agent that names a model of its own, which is
    // otherwise a file edit per agent.
    if (rest.includes('--all')) {
      const changed = await applyToEveryAgent(cwd, host, providerId, argument)
      io.write(
        changed.length === 0
          ? 'no agents named a model of their own\n'
          : `also set for: ${changed.join(', ')}\n`,
      )
    }
    return 0
  }

  if (action === 'check') {
    return await checkModels(providerId, definition, env, store, io, fetchImpl)
  }

  if (action !== undefined) {
    throw new ModelsError(
      `unknown action "${action}". Use "aidcrew models", "models use <id>" or "models check".`,
    )
  }

  const endpoint = env.AIDCREW_BASE_URL ?? definition.endpoint
  if (!endpoint) {
    throw new ModelsError(`${providerId} declares no endpoint; set AIDCREW_BASE_URL to list it`)
  }

  const key = env[`AIDCREW_API_KEY_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`]
  const apiKey = key ?? store.getCredential(`provider:${providerId}`)?.apiKey ?? env.AIDCREW_API_KEY
  if (!apiKey) {
    throw new ModelsError(`no key for "${providerId}" — add one first`)
  }

  const models = await listFrom(endpoint, apiKey, fetchImpl)
  const current = env.AIDCREW_MODEL ?? store.get('default.model')

  io.write(`${providerId} · ${models.length} models\n\n`)
  for (const model of models) {
    const mark = model === current ? '▸' : ' '
    const free = model.endsWith('-free') ? '  free' : ''
    io.write(`${mark} ${model}${free}\n`)
  }

  if (current && !models.includes(current)) {
    // The likeliest reason a working setup stopped working: the provider was
    // changed and the model came along for the ride.
    io.write(`\ncurrent model "${current}" is not on this list\n`)
  }
  io.write('\naidcrew models use <model-id>\n')

  return 0
}

async function listFrom(
  endpoint: string,
  apiKey: string,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  })

  if (!response.ok) {
    throw new ModelsError(`the provider answered ${response.status} when asked for its models`)
  }

  const body = (await response.json()) as { data?: { id?: unknown }[] }
  return (body.data ?? [])
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === 'string')
    .sort()
}

/**
 * Points every agent this project has at one model.
 *
 * Every agent, not only the ones already in the config: "all" that skipped
 * the agents nobody had configured yet would leave exactly the ones a person
 * is most likely to have forgotten about.
 */
async function applyToEveryAgent(
  cwd: string,
  host: Host,
  providerId: string,
  model: string,
): Promise<string[]> {
  const config = await loadWorkspaceConfig({ cwd, home: homedir() })
  const sources = await collectSources(host.registry.loaders(), config.sources)

  const mine = sources.agents
    .filter((agent) => sources.agentSources.get(agent.id)?.startsWith(cwd))
    .map((agent) => agent.id)
  const ids = [...new Set([...Object.keys(config.agents), ...mine])]

  for (const id of ids) {
    await setAgentModel(cwd, id, { provider: providerId, model })
  }
  return ids.sort()
}

/**
 * Finds out which models actually answer.
 *
 * A provider's model list is a catalogue, not an entitlement: OpenCode Zen
 * lists `muse-spark-1.2-contributor` to everyone and serves it in limited
 * regions only, so it appears, is chosen, and then fails on the first real
 * request with "not supported". The only way to know is to ask.
 *
 * Each check is one token of output, and they run a few at a time so the
 * whole catalogue does not arrive at once.
 */
async function checkModels(
  providerId: string,
  definition: { endpoint?: string },
  env: Record<string, string | undefined>,
  store: SettingsStore,
  io: ModelsIo,
  fetchImpl: typeof fetch,
): Promise<number> {
  const endpoint = env.AIDCREW_BASE_URL ?? definition.endpoint
  const apiKey =
    env[`AIDCREW_API_KEY_${providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')}`] ??
    store.getCredential(`provider:${providerId}`)?.apiKey ??
    env.AIDCREW_API_KEY

  if (!endpoint || !apiKey) {
    throw new ModelsError(`${providerId} needs an endpoint and a key before it can be checked`)
  }

  const models = await listFrom(endpoint, apiKey, fetchImpl)
  io.write(`checking ${models.length} models on ${providerId}\n\n`)

  const working: string[] = []
  const refused: [string, string][] = []

  // A handful at a time: the point is to finish, not to be fast, and a
  // provider that is rate-limiting will report every model as broken.
  const BATCH = 4
  for (let at = 0; at < models.length; at += BATCH) {
    const batch = models.slice(at, at + BATCH)
    const results = await Promise.all(
      batch.map(async (model) => [model, await probe(endpoint, apiKey, model, fetchImpl)] as const),
    )

    for (const [model, problem] of results) {
      if (problem === undefined) {
        working.push(model)
        io.write(`  ok      ${model}\n`)
      } else {
        refused.push([model, problem])
        io.write(`  no      ${model}  ${problem}\n`)
      }
    }
  }

  io.write(`\n${working.length} of ${models.length} usable\n`)
  if (working.length > 0) {
    io.write(`\naidcrew models use ${working[0]}\n`)
  }

  return refused.length === models.length ? 1 : 0
}

/** One tiny request. Returns why it failed, or nothing if it worked. */
async function probe(
  endpoint: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof fetch,
): Promise<string | undefined> {
  try {
    const response = await fetchImpl(`${endpoint.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(20_000),
    })

    if (response.ok) return undefined

    const body = await response.text().catch(() => '')
    return explain(body) ?? `${response.status}`
  } catch (cause) {
    return cause instanceof Error ? cause.message : 'no answer'
  }
}

/** The sentence a provider meant to be read, out of the envelope it came in. */
function explain(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string }
    const message = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message
    if (typeof message !== 'string') return undefined
    return message.length > 70 ? `${message.slice(0, 70)}…` : message
  } catch {
    return undefined
  }
}
