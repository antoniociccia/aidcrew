// A real provider, found the way the aidcrew CLI finds one: the bundled and
// user plugins, and the credential from the environment or the saved
// settings. The key goes into the provider and nowhere else: not into a
// message, not into the store.
import { homedir } from 'node:os'
import {
  createHost,
  createProvider,
  keyForProvider,
  openStore as openSettings,
  providerOptions,
} from '@aidcrew/cli'
import type { AidcrewProvider } from './aidcrew.ts'

/** The environment-variable spelling of a provider id, as the CLI spells it. */
const slug = (providerId: string) => providerId.toUpperCase().replaceAll(/[^A-Z0-9]/g, '_')

export async function providerFromAidcrew(
  providerId: string,
  env: Record<string, string | undefined> = process.env,
): Promise<AidcrewProvider> {
  // AIDCREW_HOME points a run at another home, as it does for the CLI.
  const home = env.AIDCREW_HOME?.trim() || homedir()
  const settings = openSettings(home)
  const resolved = keyForProvider(providerId, { env, store: settings })
  if (!resolved) {
    throw new Error(
      `no credential for ${providerId}: add it in aidcrew or set AIDCREW_API_KEY_${slug(providerId)}`,
    )
  }
  const host = await createHost({ home })
  return createProvider(host, providerId, {
    apiKey: resolved.apiKey,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
    ...providerOptions(providerId, env, settings),
  })
}
