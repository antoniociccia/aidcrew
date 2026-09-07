export type Config = { port: number; host: string; debug: boolean; name: string }

export const DEFAULTS: Config = { port: 3000, host: 'localhost', debug: false, name: 'app' }

/** The defaults, with whatever the file overrides on top. */
export function merge(defaults: Config, overrides: Partial<Config>): Config {
  return { ...defaults, ...overrides }
}

/** The config, or a TypeError naming the field that is wrong. */
export function validate(config: Config): Config {
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new TypeError(`port must be an integer between 1 and 65535, got ${config.port}`)
  }
  if (config.host === '') throw new TypeError('host must not be empty')
  if (config.name === '') throw new TypeError('name must not be empty')
  return config
}
