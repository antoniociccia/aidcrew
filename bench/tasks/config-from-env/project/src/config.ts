export type Config = { port: number; host: string; debug: boolean; name: string }

export const DEFAULTS: Config = { port: 3000, host: 'localhost', debug: false, name: 'app' }

/** The defaults, with whatever the file overrides on top. */
export function merge(defaults: Config, overrides: Partial<Config>): Config {
  return { ...defaults, ...overrides }
}
