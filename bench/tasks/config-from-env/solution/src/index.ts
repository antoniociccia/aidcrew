import { type Config, DEFAULTS, merge, validate } from './config.ts'
import { fromEnv } from './env.ts'

/** The configuration a run starts with: the file over the defaults, the environment over both. */
export function resolveConfig(
  file: Partial<Config> = {},
  env: Record<string, string | undefined> = process.env,
): Config {
  return validate(merge(merge(DEFAULTS, file), fromEnv(env)))
}
