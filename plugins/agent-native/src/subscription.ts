import { execFile } from 'node:child_process'
import { z } from 'zod'

const credentialVariables = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'ANTHROPIC_CUSTOM_HEADERS',
  'ANTHROPIC_PROFILE',
  'ANTHROPIC_FEDERATION_RULE_ID',
  'ANTHROPIC_ORGANIZATION_ID',
  'ANTHROPIC_IDENTITY_TOKEN_FILE',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
] as const

/** Login remains in Claude's own configuration; keys and provider overrides are child-local. */
export function subscriptionEnvironment(source: Record<string, string | undefined> = process.env) {
  const env = { ...source }
  for (const name of Object.keys(env))
    if (name.startsWith('ANTHROPIC_') || credentialVariables.some((variable) => variable === name))
      delete env[name]
  return env
}

// Settings may reintroduce environment variables after spawn, so the same overrides go to both processes.
export const subscriptionSettings = {
  forceLoginMethod: 'claudeai',
  apiKeyHelper: '',
  env: Object.fromEntries(credentialVariables.map((name) => [name, ''])),
} as const

type RunOptions = {
  cwd: string
  env: Record<string, string | undefined>
  signal?: AbortSignal
}
type RunStatus = (args: string[], options: RunOptions) => Promise<string>

const runStatus: RunStatus = (args, options) =>
  new Promise((resolve, reject) => {
    const executable = args[0]
    if (!executable) return reject(new Error('Missing Claude executable'))
    execFile(
      executable,
      args.slice(1),
      { ...options, encoding: 'utf8', timeout: 10_000, maxBuffer: 64_000 },
      (error, stdout) => {
        if (error) reject(new Error('Claude authentication check failed'))
        else resolve(stdout)
      },
    )
  })

const subscriptionSchema = z.object({
  loggedIn: z.literal(true),
  authMethod: z.literal('claude.ai'),
  apiProvider: z.literal('firstParty'),
  subscriptionType: z.enum(['pro', 'max', 'team', 'enterprise']),
})

/** Auth status can contain account identifiers; never include its output in errors or logs. */
export async function assertSubscriptionLogin(
  cwd: string,
  signal?: AbortSignal,
  run: RunStatus = runStatus,
): Promise<void> {
  signal?.throwIfAborted()
  let output: string
  try {
    output = await run(
      ['claude', '--settings', JSON.stringify(subscriptionSettings), 'auth', 'status', '--json'],
      { cwd, env: subscriptionEnvironment(), ...(signal ? { signal } : {}) },
    )
  } catch {
    signal?.throwIfAborted()
    throw new Error('Could not verify Claude subscription login. Run claude auth login and retry.')
  }
  signal?.throwIfAborted()
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    throw new Error('Claude subscription login is required. Run claude auth login and retry.')
  }
  if (!subscriptionSchema.safeParse(value).success)
    throw new Error('Claude subscription login is required. Run claude auth login and retry.')
}
