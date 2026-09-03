/**
 * Turning "that model does not exist" into a name the person can use.
 *
 * Endpoints are bad at saying this. The one that prompted the file answers
 * `Endpoint is unavailable` for a model it has never heard of — a sentence
 * about the network for a mistake in a config file — so a typo reads as an
 * outage and gets waited out rather than fixed. The shortlist itself now
 * lives in the SDK, where the other dialects can offer it too.
 */

export { nearest } from '@aidcrew/plugin-sdk'

/**
 * The models an OpenAI-shaped endpoint will answer for.
 *
 * A catalogue, not an entitlement: a name here means the gateway will route
 * it, not that the plan covers it or that the upstream is up. Both were seen
 * on the same endpoint on the same afternoon — one listed model answered
 * "insufficient balance", another a bare 500 from behind the gateway.
 */
export async function listOpenAiModels(
  config: {
    baseUrl: string
    apiKey: string
    fetchImpl?: (url: string, init: RequestInit) => Promise<Response>
  },
  signal: AbortSignal,
): Promise<string[]> {
  const doFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const response = await doFetch(`${config.baseUrl.replace(/\/+$/, '')}/models`, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
    signal,
  })

  if (!response.ok) {
    // Told apart from a general failure because finding out the key is wrong
    // while choosing a model beats finding out on the first real request.
    throw new Error(
      response.status === 401 || response.status === 403
        ? 'the key was rejected'
        : `the provider answered ${response.status}`,
    )
  }

  const body: unknown = await response.json()
  const rows = (body as { data?: unknown })?.data
  if (!Array.isArray(rows)) throw new Error('the provider answered with no model list')

  return rows
    .map((row) => (row as { id?: unknown })?.id)
    .filter((id): id is string => typeof id === 'string')
}
