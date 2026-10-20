import { expect, test } from 'bun:test'
import { parseCliArgs } from './args.ts'
import { main } from './main.ts'
import { runNativeClaude } from './native-claude.ts'

test('passes every Claude argument through without parsing harness flags', () => {
  const args = ['--resume', 'session', '--model', 'opus', '-p', 'hello', '--help']
  expect(parseCliArgs(['claude', ...args])).toMatchObject({
    command: 'claude',
    rest: args,
    help: false,
  })
})

test('runs the installed CLI with unchanged auth environment and inherited terminal', async () => {
  const env = { PATH: '/tools', ANTHROPIC_API_KEY: 'fixture-key' }
  let seen: unknown
  const code = await runNativeClaude({
    args: ['--resume', 'id'],
    cwd: '/worktree',
    env,
    spawn: (argv, options) => {
      seen = { argv, options }
      return { exited: Promise.resolve(17) }
    },
  })
  expect(code).toBe(17)
  expect(seen).toEqual({
    argv: ['claude', '--resume', 'id'],
    options: { cwd: '/worktree', env, stdin: 'inherit', stdout: 'inherit', stderr: 'inherit' },
  })
})

test('routes native Claude before opening stores or resolving provider keys', async () => {
  let called = false
  const code = await main(
    ['claude', '--version'],
    {},
    { write: () => {}, writeError: () => {}, color: false },
    new AbortController().signal,
    {
      home: '/does-not-exist/native-claude-test',
      nativeClaude: async (options) => {
        called = true
        expect(options.args).toEqual(['--version'])
        return 9
      },
    },
  )
  expect(called).toBe(true)
  expect(code).toBe(9)
})

test('reports an unavailable executable without exposing environment values', async () => {
  await expect(
    runNativeClaude({
      args: [],
      cwd: '/repo',
      env: { SECRET: 'never-print' },
      spawn: () => {
        throw Object.assign(new Error('spawn failure'), { code: 'ENOENT' })
      },
    }),
  ).rejects.toThrow('Claude Code is not installed')
})
