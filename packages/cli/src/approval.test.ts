import { describe, expect, test } from 'bun:test'
import type { ToolCallInfo, ToolContext } from '@aidcrew/core'
import type { Decision } from './approval.ts'
import { classify, createApprovalHook } from './approval.ts'

const context: ToolContext = {
  cwd: '/repo',
  signal: new AbortController().signal,
  agentId: 'coder',
}
const call = (name: string, input: unknown): ToolCallInfo => ({ id: 't1', name, input })

function hookThatAnswers(decision: Decision, remembered = new Set<string>()) {
  const asked: string[] = []
  const hook = createApprovalHook({
    remembered,
    enabled: true,
    ask: async (request) => {
      asked.push(request.summary)
      return decision
    },
  })
  return { hook, asked, remembered }
}

describe('what gets asked about', () => {
  test('a shell command does', () => {
    expect(classify(call('bash', { command: 'rm -rf build' }))).toMatchObject({
      because: 'runs a command',
    })
  })

  test('writing and editing do', () => {
    expect(classify(call('write', { path: 'a.ts' }))?.because).toBe('writes a file')
    expect(classify(call('edit', { path: 'a.ts' }))?.because).toBe('changes a file')
  })

  test('reading does not', () => {
    expect(classify(call('read', { path: 'a.ts' }))).toBeUndefined()
  })

  test('a command that only reads does not', () => {
    // Asking about the twentieth `git status` is what teaches people to
    // approve without reading, which is worse than not asking.
    for (const command of ['ls -la', 'cat package.json', 'grep -r foo .', 'pwd']) {
      expect(classify(call('bash', { command }))).toBeUndefined()
    }
  })

  test('a reading command that is redirected does', () => {
    // `echo` is harmless; `echo x > file` is not, and they differ by one
    // character the first word cannot see.
    expect(classify(call('bash', { command: 'echo hi' }))).toBeUndefined()
    expect(classify(call('bash', { command: 'echo hi > /etc/hosts' }))).toBeDefined()
    expect(classify(call('bash', { command: 'cat x | tee y' }))).toBeDefined()
    expect(classify(call('bash', { command: 'ls; rm -rf .' }))).toBeDefined()
    expect(classify(call('bash', { command: 'echo $(rm -rf /)' }))).toBeDefined()
  })

  test('a command that prints the environment does', () => {
    // `bash` inherits this process's environment, and this process holds the
    // keys. `env` was a reading command, so an exported AIDCREW_API_KEY went
    // into the tool result, the record on disk and the next request to the
    // provider, with no prompt on the way.
    for (const command of ['env', 'printenv', 'set', 'export']) {
      expect(classify(call('bash', { command }))).toBeDefined()
    }
  })

  test('a reading command that reaches for a variable does', () => {
    // `echo hi` is harmless and `echo $AIDCREW_API_KEY` is the leak above one
    // variable at a time. A dollar sign is the shell about to substitute
    // something, and what that is cannot be seen from the first word.
    expect(classify(call('bash', { command: 'echo $AIDCREW_API_KEY' }))).toBeDefined()
    expect(classify(call('bash', { command: 'cat <(id)' }))).toBeDefined()
  })

  test('a command that writes does, even when it starts innocently', () => {
    expect(classify(call('bash', { command: 'git push --force' }))).toBeDefined()
    expect(classify(call('bash', { command: 'rm -rf /' }))).toBeDefined()
  })

  test('shows the command itself, truncated if it is enormous', () => {
    const long = classify(call('bash', { command: `rm ${'x'.repeat(300)}` }))

    expect(long?.summary.length).toBeLessThan(130)
    expect(long?.summary).toContain('…')
  })
})

describe('the hook', () => {
  test('lets an approved call through', async () => {
    const { hook } = hookThatAnswers('once')

    expect(await hook.preToolCall?.(call('bash', { command: 'rm x' }), context)).toBeUndefined()
  })

  test('turns a refusal into a failed result, not an exception', async () => {
    // The session should carry on: the agent can say something else instead.
    const { hook } = hookThatAnswers('no')

    const result = await hook.preToolCall?.(call('bash', { command: 'rm x' }), context)

    expect(result).toMatchObject({ isError: true })
    expect(result?.content).toMatch(/not approved/)
  })

  test('does not ask twice once "always" was chosen for that command', async () => {
    const { hook, asked } = hookThatAnswers('always')

    await hook.preToolCall?.(call('bash', { command: 'git push' }), context)
    await hook.preToolCall?.(call('bash', { command: 'git push --tags' }), context)

    expect(asked).toHaveLength(1)
  })

  test('still asks about a different command', async () => {
    const { hook, asked } = hookThatAnswers('always')

    await hook.preToolCall?.(call('bash', { command: 'git push' }), context)
    await hook.preToolCall?.(call('bash', { command: 'rm -rf build' }), context)

    expect(asked).toHaveLength(2)
  })

  test('"always" for a file tool covers that tool, not that one file', async () => {
    // What it used to do: remember `write:src/auth.ts` and ask again for the
    // very next file. An "always" that covers one path is an "always" that
    // never stops the asking, which is the same as not having it.
    const { hook, asked } = hookThatAnswers('always')

    await hook.preToolCall?.(call('write', { path: 'src/auth.ts' }), context)
    await hook.preToolCall?.(call('write', { path: 'docs/README.md' }), context)

    expect(asked).toHaveLength(1)
  })

  test('"folder" covers the directory it was asked about, and no further', async () => {
    const { hook, asked } = hookThatAnswers('folder')

    await hook.preToolCall?.(call('write', { path: 'src/auth.ts' }), context)
    await hook.preToolCall?.(call('write', { path: 'src/deep/token.ts' }), context)
    // A different folder is a different decision: allowing writes under src/
    // says nothing about writing to the project's config.
    await hook.preToolCall?.(call('write', { path: 'ops/deploy.yaml' }), context)

    expect(asked).toHaveLength(2)
  })

  test('"folder" does not reach past the folder through ".."', async () => {
    // `src/../package.json` begins with `src/` and is not in it. A folder
    // answer compared spellings, so allowing writes under src/ allowed a write
    // to the project's config with no prompt at all.
    const { hook, asked } = hookThatAnswers('folder')

    await hook.preToolCall?.(call('write', { path: 'src/a.ts' }), context)
    await hook.preToolCall?.(call('write', { path: 'src/../package.json' }), context)

    expect(asked).toHaveLength(2)
  })

  test('"folder" covers another spelling of the same folder', async () => {
    const { hook, asked } = hookThatAnswers('folder')

    await hook.preToolCall?.(call('write', { path: './src/a.ts' }), context)
    await hook.preToolCall?.(call('write', { path: 'src/b.ts' }), context)

    expect(asked).toHaveLength(1)
  })

  test('offers no folder for a path that leaves the project, or names an absolute one', () => {
    // "Yes, in this folder" for `../elsewhere/` is a yes to writing outside
    // the project, dressed as the smaller answer.
    expect(classify(call('write', { path: '../other/a.ts' }))?.scopes.folder).toBeUndefined()
    expect(classify(call('write', { path: '/etc/cron.d/job' }))?.scopes.folder).toBeUndefined()
  })

  test('"folder" is remembered per agent, like every other answer', async () => {
    const { hook, asked } = hookThatAnswers('folder')

    await hook.preToolCall?.(call('write', { path: 'src/a.ts' }), context)
    await hook.preToolCall?.(call('write', { path: 'src/b.ts' }), {
      ...context,
      agentId: 'somebody-else',
    })

    expect(asked).toHaveLength(2)
  })

  test('a request says what each answer would cover, in the words of the thing', () => {
    // The prompt has to say what is being allowed, or "always" is a leap.
    expect(classify(call('write', { path: 'src/auth.ts' }))).toMatchObject({
      scopes: { folder: 'write src/*', broad: 'write *' },
    })
    expect(classify(call('bash', { command: 'npm test --watch' }))).toMatchObject({
      scopes: { broad: 'bash npm …' },
    })
  })

  test('asks again next time for "once"', async () => {
    const { hook, asked } = hookThatAnswers('once')

    await hook.preToolCall?.(call('bash', { command: 'git push' }), context)
    await hook.preToolCall?.(call('bash', { command: 'git push' }), context)

    expect(asked).toHaveLength(2)
  })

  test('asks about nothing when there is nobody to ask', async () => {
    const asked: string[] = []
    const hook = createApprovalHook({
      remembered: new Set(),
      enabled: false,
      ask: async (request) => {
        asked.push(request.summary)
        return 'no'
      },
    })

    await hook.preToolCall?.(call('bash', { command: 'rm -rf /' }), context)

    expect(asked).toEqual([])
  })
})

describe('who is asking', () => {
  test('names the agent, so the request can be shown next to it', async () => {
    const asked: string[] = []
    const hook = createApprovalHook({
      remembered: new Set(),
      enabled: true,
      ask: async (request) => {
        asked.push(request.agentId)
        return 'once'
      },
    })

    await hook.preToolCall?.(call('bash', { command: 'rm -rf build' }), {
      ...context,
      agentId: 'reviewer',
    })

    expect(asked).toEqual(['reviewer'])
  })

  test('remembers per agent: allowing one is not allowing the team', async () => {
    const asked: string[] = []
    const hook = createApprovalHook({
      remembered: new Set(),
      enabled: true,
      ask: async (request) => {
        asked.push(request.agentId)
        return 'always'
      },
    })
    const run = { ...call('bash', { command: 'git push' }) }

    await hook.preToolCall?.(run, { ...context, agentId: 'coder' })
    await hook.preToolCall?.(run, { ...context, agentId: 'coder' })
    await hook.preToolCall?.(run, { ...context, agentId: 'reviewer' })

    expect(asked).toEqual(['coder', 'reviewer'])
  })
})

describe('an agent that is trusted to work alone', () => {
  test('is not asked about the routine', async () => {
    const asked: string[] = []
    const hook = createApprovalHook({
      remembered: new Set(),
      enabled: true,
      trusted: (agentId) => agentId === 'coder',
      ask: async (request) => {
        asked.push(request.agentId)
        return 'once'
      },
    })

    await hook.preToolCall?.(call('bash', { command: 'git commit -m x' }), {
      ...context,
      agentId: 'coder',
    })

    expect(asked).toEqual([])
  })

  test('does not make the rest of the team trusted too', async () => {
    const asked: string[] = []
    const hook = createApprovalHook({
      remembered: new Set(),
      enabled: true,
      trusted: (agentId) => agentId === 'coder',
      ask: async (request) => {
        asked.push(request.agentId)
        return 'once'
      },
    })

    await hook.preToolCall?.(call('write', { path: 'src/a.ts' }), {
      ...context,
      agentId: 'reviewer',
    })

    expect(asked).toEqual(['reviewer'])
  })
})
