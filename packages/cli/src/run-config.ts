import type { SettingsStore } from './store.ts'

export class ConfigUsageError extends Error {
  override readonly name = 'ConfigUsageError'
}

export type ConfigIo = {
  write(text: string): void
  writeError(text: string): void
  /** Reads the secret, so it never appears in argv, in `ps` or in shell history. */
  readSecret(prompt: string): Promise<string>
}

const CONFIG_USAGE = `Usage:
  aidcrew config                          show what is configured
  aidcrew config set-key <scope>          save a key (typed, not passed as an argument)
  aidcrew config unset-key <scope>        forget a key
  aidcrew config set <key> <value>        save a setting
  aidcrew config unset <key>              forget a setting

Scopes:
  provider:<id>    used by every agent on that service, e.g. provider:anthropic
  agent:<id>       used by that agent alone, e.g. agent:architect

An agent scope is how two agents on the same service run on different plans.`

/**
 * Reads and writes the settings a person would otherwise have to export in a
 * shell. This is the same store a settings screen will write to; today it has
 * a command-line front, tomorrow a panel.
 */
export async function runConfig(
  rest: string[],
  store: SettingsStore,
  io: ConfigIo,
): Promise<number> {
  const [action, ...args] = rest

  switch (action) {
    case undefined:
      show(store, io)
      return 0

    case 'set-key':
      return await setKey(args, store, io)

    case 'unset-key': {
      const scope = requireScope(args[0])
      store.forgetSecret(scope)
      io.write(`forgot the key for ${scope}\n`)
      return 0
    }

    case 'set': {
      const [key, value] = args
      if (!key || value === undefined) {
        throw new ConfigUsageError('usage: aidcrew config set <key> <value>')
      }
      store.set(key, value)
      io.write(`${key} = ${value}\n`)
      return 0
    }

    case 'unset': {
      const [key] = args
      if (!key) throw new ConfigUsageError('usage: aidcrew config unset <key>')
      store.unset(key)
      io.write(`forgot ${key}\n`)
      return 0
    }

    default:
      throw new ConfigUsageError(`unknown config action "${action}".\n\n${CONFIG_USAGE}`)
  }
}

async function setKey(args: string[], store: SettingsStore, io: ConfigIo): Promise<number> {
  const scope = requireScope(args[0], store)

  if (args.length > 1) {
    // Refused rather than accepted: a key on the command line is written to
    // shell history and visible in the process list to everyone on the machine.
    throw new ConfigUsageError(
      'do not pass the key as an argument — it would be saved in your shell history ' +
        'and visible in the process list. Run "aidcrew config set-key ' +
        `${scope}" and type it when asked, or pipe it in.`,
    )
  }

  const apiKey = (await io.readSecret(`key for ${scope}: `)).trim()
  if (apiKey === '') {
    throw new ConfigUsageError('no key given, nothing saved')
  }

  store.setCredential(scope, { apiKey })
  io.write(`saved the key for ${scope}\n`)
  return 0
}

function requireScope(scope: string | undefined, _store?: SettingsStore): string {
  if (!scope) {
    throw new ConfigUsageError(`a scope is required.\n\n${CONFIG_USAGE}`)
  }
  if (!scope.startsWith('provider:') && !scope.startsWith('agent:')) {
    throw new ConfigUsageError(
      `"${scope}" is not a scope. Use provider:<id> for a whole service, ` +
        'or agent:<id> for one agent.',
    )
  }
  return scope
}

function show(store: SettingsStore, io: ConfigIo): void {
  const credentials = store.knownSecrets()
  const settings = store.list()

  io.write(`settings stored in ${store.path}\n\n`)

  if (credentials.length === 0) {
    io.write('no keys saved yet. Add one with:\n  aidcrew config set-key provider:zen\n')
  } else {
    io.write('keys:\n')
    for (const entry of credentials) {
      io.write(`  ${entry.scope.padEnd(28)} ${entry.hint}\n`)
    }
  }

  if (settings.length > 0) {
    io.write('\nsettings:\n')
    for (const { key, value } of settings) {
      io.write(`  ${key.padEnd(28)} ${value}\n`)
    }
  }
}
