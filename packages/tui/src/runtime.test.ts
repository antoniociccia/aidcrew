import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost, openJournal } from '@aidcrew/cli'
import type { TeamEvent } from '@aidcrew/core'
import { openRuntime, stallNotice, startTeam, toLines } from './runtime.ts'
import type { Line } from './screens/session.tsx'

const usage = { inputTokens: 1, outputTokens: 1 }

describe('toLines', () => {
  test('shows what the agent said', () => {
    // The bug this covers: tool calls appeared and the answer never did,
    // which is the one thing the interface exists to show.
    const event: TeamEvent = {
      type: 'agent_event',
      id: 'coder',
      event: {
        type: 'assistant_turn',
        turn: {
          content: [{ type: 'text', text: 'Il token non veniva ruotato.' }],
          stopReason: 'end_turn',
          usage,
        },
      },
    }

    expect(toLines(event)).toEqual([
      { agentId: 'coder', kind: 'say', text: 'Il token non veniva ruotato.' },
    ])
  })

  test('keeps reasoning apart from the answer, so it can be hidden', () => {
    const lines = toLines({
      type: 'agent_event',
      id: 'coder',
      event: {
        type: 'assistant_turn',
        turn: {
          content: [
            { type: 'thinking', text: 'the guard runs first' },
            { type: 'text', text: 'Sistemato.' },
          ],
          stopReason: 'end_turn',
          usage,
        },
      },
    })

    expect(lines.map((line) => line.kind)).toEqual(['thinking', 'say'])
  })

  test('ignores an empty answer rather than adding a blank line', () => {
    const lines = toLines({
      type: 'agent_event',
      id: 'coder',
      event: {
        type: 'assistant_turn',
        turn: { content: [{ type: 'text', text: '   ' }], stopReason: 'tool_use', usage },
      },
    })

    expect(lines).toEqual([])
  })

  test('says when an agent starts in a checkout the last session left work in', () => {
    // The files are there before the agent has done anything. Without this a
    // person reads the agent's first report as though it had written them.
    const lines = toLines({ type: 'workspace_resumed', id: 'coder', task: 'main', changed: 3 })

    expect(lines).toEqual([
      {
        agentId: 'coder',
        kind: 'note',
        text: 'picked up the checkout for main where the last session left it: 3 files changed and not committed',
      },
    ])
  })

  test('says when a checkout stays behind because of the work in it', () => {
    const lines = toLines({ type: 'workspace_kept', task: 'main', path: '/repo/.aidcrew/wt/main' })

    expect(lines).toEqual([
      {
        agentId: 'main',
        kind: 'note',
        text: 'kept the checkout for main, at /repo/.aidcrew/wt/main: the work in it is nowhere else, and the next session picks it up',
      },
    ])
  })

  test('says when an unleashed agent was sent back past its turn limit', () => {
    const lines = toLines({ type: 'agent_continued', id: 'coder', round: 2, of: 4 })

    expect(lines).toEqual([
      {
        agentId: 'coder',
        kind: 'note',
        text: 'reached its turn limit with the work unfinished — sent back to carry on (2 of 4)',
      },
    ])
  })

  test('shows a tool call with its main argument', () => {
    const lines = toLines({
      type: 'agent_event',
      id: 'coder',
      event: { type: 'tool_start', id: 't1', name: 'read', input: { path: 'src/auth.ts' } },
    })

    expect(lines[0]).toMatchObject({ kind: 'tool', text: 'read src/auth.ts' })
  })

  test('shows a failed tool, and not a successful one', () => {
    const failed = toLines({
      type: 'agent_event',
      id: 'coder',
      event: {
        type: 'tool_end',
        id: 't1',
        name: 'bash',
        output: { content: 'exit 1', isError: true },
        durationMs: 5,
      },
    })
    const fine = toLines({
      type: 'agent_event',
      id: 'coder',
      event: {
        type: 'tool_end',
        id: 't1',
        name: 'bash',
        output: { content: 'ok' },
        durationMs: 5,
      },
    })

    expect(failed[0]?.kind).toBe('error')
    expect(fine).toEqual([])
  })

  test('shows a message going from one agent to another, on both sides', () => {
    const lines = toLines({ type: 'agent_message', from: 'architect', to: 'coder', text: 'go' })

    expect(lines.map((line) => line.agentId)).toEqual(['architect', 'coder'])
  })

  test('shows a failure against the agent that hit it', () => {
    const lines = toLines({ type: 'agent_failed', id: 'coder', reason: 'zen: no credit' })

    expect(lines[0]).toEqual({ agentId: 'coder', kind: 'error', text: 'zen: no credit' })
  })
})

describe('reopening a project', () => {
  test('the first thing the interface is handed is what was said before', async () => {
    // The bug this covers: startTeam announced itself with an empty list,
    // throwing away the transcript it had just read off the disk — so a
    // resumed session looked exactly like a lost one.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-resume-')))
    try {
      const before = openJournal(cwd, cwd)
      before.append({ agentId: 'coder', kind: 'say', text: 'the rotation was missing' })
      before.close()

      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: {},
        agents: [],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })
      await team.shutdown()

      expect(handed[0]).toEqual([
        { agentId: 'coder', kind: 'say', text: 'the rotation was missing' },
      ])
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('what an agent remembers across a restart', () => {
  /** A model that answers, and reports what it was given. */
  function scripted(seen: string[][]) {
    return Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as {
          messages: { role: string; content: unknown }[]
        }
        seen.push(
          body.messages.map((message) =>
            typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
          ),
        )
        const events = [
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'noted' } }] })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2 } })}\n\n`,
          'data: [DONE]\n\n',
        ].join('')
        return new Response(events, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })
  }

  test('the conversation and the running total both come back', async () => {
    // Both, because they are one fact: those tokens bought those messages. The
    // conversation used to survive a restart and the total did not, so a
    // figure that should only climb reset to zero every time.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-memory-')))
    const seen: string[][] = []
    const model = scripted(seen)
    const env = {
      AIDCREW_PROVIDER: 'openai-compat',
      AIDCREW_BASE_URL: `${model.url.origin}/v1`,
      AIDCREW_API_KEY: 'test',
      AIDCREW_MODEL: 'test-model',
    }
    const coder = {
      id: 'coder',
      description: 'writes code',
      systemPrompt: 'You write code.',
      provider: 'openai-compat',
      model: 'test-model',
    }

    try {
      const first = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env,
        agents: [coder],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {},
      })
      await first.tell('coder', 'remember the rotation bug')
      await first.idle()
      await first.shutdown()

      const spent = seen.length
      const second = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env,
        agents: [coder],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {},
      })

      // The total is back before it says anything, because it belongs to what
      // was already said rather than to what happens next.
      expect(second.snapshots()[0]?.usage.inputTokens).toBe(10)

      await second.tell('coder', 'and now?')
      await second.idle()
      const sent = seen[spent] ?? []
      // The new session's very first request already carries the old
      // conversation: without it the agent comes back not knowing it was
      // ever asked anything, which is what "it forgets what it was doing"
      // looked like from the outside.
      expect(sent.join(' ')).toContain('remember the rotation bug')
      expect(sent.join(' ')).toContain('noted')

      await second.shutdown()
    } finally {
      model.stop(true)
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('adding an agent while a session is up', () => {
  test('it joins the team rather than only appearing in the editor', async () => {
    // Writing its file and rereading the project changes what the team editor
    // shows and nothing else: the team running was built before the agent
    // existed, so there was no tab and no way to speak to it until a restart.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-join-')))
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'none',
        onChange: () => {},
      })

      expect(team.snapshots()).toHaveLength(0)

      await team.join({
        id: 'tester',
        description: 'writes tests',
        systemPrompt: 'You write tests.',
        provider: 'none',
        model: 'none',
      })

      expect(team.snapshots().map((agent) => agent.id)).toEqual(['tester'])
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('joining twice does not start it twice', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-join2-')))
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'none',
        onChange: () => {},
      })

      const agent = {
        id: 'tester',
        description: 'writes tests',
        systemPrompt: 'You write tests.',
        provider: 'none',
        model: 'none',
      }
      await team.join(agent)
      await team.join(agent)

      expect(team.snapshots()).toHaveLength(1)
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('an agent that runs its own tools', () => {
  test('what it did shows in its pane, not only what it concluded', () => {
    // Another coding program on the team reports its tool calls in the turn
    // rather than through ours. Left out, its pane showed conclusions and
    // never the work, and it read as though nothing was happening.
    const lines = toLines({
      type: 'agent_event',
      id: 'claude',
      event: {
        type: 'assistant_turn',
        turn: {
          content: [
            { type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'bun test' } },
            { type: 'text', text: 'All green.' },
          ],
          stopReason: 'end_turn',
          usage,
        },
      },
    })

    expect(lines).toEqual([
      { agentId: 'claude', kind: 'tool', text: 'Bash bun test' },
      { agentId: 'claude', kind: 'say', text: 'All green.' },
    ])
  })

  test('a call our own loop is about to run is not written down twice', () => {
    // The bug: an ordinary agent's tool call appears in the finished turn AND
    // arrives as tool_start when the loop runs it, so every call was listed
    // twice — which reads as the agent doing everything two times.
    //
    // `tool_use` as the stop reason is what separates the two: it means our
    // loop is about to run these, and tool_start will report each one. A
    // program that ran its own tools has already finished, and says so.
    const lines = toLines({
      type: 'agent_event',
      id: 'coder',
      event: {
        type: 'assistant_turn',
        turn: {
          content: [
            { type: 'tool_use', id: 'call_1', name: 'read', input: { path: 'a.ts' } },
            { type: 'text', text: 'Let me look.' },
          ],
          stopReason: 'tool_use',
          usage,
        },
      },
    })

    expect(lines).toEqual([{ agentId: 'coder', kind: 'say', text: 'Let me look.' }])
  })
})

describe('one agent handing work to another', () => {
  test('is written into both panes, from each side', () => {
    // Shown only to the receiver, a handoff was invisible unless you happened
    // to be looking at the agent it woke — so an agent could start spending on
    // work you never asked for, and the first you knew was the bill.
    const lines = toLines({
      type: 'agent_message',
      from: 'architect',
      to: 'coder',
      text: 'Implement the plan in PLAN.md\nwithout touching the tests.',
    })

    expect(lines).toEqual([
      { agentId: 'architect', kind: 'note', text: '→ coder: Implement the plan in PLAN.md' },
      {
        agentId: 'coder',
        kind: 'note',
        text: '← architect: Implement the plan in PLAN.md\nwithout touching the tests.',
      },
    ])
  })

  test('gives the sender the gist and the receiver the whole thing', () => {
    // The sender does not need to read back what it just wrote; the receiver
    // has to act on it.
    const long = `${'x'.repeat(200)}\nand more`
    const lines = toLines({ type: 'agent_message', from: 'a', to: 'b', text: long })

    expect((lines[0] as { text: string }).text.length).toBeLessThan(100)
    expect((lines[1] as { text: string }).text).toContain('and more')
  })
})

describe('adding somebody to a team that is already running', () => {
  function scripted() {
    return Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          [
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\n`,
            `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`,
            'data: [DONE]\n\n',
          ].join(''),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    })
  }

  const member = (id: string) => ({
    id,
    description: '',
    systemPrompt: '',
    provider: 'openai-compat',
    model: 'test-model',
  })

  test('the newcomer gets a key and turns up in the team', async () => {
    // The bug: keys were resolved once, for the team as it was at startup, so
    // an agent added afterwards had none. Spawning threw, the screen said
    // `void` to the promise, and the new agent simply never appeared — which
    // is what "I add it and cannot select it anywhere" looked like.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-join-')))
    const model = scripted()
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: {
          AIDCREW_BASE_URL: `${model.url.origin}/v1`,
          AIDCREW_API_KEY: 'test',
        },
        agents: [member('architect')],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {},
      })

      await team.join(member('plugin-writer'))
      expect(team.snapshots().map((one) => one.id)).toEqual(['architect', 'plugin-writer'])

      // And it can actually talk. Spawning is lazy about providers, so an
      // agent with no key joined perfectly happily and then failed on its
      // first turn — present in the list, useless in the session.
      await team.tell('plugin-writer', 'hello')
      await team.idle()
      expect(team.snapshots().find((one) => one.id === 'plugin-writer')?.turns).toBe(1)

      await team.shutdown()
    } finally {
      model.stop(true)
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('says which service the newcomer has no key for', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-join-nokey-')))
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: {},
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {},
      })

      // Refused here, where somebody is looking at the screen, rather than
      // silently later when the agent is asked to do something.
      await expect(team.join(member('plugin-writer'))).rejects.toThrow(/openai-compat/)
      expect(team.snapshots()).toEqual([])
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a team where somebody has no key', () => {
  test('the ones that can run do, and the screen says who cannot', async () => {
    // An agent with no key used to start anyway — the provider is only built
    // on the first turn — so it sat in the tab bar looking ready and failed
    // the moment it was asked anything. Better to say so before it is picked.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-nokey-')))
    try {
      const said: Line[] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY_OPENAI_COMPAT: 'test' },
        agents: [
          {
            id: 'architect',
            description: '',
            systemPrompt: '',
            provider: 'openai-compat',
            model: 'test-model',
          },
          {
            id: 'stranger',
            description: '',
            systemPrompt: '',
            provider: 'anthropic',
            model: 'test-model',
          },
        ],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
      })

      expect(team.snapshots().map((one) => one.id)).toEqual(['architect'])
      expect(said.some((line) => line.kind === 'error' && line.text.includes('stranger'))).toBe(
        true,
      )

      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('background work that goes wrong', () => {
  test('a failing sweep does not bring the session down', async () => {
    // The sweep runs on a timer and its result is dropped with `void`, so
    // anything it throws becomes an unhandled rejection — which in a compiled
    // binary prints a minified stack trace over the interface, every five
    // seconds, with nothing a person can do about it. It happened.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-sweep-')))
    // Expected here, so it is captured rather than printed: a test run that
    // prints a stack trace reads as a broken test run.
    const complained: unknown[] = []
    const said = console.error
    console.error = (...args: unknown[]) => complained.push(args)
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {
          throw new Error('the screen blew up')
        },
      })

      // onChange throwing is the worst case: it is called from inside the
      // sweep's own continuation, where nothing else would catch it.
      expect(await team.idle()).toBeUndefined()
      expect(complained.length).toBeGreaterThan(0)
      await team.shutdown()
    } finally {
      console.error = said
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a plugin that does not load', () => {
  test('the session says so, with the reason', async () => {
    // Otherwise it is invisible: you drop a plugin in, nothing happens, and
    // there is nowhere to find out why. The headless path printed this to
    // stderr from the start; the interface threw the whole list away.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-badplugin-')))
    try {
      mkdirSync(join(cwd, '.aidcrew', 'plugins', 'wrong'), { recursive: true })
      writeFileSync(
        join(cwd, '.aidcrew', 'plugins', 'wrong', 'index.ts'),
        'throw new Error("boom")',
      )

      const said: Line[] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [
          {
            id: 'architect',
            description: '',
            systemPrompt: '',
            provider: 'openai-compat',
            model: 'test-model',
          },
        ],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
      })

      const complaint = said.find((line) => line.kind === 'error' && line.text.includes('wrong'))
      expect(complaint?.text).toContain('boom')
      // Filed against a pane that exists, or nothing ever draws it.
      expect(complaint?.agentId).toBe('architect')
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a plugin edited while the session is running', () => {
  test('its new tool is there, without a restart', async () => {
    // The README has promised "no build step, no publishing, no restart"
    // since the first day, and the third was not true.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-hot-')))
    const dir = join(cwd, '.aidcrew', 'plugins', 'live')
    const tool = (name: string) => `import { definePlugin, defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
export default definePlugin({
  name: 'live',
  tools: [defineTool({
    name: '${name}',
    description: 'A tool for a test.',
    schema: z.object({}),
    run: async () => ({ content: '${name}' }),
  })],
})`

    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.ts'), tool('before'))

      const said: Line[] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
      })

      try {
        writeFileSync(join(dir, 'index.ts'), tool('after'))

        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          if (said.some((line) => line.text.includes('after'))) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }

        const told = said.find((line) => line.text.includes('plugins reloaded'))
        expect(told?.text).toContain('added after')
        expect(told?.text).toContain('dropped before')
      } finally {
        await team.shutdown()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20_000)

  test('is still handed its settings, which a reload used to take away', async () => {
    // A reload rebuilds the registry from scratch, so every plugin's `setup`
    // runs a second time — and it was given nothing to run with. Saving the
    // file you are working on is the moment a plugin silently reverts to its
    // defaults, which is the worst possible moment for it to happen.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-resettings-')))
    const dir = join(cwd, '.aidcrew', 'plugins', 'live')
    const reading = (tool: string) => `export default {
  name: 'live',
  setup: (host) => ({ tools: [{
    name: '${tool}',
    description: 'Says which team it was configured for.',
    inputSchema: { type: 'object' },
    execute: async () => ({ content: String(host.config?.team) }),
  }] }),
}`

    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'index.ts'), reading('team_one'))
      mkdirSync(join(cwd, '.aidcrew'), { recursive: true })
      writeFileSync(join(cwd, '.aidcrew', 'config.toml'), '[plugins.live]\nteam = "core"\n')

      const said: Line[] = []
      const runtime = await openRuntime(cwd, cwd)
      const team = await startTeam({
        runtime,
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
      })

      try {
        const first = await runtime.host.registry.tool('team_one')?.execute({}, context)
        expect(first?.content).toBe('core')

        writeFileSync(join(dir, 'index.ts'), reading('team_two'))

        const deadline = Date.now() + 8000
        while (Date.now() < deadline) {
          if (said.some((line) => line.text.includes('added team_two'))) break
          await new Promise((resolve) => setTimeout(resolve, 50))
        }

        const again = await runtime.host.registry.tool('team_two')?.execute({}, context)
        expect(again?.content).toBe('core')
      } finally {
        await team.shutdown()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  }, 20_000)
})

/** Writes a plugin where the session will look for one. */
function plant(cwd: string, name: string, source: string): void {
  const dir = join(cwd, '.aidcrew', 'plugins', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'index.ts'), source)
}

/** What a tool is given when it runs; none of these read any of it. */
const context = { cwd: '.', agentId: 'architect', signal: new AbortController().signal }

describe('a plugin that asks the person at the keyboard', () => {
  test('reaches the same prompt the guards do, and is told the answer', async () => {
    // The question is the reason `setup` is worth having: a plugin that acts
    // on your behalf should be able to ask first. Nothing in the interface
    // ever supplied one, so `host.ask` was undefined in every session that
    // has ever run and every such question answered itself no.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-ask-')))
    try {
      plant(
        cwd,
        'asker',
        `export default {
           name: 'asker',
           setup: (host) => ({ tools: [{
             name: 'proceed',
             description: 'Asks before it does anything.',
             inputSchema: { type: 'object' },
             execute: async () => ({
               content: (await host.ask?.({ title: 'Proceed?' })) === true ? 'yes' : 'no',
             }),
           }] }),
         }`,
      )

      const runtime = await openRuntime(cwd, cwd)
      const asked: string[] = []
      const team = await startTeam({
        runtime,
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {},
        onApproval: async (request) => {
          asked.push(request.summary)
          return 'once'
        },
      })

      try {
        const answered = await runtime.host.registry.tool('proceed')?.execute({}, context)
        expect(asked).toEqual(['Proceed?'])
        expect(answered?.content).toBe('yes')
      } finally {
        await team.shutdown()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('names a pane the interface can draw the question in', async () => {
    // The screen files a pending question against an agent and shows it in
    // that agent's pane only. A question filed under a name nobody on the
    // team has is a question no pane draws and no key can answer — and
    // because nothing answers it, the promise never settles and the turn that
    // asked hangs. Silence would have been the lesser bug.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-pane-')))
    try {
      plant(
        cwd,
        'asker',
        `export default {
           name: 'asker',
           setup: (host) => ({ tools: [{
             name: 'proceed',
             description: 'Asks before it does anything.',
             inputSchema: { type: 'object' },
             execute: async () => ({ content: String(await host.ask?.({ title: 'Proceed?' })) }),
           }] }),
         }`,
      )

      const runtime = await openRuntime(cwd, cwd)
      const architect = {
        id: 'architect',
        description: '',
        systemPrompt: '',
        provider: 'openai-compat',
        model: 'test-model',
      }
      const asked: string[] = []
      const team = await startTeam({
        runtime,
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [architect],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: () => {},
        onApproval: async (request) => {
          asked.push(request.agentId)
          return 'once'
        },
      })

      try {
        await runtime.host.registry.tool('proceed')?.execute({}, context)
        expect(asked).toEqual(['architect'])
      } finally {
        await team.shutdown()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('is answered no, out loud, when it asks before there is a screen', async () => {
    // `setup` runs while the host is being built, which is before any team
    // and any prompt. The answer can only be no, and a no nobody sees is the
    // defect this whole change exists to remove.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-early-')))
    try {
      plant(
        cwd,
        'eager',
        `export default {
           name: 'eager',
           setup: async (host) => {
             await host.ask?.({ title: 'Send the whole repository somewhere?' })
             return {}
           },
         }`,
      )

      const said: Line[] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
        onApproval: async () => 'once',
      })

      const told = said.find((line) => line.text.includes('Send the whole repository somewhere?'))
      expect(told?.kind).toBe('note')
      expect(told?.text).toContain('no')
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a plugin with something to say', () => {
  test('is heard, though it spoke before there was anywhere to draw it', async () => {
    // `setup` runs inside openRuntime, long before a screen exists, so a
    // `say` at that moment has nowhere to go. It is held and replayed beside
    // the load failures, which is where the interface already puts news it
    // could not show at the time.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-say-')))
    try {
      plant(
        cwd,
        'talker',
        `export default {
           name: 'talker',
           setup: (host) => {
             host.say?.('talker is using the token from your keychain')
             return {}
           },
         }`,
      )

      const said: Line[] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
      })

      const told = said.find((line) => line.text.includes('from your keychain'))
      expect(told?.kind).toBe('note')
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('is heard as it speaks once the session is up, not at the next reload', async () => {
    // A plugin keeps the host it was set up with and says things later, from
    // a tool. Buffering those until something else happens to drain the list
    // would deliver news about a call minutes after the call.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-say-live-')))
    try {
      plant(
        cwd,
        'reporter',
        `export default {
           name: 'reporter',
           setup: (host) => ({ tools: [{
             name: 'report',
             description: 'Says something while it works.',
             inputSchema: { type: 'object' },
             execute: async () => {
               host.say?.('reporter is halfway through')
               return { content: 'done' }
             },
           }] }),
         }`,
      )

      const runtime = await openRuntime(cwd, cwd)
      const said: Line[] = []
      const team = await startTeam({
        runtime,
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [],
        skills: [],
        defaultProvider: 'openai-compat',
        onChange: (lines) => said.splice(0, said.length, ...lines),
      })

      try {
        await runtime.host.registry.tool('report')?.execute({}, context)
        const told = said.find((line) => line.text.includes('halfway through'))
        expect(told?.kind).toBe('note')
      } finally {
        await team.shutdown()
      }
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a run with nobody watching', () => {
  test('leaves a plugin no way to ask, which is itself the answer', async () => {
    // The contract says `ask` is absent when nobody is watching, and an
    // unattended session must agree to nothing it was not already told.
    // Supplying one in the interface must not quietly supply one everywhere.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-headless-')))
    try {
      plant(
        cwd,
        'asker',
        `export default {
           name: 'asker',
           setup: (host) => ({ tools: [{
             name: 'whether',
             description: 'Reports whether it could ask.',
             inputSchema: { type: 'object' },
             execute: async () => ({ content: host.ask === undefined ? 'absent' : 'present' }),
           }] }),
         }`,
      )

      const host = await createHost({
        cwd,
        home: cwd,
        allowPlugin: () => true,
        setup: { configFor: () => ({}) },
      })

      const answered = await host.registry.tool('whether')?.execute({}, context)
      expect(answered?.content).toBe('absent')
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('a turn that ran out of room', () => {
  test("is an error line in that agent's pane, naming what never ran", async () => {
    // An error rather than a note, so the tab is marked and somebody looking
    // at another pane finds out. What makes it worth reading is the tool: "it
    // ran out of room" is a shrug, and "the write it had started never ran"
    // is something to act on.
    const lines = toLines({
      type: 'agent_cut_short',
      id: 'plugin-writer',
      reason: 'max_tokens',
      tool: 'write',
    })

    expect(lines).toHaveLength(1)
    expect(lines[0]?.agentId).toBe('plugin-writer')
    expect(lines[0]?.kind).toBe('error')
    expect(lines[0]?.text).toContain('write')
    expect(lines[0]?.text).toMatch(/ran out of room|never ran/)
  })

  test('says what it can when nothing was in flight', async () => {
    const lines = toLines({ type: 'agent_cut_short', id: 'coder', reason: 'max_tokens' })

    expect(lines[0]?.kind).toBe('error')
    expect(lines[0]?.text).not.toContain('undefined')
  })

  test('uses the words the single-agent path has always used for a turn limit', async () => {
    // There is no reason for the team path to invent a second wording for
    // something the headless one has printed since the beginning.
    const lines = toLines({ type: 'agent_cut_short', id: 'coder', reason: 'max_turns' })

    expect(lines[0]?.text).toMatch(/without finishing/)
  })
})

describe('telling somebody the team has stopped', () => {
  const agents = [
    { id: 'plugin-writer', lastText: 'I have the exact contract — now I build the plugin.' },
  ] as never as Parameters<typeof stallNotice>[1]

  const at = 1_700_000_000_000

  test('says who was waiting on whom, and how that turn ended', () => {
    // "Nothing is happening" is what the user could already see. What makes
    // this worth drawing over their screen is the rest of it — and the last
    // sentence especially, because the status row was showing that sentence
    // for three hours and forty minutes as though it were still true.
    const notice = stallNotice(
      [
        {
          from: 'architect',
          to: 'plugin-writer',
          text: 'Tool 1 of 3: outline. On your own, test first.',
          at,
          cutShort: 'max_tokens',
        },
      ],
      agents,
      at + 4 * 60_000,
    )

    expect(notice.title).toContain('nobody is working')
    expect(notice.detail[0]).toBe('architect → plugin-writer, 4 minutes ago')
    expect(notice.detail.join('\n')).toContain('ran out of room')
    expect(notice.detail.join('\n')).toContain('I have the exact contract')
  })

  test('says plainly when the recipient never started at all', () => {
    const notice = stallNotice(
      [{ from: 'architect', to: 'plugin-writer', text: 'build it', at }],
      agents,
      at + 1000,
    )

    expect(notice.detail.join('\n')).toContain('never took a turn')
  })

  test('counts the rest rather than listing them', () => {
    const notice = stallNotice(
      [
        { from: 'a', to: 'b', text: 'one', at },
        { from: 'c', to: 'd', text: 'two', at },
        { from: 'e', to: 'f', text: 'three', at },
      ],
      agents,
      at,
    )

    expect(notice.title).toContain('3 handoffs')
    expect(notice.detail.join('\n')).toContain('and 2 more')
  })

  test('offers what ends it rather than what hides it', () => {
    // It is drawn only while nothing is happening and goes the moment
    // something does. A key that merely hid it would be one people learn to
    // press, which is how the notice that mattered gets shut before it is
    // read.
    const notice = stallNotice([{ from: 'a', to: 'b', text: 'x', at }], agents, at)

    expect(notice.keys).toEqual([['↵', 'tell b to carry on']])
  })
})

/** One agent, for a test that only needs it to exist and have a name. */
const agent = (id: string) => ({
  id,
  description: `the ${id}`,
  systemPrompt: `You are ${id}.`,
  provider: 'openai-compat',
  model: 'test-model',
})

/**
 * What `/clear` clears.
 *
 * It threw away the model's conversation and left every line of it on the
 * screen, then added one more saying it had started again — so the thing that
 * visibly happened was the opposite of the thing named: the screen got longer.
 * Everywhere else the word empties what you are looking at.
 */
describe('starting a conversation again', () => {
  test('empties what is on screen for that agent', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-clear-')))
    try {
      const before = openJournal(cwd, cwd)
      before.append({ agentId: 'coder', kind: 'ask', text: 'fix the token' })
      before.append({ agentId: 'coder', kind: 'say', text: 'done that' })
      before.close()

      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      team.forget('coder')
      const now = handed[handed.length - 1] ?? []

      expect(now.map((line) => line.text)).not.toContain('fix the token')
      expect(now.map((line) => line.text)).not.toContain('done that')
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('says once that it started again, rather than saying nothing at all', async () => {
    // An empty pane with no explanation reads as a session that lost your
    // work. One line is the difference between cleared and broken.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-clear-note-')))
    try {
      const before = openJournal(cwd, cwd)
      before.append({ agentId: 'coder', kind: 'say', text: 'done that' })
      before.close()

      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      team.forget('coder')
      const now = handed[handed.length - 1] ?? []

      expect(now).toHaveLength(1)
      expect(now[0]).toMatchObject({ agentId: 'coder', kind: 'note' })
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('leaves everybody else on the screen', async () => {
    // Clearing is per agent, and a team of four sharing one screen would be
    // wiped by anybody typing it if it were not.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-clear-others-')))
    try {
      const before = openJournal(cwd, cwd)
      before.append({ agentId: 'coder', kind: 'say', text: 'mine' })
      before.append({ agentId: 'architect', kind: 'say', text: 'theirs' })
      before.close()

      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder'), agent('architect')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      team.forget('coder')
      const now = handed[handed.length - 1] ?? []

      expect(now.map((line) => line.text)).toContain('theirs')
      expect(now.map((line) => line.text)).not.toContain('mine')
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('does not bring them back when the session is reopened', async () => {
    // The transcript is on disk. Clearing the screen and not the file is a
    // session that comes back tomorrow with everything you cleared.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-clear-again-')))
    try {
      const before = openJournal(cwd, cwd)
      before.append({ agentId: 'coder', kind: 'say', text: 'done that' })
      before.close()

      const first = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: () => {},
      })
      first.forget('coder')
      await first.shutdown()

      const handed: Line[][] = []
      const second = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      expect((handed[0] ?? []).map((line) => line.text)).not.toContain('done that')
      await second.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * When the interface first hears about the team.
 *
 * Before it has been handed one. `startTeam` spawns the agents, and spawning
 * emits events, and events announce — so `onChange` runs while `startTeam` is
 * still running, which means the caller's own `const team = await startTeam()`
 * is not bound yet. A callback that reaches for it throws a ReferenceError on
 * every agent, and the interface did exactly that: five agents, five stack
 * traces down the terminal before the first frame.
 *
 * The contract is the thing to pin, because the fix in the caller is invisible
 * and reads like a stylistic choice a year from now.
 */
describe('when the interface is first told what changed', () => {
  test('is told before startTeam returns, so it cannot use what startTeam gives back', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-announce-')))
    try {
      let handedOver = false
      let toldBeforeHandover = false

      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: () => {
          if (!handedOver) toldBeforeHandover = true
        },
      })
      handedOver = true

      expect(toldBeforeHandover).toBe(true)
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('survives a callback that throws, rather than taking the session with it', async () => {
    // The guard that made this look like a warning instead of a crash. Worth
    // keeping and worth knowing about: it turned five ReferenceErrors into
    // five paragraphs of stack trace and a session that started anyway.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-announce-throw-')))
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: () => {
          throw new Error('the screen did not like that')
        },
      })

      expect(team.snapshots()).toHaveLength(1)
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * Opening a second project in one session.
 *
 * The compactor and the approval gate are built out of the team being started
 * — its agents, its models, its budgets — so `startTeam` registers them. The
 * registry belongs to the host, which outlives any one project, so the second
 * project registered the same two names again and was refused: "plugin
 * hooks-compact is already registered. Two directories hold a plugin of that
 * name, or the same directory is being read twice."
 *
 * None did. One session was registering one name twice, and the message sent
 * whoever read it looking for a duplicate directory that does not exist.
 */
describe('opening one project after another', () => {
  test('does not refuse the second for a plugin the first left behind', async () => {
    const first = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-one-')))
    const second = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-two-')))
    try {
      const runtime = await openRuntime(first, first)
      const open = (cwd: string) =>
        startTeam({
          runtime,
          cwd,
          env: { AIDCREW_API_KEY: 'test' },
          agents: [agent('coder')],
          skills: [],
          defaultProvider: 'none',
          onChange: () => {},
        })

      const a = await open(first)
      await a.shutdown()

      // This threw before, and the interface showed the throw instead of the
      // project.
      const b = await open(second)
      expect(b.snapshots()).toHaveLength(1)
      await b.shutdown()
    } finally {
      rmSync(first, { recursive: true, force: true })
      rmSync(second, { recursive: true, force: true })
    }
  })

  test('and the third, and the fourth', async () => {
    // Not a one-off swap: somebody moving between projects does it all day.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-again-')))
    try {
      const runtime = await openRuntime(cwd, cwd)
      for (let time = 0; time < 4; time++) {
        const team = await startTeam({
          runtime,
          cwd,
          env: { AIDCREW_API_KEY: 'test' },
          agents: [agent('coder')],
          skills: [],
          defaultProvider: 'none',
          onChange: () => {},
        })
        await team.shutdown()
      }

      // One of each, not four.
      const names = runtime.host.registry.plugins().map((one) => one.name)
      expect(names.filter((name) => name === 'hooks-compact')).toHaveLength(1)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * What is left of the plan, and whose plan it is.
 *
 * Asked for the whole team and answered by whichever provider replied first,
 * so a team on two services showed one figure and never said which of the two
 * it described. Worse, every provider was asked with the first agent's key —
 * so the answer could be the wrong account's, or no answer at all, depending
 * on the order the agents happened to be in.
 *
 * It is a property of an agent, because the plan belongs to the credential the
 * agent runs on.
 */
describe('what is left of the plan', () => {
  test('is asked for one agent, not for the team', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-allow-')))
    try {
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder'), agent('architect')],
        skills: [],
        defaultProvider: 'none',
        onChange: () => {},
      })

      // The shape is the point: an answer that cannot say whose plan it is
      // cannot be drawn beside one agent's name.
      expect(team.prices.allowance('coder')).toBeUndefined()
      expect(() => team.prices.allowance('nobody')).not.toThrow()
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * A line filed under a name that is not on the team is a line nothing draws.
 *
 * `/task other nosuchrole` recorded its error under `other`, which is no
 * agent: the pane showed "nothing started", the reason was nowhere, and the
 * tray counted one unseen notice that could never be seen.
 */
describe('a line about something that is not an agent', () => {
  test('is filed under an agent on the team, so it is drawn', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-filed-')))
    try {
      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      await team.startTask('other', ['nosuchrole'])

      const now = handed[handed.length - 1] ?? []
      const said = now.find((line) => line.text.includes('nosuchrole'))
      expect(said?.agentId).toBe('coder')
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})

/**
 * The same note, twice in a row.
 *
 * A note says something changed. Said again with nothing between, it says
 * nothing changed — and the transcript grows anyway, which is the one cost a
 * line that carries no news should not have. Turning three agents loose wrote
 * `unleashed` three times; the tab already says it, for as long as it is true.
 */
describe('a note that says what the one before it said', () => {
  test('is written once', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-dupe-')))
    try {
      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      team.setYolo('coder', true)
      team.setYolo('coder', true)
      team.setYolo('coder', true)

      const now = handed[handed.length - 1] ?? []
      expect(now.filter((line) => line.text === 'unleashed')).toHaveLength(1)
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })

  test('is written again once something else has happened', async () => {
    // Repetition is only noise when it is immediate. The same note after a
    // different one is a second event, and dropping it would hide it.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-dupe2-')))
    try {
      const handed: Line[][] = []
      const team = await startTeam({
        runtime: await openRuntime(cwd, cwd),
        cwd,
        env: { AIDCREW_API_KEY: 'test' },
        agents: [agent('coder')],
        skills: [],
        defaultProvider: 'none',
        onChange: (lines) => handed.push(lines),
      })

      team.setYolo('coder', true)
      team.setYolo('coder', false)
      team.setYolo('coder', true)

      const now = handed[handed.length - 1] ?? []
      expect(now.filter((line) => line.text === 'unleashed')).toHaveLength(2)
      await team.shutdown()
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
