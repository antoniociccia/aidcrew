import { expect, test } from 'bun:test'
import {
  assertSubscriptionLogin,
  subscriptionEnvironment,
  subscriptionSettings,
} from './subscription.ts'

const subscription = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  subscriptionType: 'max',
}

test('sanitizes only the child environment and preserves the native login location', () => {
  const original = {
    PATH: '/bin',
    HOME: '/home/test',
    CLAUDE_CONFIG_DIR: '/login',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_PROFILE: 'api',
    CLAUDE_CODE_USE_BEDROCK: '1',
    CLAUDE_CODE_OAUTH_TOKEN: 'token',
  }
  const env = subscriptionEnvironment(original)
  expect(env.PATH).toBe('/bin')
  expect(env.CLAUDE_CONFIG_DIR).toBe('/login')
  expect(env.ANTHROPIC_API_KEY).toBeUndefined()
  expect(env.ANTHROPIC_PROFILE).toBeUndefined()
  expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined()
  expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined()
  expect(original.ANTHROPIC_API_KEY).toBe('secret')
  expect(subscriptionSettings).toMatchObject({
    forceLoginMethod: 'claudeai',
    apiKeyHelper: '',
    env: { ANTHROPIC_API_KEY: '', ANTHROPIC_AUTH_TOKEN: '' },
  })
})

test('verifies subscription login in the task directory with matching native settings', async () => {
  await assertSubscriptionLogin('/task', undefined, async (args, options) => {
    expect(options.cwd).toBe('/task')
    expect(args[0]).toBe('claude')
    expect(args.slice(-3)).toEqual(['auth', 'status', '--json'])
    expect(JSON.parse(args[2] ?? '')).toEqual(subscriptionSettings)
    return JSON.stringify(subscription)
  })
})

test('rejects API, helper, third-party, absent and unknown authentication without leaking status', async () => {
  const states = [
    { ...subscription, authMethod: 'api_key' },
    { ...subscription, authMethod: 'api_key_helper' },
    { ...subscription, authMethod: 'oauth_token' },
    { ...subscription, apiProvider: 'bedrock' },
    { ...subscription, loggedIn: false },
    { ...subscription, subscriptionType: 'unknown' },
    {},
  ]
  for (const state of states) {
    const run = () =>
      assertSubscriptionLogin('/task', undefined, async () =>
        JSON.stringify({ ...state, email: 'private@example.test' }),
      )
    await expect(run()).rejects.toThrow('Claude subscription login is required')
  }
  await expect(
    assertSubscriptionLogin('/task', undefined, async () => 'private invalid output'),
  ).rejects.toThrow('Claude subscription login is required')
  await expect(
    assertSubscriptionLogin('/task', undefined, async () => {
      throw new Error('private stderr')
    }),
  ).rejects.toThrow('Could not verify Claude subscription login')
})

test('never launches an authentication check after cancellation', async () => {
  const controller = new AbortController()
  controller.abort()
  let called = false
  await expect(
    assertSubscriptionLogin('/task', controller.signal, async () => {
      called = true
      return JSON.stringify(subscription)
    }),
  ).rejects.toThrow()
  expect(called).toBe(false)
})
