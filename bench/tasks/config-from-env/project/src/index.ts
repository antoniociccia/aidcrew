import { type Config, DEFAULTS, merge } from './config.ts'

/** The configuration a run starts with. */
export function resolveConfig(file: Partial<Config> = {}): Config {
  return merge(DEFAULTS, file)
}
