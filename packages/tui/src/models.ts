/**
 * Asking a provider which models it has.
 *
 * Most OpenAI-compatible services answer `GET /models`, so the interface can
 * offer a list instead of a blank field — which matters, because a model id is
 * exactly the kind of string nobody remembers and everybody mistypes.
 *
 * A provider that does not answer is not a problem: the caller falls back to
 * typing one in. This never throws.
 */

export type ModelListing =
  | { kind: 'listed'; models: string[] }
  | { kind: 'unavailable'; reason: string }

const TIMEOUT_MS = 8000

export async function listModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelListing> {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/models`

  try {
    const response = await fetchImpl(endpoint, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!response.ok) {
      // 401 here is worth saying plainly: it means the key is wrong, and
      // finding that out now beats finding out on the first real request.
      return {
        kind: 'unavailable',
        reason:
          response.status === 401 || response.status === 403
            ? 'the key was rejected'
            : `the provider answered ${response.status}`,
      }
    }

    const body = (await response.json()) as { data?: { id?: unknown }[] }
    const models = (body.data ?? [])
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === 'string' && id !== '')
      .sort()

    return models.length > 0
      ? { kind: 'listed', models }
      : { kind: 'unavailable', reason: 'the provider listed no models' }
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return {
      kind: 'unavailable',
      reason: message.includes('timed out') ? 'the provider did not answer' : message,
    }
  }
}

/**
 * Models worth putting at the top of a long list.
 *
 * Coding agents want models that are good at following instructions and using
 * tools, which is not the same as the newest or the largest — and a team of
 * four is four bills, so the cheap tier of each family comes before the
 * expensive one. A person picking a first model gets glm-5.3-flash and
 * qwen3.8-flash at the top and claude-opus-5 further down, where choosing it
 * is a decision rather than a default. Matched loosely against whatever the
 * provider actually returns.
 */
const PREFERRED = [
  'glm',
  'qwen',
  'deepseek',
  'kimi',
  'minimax',
  'gpt',
  'gemini',
  'claude',
  'opus',
  'sonnet',
]

/** The words a family puts on its cheap tier. */
const CHEAP = ['flash', 'mini', 'nano', 'lite', 'free']

export function rankForCoding(models: string[]): string[] {
  const score = (model: string): number => {
    const id = model.toLowerCase()
    const family = PREFERRED.findIndex((hint) => id.includes(hint))
    const known = family === -1 ? PREFERRED.length : family
    const cheap = CHEAP.some((hint) => id.includes(hint)) ? 0 : 1
    // Cheap tiers of every known family first, then the rest by family.
    return known === PREFERRED.length ? 2 * PREFERRED.length : cheap * PREFERRED.length + known
  }

  return [...models].sort((a, b) => score(a) - score(b) || a.localeCompare(b))
}

/**
 * Whether a model costs nothing to use.
 *
 * Gateways mark their free tier in the model id — OpenCode Zen appends
 * `-free` — and someone choosing a first model wants to know which ones will
 * work before they have paid for anything. Getting a 402 on the first request
 * is a bad way to find out.
 */
export function isFree(model: string): boolean {
  return /-free$/.test(model)
}
