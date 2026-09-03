import type { PriceSource } from '@aidcrew/core'
import { definePlugin, definePrices } from '@aidcrew/plugin-sdk'
import type { Allowance } from './allowance.ts'
import { fromUsage } from './allowance.ts'
import { fromListing } from './table.ts'

/**
 * Prices, from the services that publish them.
 *
 * OpenRouter states a price per model in the same listing it states the models
 * in, and services speaking that dialect either do the same or say nothing.
 * Saying nothing is a real answer and comes back as an empty table: a model
 * whose price is unknown and a model that is free are different facts, and
 * showing the first as the second tells a comfortable lie about a bill.
 *
 * Fetched here rather than kept as a table in the repository, because a price
 * list committed to a repository is a price list that is wrong by the time
 * anybody reads it.
 */

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

/**
 * What is left of a plan, for a service that sells one rather than tokens.
 *
 * Asked at `/usage`, which is where OpenCode publishes it. A service that has
 * nothing there says so with a 404 and gets nothing, which is the right answer
 * for one that bills per token.
 */
export async function loadAllowance(
  providerId: string,
  config: unknown,
): Promise<Allowance | undefined> {
  const { baseUrl, apiKey, fetchImpl } = (config ?? {}) as Config
  if (!baseUrl) return undefined

  const get = fetchImpl ?? ((url, init) => fetch(url, init))

  try {
    const response = await get(`${baseUrl.replace(/\/+$/, '')}/usage`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    })
    if (!response.ok) return undefined
    return fromUsage(await response.json(), providerId)
  } catch {
    // Knowing what is left of a plan is a convenience, never a precondition.
    return undefined
  }
}

type Config = { baseUrl?: string; apiKey?: string; fetchImpl?: Fetcher }

export function createListingPrices(id = 'listing'): PriceSource {
  return definePrices({
    id,
    // Anything that answers at an OpenAI-shaped `/models`, which is most of
    // them. One that publishes no prices simply returns nothing.
    covers: () => true,

    async load(providerId, config) {
      const { baseUrl, apiKey, fetchImpl } = (config ?? {}) as Config
      if (!baseUrl) return {}

      const get = fetchImpl ?? ((url, init) => fetch(url, init))

      try {
        const response = await get(`${baseUrl.replace(/\/+$/, '')}/models`, {
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        })
        if (!response.ok) return {}
        return fromListing(await response.json(), providerId)
      } catch {
        // A price list is a convenience. Failing to fetch one must never be
        // the reason a session does not start.
        return {}
      }
    },
  })
}

export default definePlugin({
  name: 'prices',
  version: '0.0.0',
  prices: [createListingPrices()],
})
