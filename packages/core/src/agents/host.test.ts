import { describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Provider, Tool } from '../loop.ts'
import type { AgentDef } from '../sources/types.ts'
import type { Message, StreamDelta, Usage } from '../types.ts'
import type { AgentLine, ContentionRequest, HostOptions, TeamEvent } from './host.ts'
import { describeTeam, InProcessHost, ORCHESTRATION, teamBriefing } from './host.ts'

const usage = { inputTokens: 10, outputTokens: 5 }

function text(body: string): StreamDelta[] {
  return [
    { type: 'text_delta', text: body },
    { type: 'done', stopReason: 'end_turn', usage },
  ]
}

function call(id: string, name: string, args: unknown): StreamDelta[] {
  return [
    { type: 'tool_use_start', id, name },
    { type: 'tool_use_delta', id, partialInput: JSON.stringify(args) },
    { type: 'tool_use_end', id },
    { type: 'done', stopReason: 'tool_use', usage },
  ]
}

/** A provider whose scripted turns are chosen by the model name. */
function scripted(scripts: Record<string, StreamDelta[][]>): (model: string) => Provider {
  return (model) => ({
    id: 'scripted',
    async *send() {
      const turn = scripts[model]?.shift()
      for (const delta of turn ?? text('(nothing scripted)')) yield delta
    },
  })
}

const def = (id: string, model: string): AgentDef => ({
  id,
  description: `the ${id}`,
  systemPrompt: `You are ${id}.`,
  model,
})

function makeHost(
  scripts: Record<string, StreamDelta[][]>,
  options: {
    tools?: Tool[]
    limits?: ConstructorParameters<typeof InProcessHost>[0]['limits']
    onContention?: ConstructorParameters<typeof InProcessHost>[0]['onContention']
    sharedMemory?: boolean
    /** One agent's provider, by id, for a test that needs it to block. */
    providerFor?: Record<string, Provider>
    /** What an agent had already spent when the session was resumed. */
    usageFor?: ConstructorParameters<typeof InProcessHost>[0]['usageFor']
    /** What the project says about how its team works. */
    orchestration?: string
    onEvent?(event: TeamEvent): void
    leader?: string
    /** Told an agent's whole conversation and spend after every turn. */
    onHistory?: HostOptions['onHistory']
    /** What an agent has changed, as the host would read it off its worktree. */
    diffFor?: HostOptions['diffFor']
  } = {},
) {
  const events: TeamEvent[] = []
  const host = new InProcessHost({
    cwd: process.cwd(),
    providerFor: (agent) =>
      options.providerFor?.[agent.id] ?? scripted(scripts)(agent.model ?? 'default'),
    tools: options.tools ?? [],
    limits: options.limits ?? { maxHops: 3 },
    isolate: false,
    onEvent: (event) => {
      events.push(event)
      options.onEvent?.(event)
    },
    ...(options.onContention ? { onContention: options.onContention } : {}),
    ...(options.onHistory ? { onHistory: options.onHistory } : {}),
    ...(options.diffFor ? { diffFor: options.diffFor } : {}),
    ...(options.usageFor ? { usageFor: options.usageFor } : {}),
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    ...(options.leader ? { leader: options.leader } : {}),
    ...(options.sharedMemory ? { sharedMemory: true, maxTurnsPerInstruction: 40 } : {}),
  })
  return { host, events }
}

/** A provider that stops mid-stream until it is released. */
function gated(): { provider: Provider; entered: Promise<void>; release: () => void } {
  let enter = (): void => {}
  let go = (): void => {}
  const entered = new Promise<void>((resolve) => {
    enter = resolve
  })
  const release = new Promise<void>((resolve) => {
    go = resolve
  })
  return {
    entered,
    release: () => go(),
    provider: {
      id: 'gated',
      async *send() {
        yield { type: 'text_delta' as const, text: 'working' }
        enter()
        await release
        // Ends badly, so there is something left outstanding to find once
        // it is no longer busy. Busy is the whole predicate.
        yield { type: 'done' as const, stopReason: 'max_tokens' as const, usage }
      },
    },
  }
}

/** A provider that keeps every piece of text it is sent, and says it read it. */
function listening(seen: string[]): Provider {
  return {
    id: 'listening',
    async *send(request) {
      for (const message of request.messages) {
        for (const block of message.content) {
          if (block.type === 'text') seen.push(block.text)
        }
      }
      for (const delta of text('read it')) yield delta
    },
  }
}

/** A turn that ends cleanly having said nothing at all, which some models do. */
function silence(): StreamDelta[] {
  return [{ type: 'done', stopReason: 'end_turn', usage }]
}

/** A tool that does nothing, for a turn that has to go round the loop. */
const noop: Tool = {
  name: 'noop',
  description: 'does nothing',
  inputSchema: { type: 'object', properties: {} },
  execute: async () => ({ content: 'ok' }),
}

describe('spawning', () => {
  test('starts an agent idle, with its own model', async () => {
    const { host } = makeHost({})

    const snapshot = await host.spawn(def('coder', 'deepseek'))

    expect(snapshot).toMatchObject({ id: 'coder', status: 'idle', model: 'deepseek' })
    await host.shutdown()
  })

  test('lists every agent that is alive', async () => {
    const { host } = makeHost({})
    await host.spawn(def('a', 'm1'))
    await host.spawn(def('b', 'm2'))

    expect(
      host
        .list()
        .map((a) => a.id)
        .sort(),
    ).toEqual(['a', 'b'])
    await host.shutdown()
  })

  test('refuses to spawn the same agent twice', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))

    expect(host.spawn(def('coder', 'm'))).rejects.toThrow(/coder/)
    await host.shutdown()
  })

  test('gives different agents different models, which is the whole point', async () => {
    const { host } = makeHost({})
    await host.spawn(def('architect', 'opus'))
    await host.spawn(def('coder', 'deepseek'))

    expect(
      host
        .list()
        .map((a) => a.model)
        .sort(),
    ).toEqual(['deepseek', 'opus'])
    await host.shutdown()
  })
})

describe('working', () => {
  test('runs a turn when told to do something', async () => {
    const { host } = makeHost({ m: [text('done that')] })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'do a thing')
    await host.idle()

    expect(host.list()[0]).toMatchObject({ status: 'idle', lastText: 'done that' })
    await host.shutdown()
  })

  test('records what an agent spent', async () => {
    const { host } = makeHost({ m: [text('ok')] })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'go')
    await host.idle()

    // Plus the count of turns that spent tokens and said nothing about what
    // they cost, which is every turn on a plain endpoint and is what stops a
    // later stated figure from pricing these at zero.
    expect(host.list()[0]?.usage).toEqual({ ...usage, unstatedTurns: 1 })
    await host.shutdown()
  })

  test('keeps the conversation across two instructions', async () => {
    const { host } = makeHost({ m: [text('first'), text('second')] })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'one')
    await host.idle()
    await host.tell('coder', 'two')
    await host.idle()

    expect(host.list()[0]).toMatchObject({ lastText: 'second', turns: 2 })
    await host.shutdown()
  })

  test('reports an unknown agent rather than silently doing nothing', async () => {
    const { host } = makeHost({})

    expect(host.tell('ghost', 'hello')).rejects.toThrow(/ghost/)
    await host.shutdown()
  })

  test('runs two agents at the same time', async () => {
    const { host } = makeHost({ m1: [text('a done')], m2: [text('b done')] })
    await host.spawn(def('a', 'm1'))
    await host.spawn(def('b', 'm2'))

    await Promise.all([host.tell('a', 'go'), host.tell('b', 'go')])
    await host.idle()

    expect(
      host
        .list()
        .map((agent) => agent.lastText)
        .sort(),
    ).toEqual(['a done', 'b done'])
    await host.shutdown()
  })
})

describe('tasks, which are what a checkout belongs to', () => {
  test('agents on the same task share one workspace', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))
    await host.spawn(def('reviewer', 'm'))

    const [coder, reviewer] = host.list()
    // A team on one job works in one directory. The coder writing four files
    // and the reviewer finding nothing was the whole problem.
    expect(coder?.workspace).toBe(reviewer?.workspace as string)
    expect(coder?.task).toBe('main')
    await host.shutdown()
  })

  test('an agent says which task it is on', async () => {
    // Where the checkouts actually land is workspace.test.ts, which has a
    // repository to make them in.
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))
    await host.spawn({ ...def('auth-coder', 'm'), task: 'auth' })

    expect(
      host
        .list()
        .map((agent) => agent.task)
        .sort(),
    ).toEqual(['auth', 'main'])
    await host.shutdown()
  })

  test('killing one agent leaves the workspace its colleagues are using', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))
    await host.spawn(def('reviewer', 'm'))
    const shared = host.list()[0]?.workspace

    await host.kill('coder')

    // Removing the checkout out from under somebody still working in it would
    // destroy their work.
    expect(host.list()[0]?.workspace).toBe(shared as string)
    await host.shutdown()
  })
})

describe('what everyone on a task knows', () => {
  test('is not kept at all unless the project asked for it', async () => {
    // It puts a paragraph in front of every agent on the task, on every
    // request: worth it when a team is working something out together, pure
    // cost when one agent is doing a small job alone.
    const { host } = makeHost({
      m1: [call('t1', 'task_note', { text: 'a finding' }), text('tried')],
    })
    await host.spawn(def('architect', 'm1'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(host.sharedMemory('main').notes).toEqual([])
    await host.shutdown()
  })

  test('one agent writes it down and the next one is told', async () => {
    // Agents on a task share a checkout but not their reasoning: the reviewer
    // does not know why a shape was chosen and rediscovers it by reading code
    // and guessing, which costs a turn and produces a guess where the truth
    // was written down an hour earlier.
    const seen: string[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: (agent) =>
        agent.id === 'architect'
          ? scripted({
              m1: [
                call('t1', 'task_note', { text: 'the rotation lives in token.ts' }),
                text('noted'),
              ],
            })('m1')
          : {
              id: 'listening',
              async *send(request) {
                for (const message of request.messages) {
                  for (const block of message.content) {
                    if (block.type === 'text') seen.push(block.text)
                  }
                }
                for (const delta of text('understood')) yield delta
              },
            },
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      sharedMemory: true,
      onEvent: () => {},
    })

    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'm2'))
    await host.tell('architect', 'work it out')
    await host.idle()
    await host.tell('coder', 'now do it')
    await host.idle()

    const said = seen.join('\n')
    expect(said).toContain('the rotation lives in token.ts')
    // Said to be a colleague's note, not an instruction: an agent that reads
    // one as an order does what the note describes instead of what it was
    // asked.
    expect(said).toContain('not instructions from the user')
    await host.shutdown()
  })

  test('is not shared with a different task', async () => {
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: (agent) =>
        agent.id === 'architect'
          ? scripted({
              m1: [call('t1', 'task_note', { text: 'main task finding' }), text('noted')],
            })('m1')
          : scripted({ m2: [text('nothing to add')] })('m2'),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      sharedMemory: true,
      onEvent: () => {},
    })

    await host.spawn(def('architect', 'm1'))
    await host.spawn({ ...def('auth-coder', 'm2'), task: 'auth' })
    await host.tell('architect', 'go')
    await host.idle()

    // Two jobs running at once do not share what they have worked out, for
    // the same reason they do not share a checkout.
    expect(host.sharedMemory('main').notes).toHaveLength(1)
    expect(host.sharedMemory('auth').notes).toHaveLength(0)
    await host.shutdown()
  })

  test('appears once however many turns a conversation runs for', async () => {
    const sizes: number[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: (agent) =>
        agent.id === 'architect'
          ? scripted({ m1: [call('t1', 'task_note', { text: 'a finding' }), text('noted')] })('m1')
          : {
              id: 'counting',
              async *send(request) {
                sizes.push(
                  request.messages.filter((message) =>
                    message.content.some(
                      (block) => block.type === 'text' && block.text.includes('What the team'),
                    ),
                  ).length,
                )
                for (const delta of text('ok')) yield delta
              },
            },
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      sharedMemory: true,
      onEvent: () => {},
    })

    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'm2'))
    await host.tell('architect', 'go')
    await host.idle()
    for (const instruction of ['one', 'two', 'three']) {
      await host.tell('coder', instruction)
      await host.idle()
    }

    // Replaced each turn rather than appended: three turns must not mean three
    // copies of the same note in the same conversation.
    expect(sizes).toEqual([1, 1, 1])
    await host.shutdown()
  })

  test('sits beside the tool result mid-turn, which is where a provider will take it', async () => {
    // Put before the last message, always. In the middle of a turn the last
    // message is the one carrying the tool result, so the request became
    // assistant(tool_use) / user(note) / user(tool_result) — and every
    // provider refuses that shape: "tool_use ids were found without
    // tool_result blocks immediately after". Once any note existed, every
    // turn that used a tool failed at its second request.
    const seen: Message[][] = []
    let calls = 0
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'checking',
        async *send(request) {
          // Copied: the loop rewrites this array as the turn goes on.
          seen.push(structuredClone(request.messages))
          calls += 1
          for (const delta of calls === 1 ? call('t1', 'noop', {}) : text('done')) yield delta
        },
      }),
      tools: [noop],
      limits: { maxHops: 3 },
      isolate: false,
      sharedMemory: true,
      onEvent: () => {},
    })
    await host.spawn(def('coder', 'm'))
    await host.spawn(def('architect', 'm'))
    // A note from before this turn, the way a resumed session has one.
    host.internals.shared.write('main', {
      notes: [{ from: 'architect', text: 'the rotation lives in token.ts', at: 1 }],
    })

    await host.tell('coder', 'go')
    await host.idle()

    expect(seen).toHaveLength(2)
    for (const request of seen) {
      for (const [at, message] of request.entries()) {
        if (!message.content.some((block) => block.type === 'tool_use')) continue
        const next = request[at + 1]
        expect(next?.role).toBe('user')
        expect(next?.content[0]?.type).toBe('tool_result')
      }
    }
    // Still told, and still told once.
    const told = (seen[1] ?? []).flatMap((message) =>
      message.content.filter(
        (block) => block.type === 'text' && block.text.includes('the rotation lives'),
      ),
    )
    expect(told).toHaveLength(1)
    await host.shutdown()
  })
})

describe('turning the shared note on while the session runs', () => {
  test('takes effect on the next turn, not at the next start', async () => {
    // A setting somebody switches in order to see what it does has to do it
    // while they are looking.
    const { host } = makeHost({
      m: [call('t1', 'task_note', { text: 'first try' }), text('one'), text('two')],
    })
    await host.spawn(def('architect', 'm'))

    await host.tell('architect', 'go')
    await host.idle()
    expect(host.sharedMemory('main').notes).toEqual([])

    host.setSharedMemory(true)
    await host.tell('architect', 'again')
    await host.idle()

    // The tools an agent has are worked out at the start of every turn, so
    // the next one has it.
    expect(host.list()[0]?.turns).toBe(2)
    await host.shutdown()
  })
})

describe('when a task has written down too much', () => {
  test('the agent that tipped it over is the one that shortens it', async () => {
    // Not a timer and not the next reader: the cost belongs to the turn that
    // caused it, and a reader made to pause for somebody else's notes pauses
    // for no reason it can see.
    const asked: number[] = []
    const notes = Array.from({ length: 30 }, (_, at) =>
      call(`t${at}`, 'task_note', { text: `finding ${at}` }),
    )

    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => scripted({ m: [...notes, text('done')] })('m'),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      sharedMemory: true,
      maxTurnsPerInstruction: 40,
      summariseNotes: async (_task, older) => {
        asked.push(older.length)
        return 'the team worked out the guard shape'
      },
      onEvent: () => {},
    })

    await host.spawn(def('architect', 'm'))
    await host.tell('architect', 'go')
    await host.idle()

    const memory = host.sharedMemory('main')
    expect(asked.length).toBeGreaterThan(0)
    expect(memory.summary).toContain('guard shape')
    // Shortened rather than merely stopped: far fewer than the thirty that
    // were written, and it kept going afterwards rather than freezing.
    expect(memory.notes.length).toBeLessThan(20)
    expect(memory.notes.at(-1)?.text).toBe('finding 29')
    await host.shutdown()
  })

  test('keeps the notes as they are when nobody can summarise', async () => {
    // A worse shared note than a summarised one, and a better one than a note
    // nobody can afford to carry.
    const notes = Array.from({ length: 30 }, (_, at) =>
      call(`t${at}`, 'task_note', { text: `finding ${at}` }),
    )
    const { host } = makeHost({ m: [...notes, text('done')] }, { sharedMemory: true })
    await host.spawn(def('architect', 'm'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(host.sharedMemory('main').summary).toMatch(/earlier notes/)
    await host.shutdown()
  })
})

describe('what you type while an agent is working', () => {
  test('is carried out when the turn it interrupted is over', async () => {
    const { host } = makeHost({ m1: [text('first'), text('second')] })
    await host.spawn(def('coder', 'm1'))

    await host.tell('coder', 'one')
    // Sent without waiting, the way a person types while watching it work.
    await host.tell('coder', 'two')
    await host.idle()

    expect(host.list()[0]?.turns).toBe(2)
    expect(host.list()[0]?.lastText).toBe('second')
    await host.shutdown()
  })

  test('is never refused by a limit meant for agents talking in circles', async () => {
    // The limit exists to stop two agents answering each other forever. It
    // was stopping the person as well: past it, every instruction typed was
    // dropped in silence, and the agent looked broken rather than finished.
    const { host } = makeHost(
      { m1: Array.from({ length: 6 }, () => text('ok')) },
      { limits: { maxHops: 3, maxTurnsPerAgent: 2 } },
    )
    await host.spawn(def('coder', 'm1'))

    for (const instruction of ['one', 'two', 'three', 'four']) {
      await host.tell('coder', instruction)
      await host.idle()
    }

    expect(host.list()[0]?.turns).toBe(4)
    await host.shutdown()
  })

  test('reaches the agent mid-turn, not after everything it was already doing', async () => {
    // What a person expects when they type while watching it work: the next
    // thing it does takes the new instruction into account. Waiting for a
    // long turn to finish means watching an agent carry on down a path you
    // have already told it to abandon.
    const seen: string[][] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let first = true

    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'two-step',
        async *send(request) {
          seen.push(
            request.messages.flatMap((message) =>
              message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
            ),
          )
          if (first) {
            first = false
            // A turn that runs a tool, so the loop comes round again.
            yield { type: 'tool_use_start', id: 't1', name: 'wait' }
            yield { type: 'tool_use_delta', id: 't1', partialInput: '{}' }
            yield { type: 'tool_use_end', id: 't1' }
            yield { type: 'done', stopReason: 'tool_use', usage }
            return
          }
          for (const delta of text('done')) yield delta
        },
      }),
      tools: [
        {
          name: 'wait',
          description: 'waits',
          inputSchema: { type: 'object' },
          execute: async () => {
            await held
            return { content: 'waited' }
          },
        },
      ],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    await host.spawn(def('coder', 'any'))
    await host.tell('coder', 'the first job')
    await Bun.sleep(20)
    // Typed while the tool is still running.
    await host.tell('coder', 'actually, stop and do this instead')
    release()
    await host.idle()

    // The second request already carries it, rather than it waiting for a
    // turn of its own after this one finished.
    expect(seen[1]?.some((line) => line.includes('actually, stop'))).toBe(true)
    await host.shutdown()
  })

  test('is not lost when the turn ends before the model comes round again', async () => {
    // The interjection arrives after the last step of a turn that is already
    // finishing. Held rather than dropped: what somebody typed has to happen,
    // even when it missed its chance by a millisecond.
    const { host } = makeHost({ m1: [text('one'), text('two')] })
    await host.spawn(def('coder', 'm1'))

    await host.tell('coder', 'first')
    await host.idle()
    await host.tell('coder', 'second')
    await host.idle()

    expect(host.list()[0]?.turns).toBe(2)
    await host.shutdown()
  })

  test('is answered next, not appended to whatever is asked hours later', async () => {
    // Typed while the model was writing its last sentence, so no request of
    // this turn was left to carry it. It sat in the queue for the next turn's
    // first request — which came hours later, under an unrelated instruction,
    // with a question nobody remembered asking pasted onto the end of it.
    // Watched: "pwd? you should be in another folder" went unanswered.
    const seen: string[][] = []
    const slow = gated()
    const { host } = makeHost({}, { providerFor: { coder: slow.provider } })
    await host.spawn(def('coder', 'any'))

    await host.tell('coder', 'the first job')
    await slow.entered
    // Typed during the final response, which has no further request to join.
    await host.tell('coder', 'pwd? you should be in another folder')
    slow.release()
    await host.idle()

    expect(host.list()[0]?.turns).toBe(2)
    expect(host.list()[0]?.queued).toBe(0)
    void seen
    await host.shutdown()
  })

  test('is still carried out when the turn it interrupted fails', async () => {
    // Typed while the request was in flight, and the request came back a
    // 502. What was typed was promoted to the next turn only on the path
    // where this one succeeded, so it stayed held: the agent went idle with
    // one thing queued, and nothing was ever going to run it.
    const seen: string[][] = []
    let calls = 0
    let entered = (): void => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const failing: Provider = {
      id: 'failing-once',
      async *send(request) {
        calls += 1
        seen.push(
          request.messages.flatMap((message) =>
            message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
          ),
        )
        if (calls === 1) {
          entered()
          await held
          throw new Error('502 from the service')
        }
        for (const delta of text('ok')) yield delta
      },
    }
    const { host } = makeHost({}, { providerFor: { coder: failing } })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'the first job')
    await started
    await host.tell('coder', 'actually, stop and do this instead')
    release()
    await host.idle()

    expect(calls).toBe(2)
    expect(seen[1]?.some((line) => line.includes('actually, stop'))).toBe(true)
    expect(host.list()[0]?.queued).toBe(0)
    await host.shutdown()
  })

  test('still stops two agents from answering each other forever', async () => {
    const pingpong = (to: string) =>
      Array.from({ length: 20 }, () => call('t', 'agent_send', { to, message: 'again' }))

    const { host, events } = makeHost(
      { m1: pingpong('b'), m2: pingpong('a') },
      { limits: { maxHops: 10, maxTurnsPerAgent: 3 } },
    )
    await host.spawn(def('a', 'm1'))
    await host.spawn(def('b', 'm2'))

    await host.tell('a', 'start')
    await host.idle()

    expect(events.some((event) => event.type === 'agent_blocked')).toBe(true)
    await host.shutdown()
  })
})

describe('agents talking to each other', () => {
  test('delivers a message from one agent to another', async () => {
    const { host, events } = makeHost({
      m1: [call('t1', 'agent_send', { to: 'b', message: 'please review' }), text('sent')],
      m2: [text('reviewed')],
    })
    await host.spawn(def('a', 'm1'))
    await host.spawn(def('b', 'm2'))

    await host.tell('a', 'go')
    await host.idle()

    expect(events).toContainEqual({
      type: 'agent_message',
      from: 'a',
      to: 'b',
      text: 'please review',
    })
    expect(host.list().find((agent) => agent.id === 'b')?.lastText).toBe('reviewed')
    await host.shutdown()
  })

  /** What the coder changed, as the host would read it off its worktree. */
  const coderChanged = async (agentId: string) =>
    agentId === 'coder' ? 'diff --git a/ls.ts b/ls.ts\n+export const ls = 1\n' : ''

  test('carries what the sender has changed to a reader on another task', async () => {
    // What went wrong without it: a task works in its own worktree, so a
    // coder that has written four files hands over a sentence about them and
    // a reviewer on another job finds nothing. It then spends turns hunting,
    // and ends up reading absolute paths into another task's checkout
    // through bash — which works, wastes a turn each time, and defeats the
    // isolation. Injected diff, so the test needs no git.
    const seen: string[] = []
    const { host } = makeHost(
      {
        m1: [
          call('t1', 'agent_send', { to: 'reviewer', message: 'done, have a look' }),
          text('sent'),
        ],
      },
      { providerFor: { reviewer: listening(seen) }, diffFor: coderChanged },
    )

    await host.spawn(def('coder', 'm1'))
    await host.spawn({ ...def('reviewer', 'm2'), task: 'review' })
    await host.tell('coder', 'write it')
    await host.idle()

    const said = seen.join('\n')
    expect(said).toContain('done, have a look')
    // The work itself, not a pointer to a directory the reader cannot see.
    expect(said).toContain('+export const ls = 1')
    await host.shutdown()
  })

  test('says where the work is when the reader shares the checkout, and sends no diff', async () => {
    // A checkout is per task, not per agent, so a reviewer on the coder's
    // task is already standing in the directory the coder wrote into. The
    // diff went anyway — tens of kilobytes in the message, then in every
    // request of every turn after it — under a sentence saying "my worktree
    // is not yours", which for these two was simply false.
    const seen: string[] = []
    const { host } = makeHost(
      {
        m1: [
          call('t1', 'agent_send', { to: 'reviewer', message: 'done, have a look' }),
          text('sent'),
        ],
      },
      { providerFor: { reviewer: listening(seen) }, diffFor: coderChanged },
    )

    await host.spawn(def('coder', 'm1'))
    await host.spawn(def('reviewer', 'm2'))
    await host.tell('coder', 'write it')
    await host.idle()

    const said = seen.join('\n')
    const workspace = host.list().find((one) => one.id === 'coder')?.workspace ?? 'unknown'
    expect(said).toContain('done, have a look')
    expect(said).not.toContain('+export const ls = 1')
    expect(said).not.toContain('not yours')
    // Where to look, which is the one thing a colleague in the same directory needs.
    expect(said).toContain(workspace)
    await host.shutdown()
  })

  test('says nothing about the checkout when nothing was changed', async () => {
    const seen: string[] = []
    const { host } = makeHost(
      { m1: [call('t1', 'agent_send', { to: 'reviewer', message: 'a question' }), text('sent')] },
      { providerFor: { reviewer: listening(seen) }, diffFor: async () => '' },
    )

    await host.spawn(def('coder', 'm1'))
    await host.spawn(def('reviewer', 'm2'))
    await host.tell('coder', 'ask')
    await host.idle()

    expect(seen.join('\n')).toContain('a question')
    expect(seen.join('\n')).not.toMatch(/checkout|diff/)
    await host.shutdown()
  })

  test('tells the sender when the recipient does not exist', async () => {
    const { host } = makeHost({
      m1: [call('t1', 'agent_send', { to: 'nobody', message: 'hi' }), text('oh well')],
    })
    await host.spawn(def('a', 'm1'))

    await host.tell('a', 'go')
    await host.idle()

    expect(host.list()[0]?.lastText).toBe('oh well')
    await host.shutdown()
  })

  test('stops two agents that would talk in circles forever', async () => {
    // Both sides answer every message; without hop limits this never ends.
    const pingpong = (to: string) =>
      Array.from({ length: 20 }, () => call('t', 'agent_send', { to, message: 'again' }))

    const { host, events } = makeHost(
      { m1: pingpong('b'), m2: pingpong('a') },
      { limits: { maxHops: 3, maxMessagesPerTurn: 1 } },
    )
    await host.spawn(def('a', 'm1'))
    await host.spawn(def('b', 'm2'))

    await host.tell('a', 'start')
    await host.idle()

    expect(events.filter((e) => e.type === 'agent_message').length).toBeLessThanOrEqual(3)
    expect(events.some((e) => e.type === 'agent_blocked')).toBe(true)
    await host.shutdown()
  })
})

/**
 * A busy recipient is the normal case in a team, not the exception: work
 * arrives while work is happening. Queuing it silently is what a mailbox does
 * on its own, and it is often the wrong answer — so the person watching gets
 * asked, and told which way it went.
 */
describe('sending to an agent that is busy', () => {
  /** Holds a turn open so the next message provably lands on a busy agent. */
  function blocking(): { release: () => void; provider: Provider } {
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    return {
      release: () => release(),
      provider: {
        id: 'blocking',
        async *send() {
          await held
          yield { type: 'text_delta', text: 'finally' }
          yield { type: 'done', stopReason: 'end_turn', usage }
        },
      },
    }
  }

  function contendedHost(decide: HostOptions['onContention']) {
    const held = blocking()
    const events: TeamEvent[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      // Only the architect sends. Anyone else scripted to send would answer
      // the message it had just been handed by sending it straight back.
      providerFor: (agent) =>
        agent.id === 'architect'
          ? scripted({
              m1: [
                call('t1', 'agent_send', { to: 'coder', message: 'do the thing' }),
                text('sent'),
              ],
            })('m1')
          : agent.id === 'coder'
            ? held.provider
            : scripted({})('quiet'),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: (event) => events.push(event),
      ...(decide ? { onContention: decide } : {}),
    })
    return { host, events, release: held.release }
  }

  test('asks what to do, and says so when the answer is to wait', async () => {
    const asked: ContentionRequest[] = []
    const { host, release } = contendedHost(async (request) => {
      asked.push(request)
      return { at: 'queue' }
    })
    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'held'))

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    expect(asked).toMatchObject([{ from: 'architect', to: 'coder', text: 'do the thing' }])
    expect(host.list().find((a) => a.id === 'coder')?.queued).toBe(1)

    release()
    await host.idle()
    await host.shutdown()
  })

  test('starts a second one of the same kind when that is the answer', async () => {
    const { host, release } = contendedHost(async () => ({ at: 'spawn' }))
    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'held'))

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder', 'coder-2'] })

    expect(host.list().map((a) => a.id)).toContain('coder-2')
    // The one that was busy keeps only what it already had.
    expect(host.list().find((a) => a.id === 'coder')?.queued).toBe(0)

    release()
    await host.idle()
    await host.shutdown()
  })

  test('tells the sender when the answer is neither', async () => {
    const { host, release } = contendedHost(async () => ({ at: 'drop' }))
    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'held'))

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    expect(host.list().find((a) => a.id === 'coder')?.queued).toBe(0)
    expect(host.list().find((a) => a.id === 'architect')?.lastText).toBe('sent')

    release()
    await host.idle()
    await host.shutdown()
  })

  test('queues without asking when there is nobody to ask, and says so', async () => {
    const { host, events, release } = contendedHost(undefined)
    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'held'))

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    expect(host.list().find((a) => a.id === 'coder')?.queued).toBe(1)
    // Said in the transcript. A message that waits in silence is one whose
    // sender looks answered and whose recipient looks idle on the next job.
    expect(events).toContainEqual({
      type: 'agent_blocked',
      id: 'architect',
      reason: expect.stringMatching(/queued behind what coder is doing/),
    })

    release()
    await host.idle()
    await host.shutdown()
  })

  test('queues without asking when the sender is unleashed', async () => {
    // Asking suspends the sender's turn until somebody answers, and an
    // unleashed agent is one nobody is watching: the prompt sat on screen
    // all afternoon with the whole chain stopped behind it, which is the
    // opposite of what unleashing an agent is for.
    const asked: ContentionRequest[] = []
    const { host, events, release } = contendedHost(async (request) => {
      asked.push(request)
      return { at: 'queue' }
    })
    await host.spawn({ ...def('architect', 'm1'), yolo: true })
    await host.spawn(def('coder', 'held'))

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    expect(asked).toEqual([])
    expect(host.list().find((a) => a.id === 'coder')?.queued).toBe(1)
    expect(events).toContainEqual({
      type: 'agent_blocked',
      id: 'architect',
      reason: expect.stringMatching(/queued behind what coder is doing.*architect is unleashed/),
    })

    release()
    await host.idle()
    await host.shutdown()
  })

  test('queues without asking when the recipient is unleashed', async () => {
    const asked: ContentionRequest[] = []
    const { host, events, release } = contendedHost(async (request) => {
      asked.push(request)
      return { at: 'queue' }
    })
    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'held'))
    host.setYolo('coder', true)

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    expect(asked).toEqual([])
    expect(host.list().find((a) => a.id === 'coder')?.queued).toBe(1)
    expect(events).toContainEqual({
      type: 'agent_blocked',
      id: 'architect',
      reason: expect.stringMatching(/queued behind what coder is doing.*coder is unleashed/),
    })

    release()
    await host.idle()
    await host.shutdown()
  })

  test('an idle recipient is never worth asking about', async () => {
    const asked: ContentionRequest[] = []
    const { host, events } = makeHost(
      {
        m1: [call('t1', 'agent_send', { to: 'b', message: 'please review' }), text('sent')],
        m2: [text('reviewed')],
      },
      {
        onContention: async (request) => {
          asked.push(request)
          return { at: 'queue' }
        },
      },
    )
    await host.spawn(def('a', 'm1'))
    await host.spawn(def('b', 'm2'))

    await host.tell('a', 'go')
    await host.idle()

    expect(asked).toEqual([])
    expect(events.some((e) => e.type === 'agent_message' && e.to === 'b')).toBe(true)
    await host.shutdown()
  })

  test('hands the work to a free one of the same role instead of asking', async () => {
    const asked: ContentionRequest[] = []
    const { host, release, events } = contendedHost(async (request) => {
      asked.push(request)
      return { at: 'queue' }
    })
    await host.spawn(def('architect', 'm1'))
    await host.spawn(def('coder', 'held'))
    // A second coder, already on the team and doing nothing.
    await host.spawn({ ...def('coder-2', 'm2'), role: 'coder' })

    await host.tell('coder', 'first job')
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    // Nobody had to be asked: the team already had somebody free.
    expect(asked).toEqual([])
    expect(events).toContainEqual({
      type: 'agent_message',
      from: 'architect',
      to: 'coder-2',
      text: 'do the thing',
    })

    release()
    await host.idle()
    await host.shutdown()
  })

  test('a role can be addressed by name, without knowing who is on it', async () => {
    const { host, events } = makeHost({
      m1: [call('t1', 'agent_send', { to: 'reviewer', message: 'have a look' }), text('sent')],
      m2: [text('had a look')],
    })
    await host.spawn(def('a', 'm1'))
    // Named `bea`, but a reviewer, and the sender says what it needs done
    // rather than who does it.
    await host.spawn({ ...def('bea', 'm2'), role: 'reviewer' })

    await host.tell('a', 'go')
    await host.idle()

    expect(events).toContainEqual({
      type: 'agent_message',
      from: 'a',
      to: 'bea',
      text: 'have a look',
    })
    await host.shutdown()
  })

  test('a role never resolves to the agent that is sending', async () => {
    // coder-2 outlived coder: on the coder role, and the only one on it. It
    // sent to "coder", the role resolved to itself, and it spent the next
    // turn answering "[from coder-2] …" — its own message, handed back to it
    // as new work. The rule against sending to yourself was checked against
    // the name as written, before the name had been resolved to anybody.
    const { host, events } = makeHost({
      m: [
        call('t1', 'agent_send', { to: 'coder', message: 'coder, please take over' }),
        text('nobody else to hand it to'),
      ],
    })
    await host.spawn({ ...def('coder-2', 'm'), role: 'coder' })

    await host.tell('coder-2', 'go')
    await host.idle()

    expect(events.filter((event) => event.type === 'agent_message')).toEqual([])
    expect(host.list()[0]).toMatchObject({ turns: 1, lastText: 'nobody else to hand it to' })
    // And the sender is told why, in the words the rule uses.
    const sent = await host.relay({ from: 'coder-2', to: 'coder', text: 'again', hops: 1 })
    expect(sent).toMatchObject({ delivered: false, reason: expect.stringMatching(/itself/) })
    await host.shutdown()
  })

  test('a second of a role is one of that role too', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))
    const second = await host.duplicate('coder')

    expect(host.list().find((a) => a.id === second)?.role).toBe('coder')
    await host.shutdown()
  })

  test('names the second one after the first, and the third after that', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))

    expect(await host.duplicate('coder')).toBe('coder-2')
    expect(await host.duplicate('coder')).toBe('coder-3')
    // A copy of a copy is still a copy of the original, not `coder-2-2`.
    expect(await host.duplicate('coder-2')).toBe('coder-4')
    await host.shutdown()
  })
})

describe('when a provider fails', () => {
  test('reports the failure instead of leaving the agent working forever', async () => {
    // Without this the exception escapes the pump, the agent is stuck at
    // "working" for the rest of the session, and the only sign of it is a
    // stack trace printed over whatever interface is running.
    const events: TeamEvent[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'broken',
        // Yields nothing on purpose: this is a provider that fails before it
        // has said anything, which is what the test is about.
        // biome-ignore lint/correctness/useYield: throwing is the whole behaviour
        async *send() {
          throw new Error('zen returned 402: no credit')
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: (event) => events.push(event),
    })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(host.list()[0]?.status).toBe('idle')
    const failure = events.find((event) => event.type === 'agent_failed')
    expect(failure).toMatchObject({ id: 'coder' })
    expect((failure as { reason: string }).reason).toMatch(/no credit/)
    await host.shutdown()
  })

  test('keeps taking instructions after a failure', async () => {
    let failing = true
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'flaky',
        async *send() {
          if (failing) throw new Error('temporary')
          yield { type: 'text_delta', text: 'recovered' } as StreamDelta
          yield { type: 'done', stopReason: 'end_turn', usage } as StreamDelta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'first')
    await host.idle()
    failing = false
    await host.tell('coder', 'second')
    await host.idle()

    expect(host.list()[0]?.lastText).toBe('recovered')
    await host.shutdown()
  })

  test('charges what was spent before the failure, so the budget still holds', async () => {
    // Three turns of a hundred thousand tokens each, then a 502. The loop
    // kept its running total in the result it never got to return, so an
    // agent that had just spent half again its budget was written down as
    // having spent nothing — and was let through to spend more.
    let calls = 0
    const persisted: Usage[] = []
    const heavy: Provider = {
      id: 'heavy',
      async *send() {
        calls += 1
        if (calls > 3) throw new Error('502 from the service')
        yield { type: 'tool_use_start', id: `t${calls}`, name: 'noop' }
        yield { type: 'tool_use_end', id: `t${calls}` }
        yield {
          type: 'done',
          stopReason: 'tool_use',
          usage: { inputTokens: 100_000, outputTokens: 5_000 },
        }
      },
    }
    const { host, events } = makeHost(
      {},
      {
        providerFor: { coder: heavy },
        tools: [noop],
        limits: { maxHops: 3, maxTokensPerAgent: 200_000 },
        onHistory: (_id, _messages, spent) => persisted.push(spent),
      },
    )
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(host.list()[0]).toMatchObject({
      turns: 1,
      usage: { inputTokens: 300_000, outputTokens: 15_000 },
    })
    expect(host.internals.governor.spentBy('coder')).toBe(315_000)
    expect(persisted.at(-1)).toMatchObject({ inputTokens: 300_000, outputTokens: 15_000 })
    // Still a failure, and still said to be one.
    expect(events.some((event) => event.type === 'agent_failed')).toBe(true)

    // Over budget, so the next instruction is refused rather than run.
    await host.tell('coder', 'again')
    await host.idle()
    expect(events.some((event) => event.type === 'agent_blocked')).toBe(true)
    expect(calls).toBe(4)
    await host.shutdown()
  })
})

describe('limits', () => {
  test('stops an agent that has spent its budget', async () => {
    const { host, events } = makeHost(
      { m: [text('one'), text('two')] },
      { limits: { maxHops: 3, maxTokensPerAgent: 10 } },
    )
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'first')
    await host.idle()
    await host.tell('coder', 'second')
    await host.idle()

    expect(host.list()[0]?.turns).toBe(1)
    expect(events.some((e) => e.type === 'agent_blocked')).toBe(true)
    await host.shutdown()
  })

  // The budget is a statement about money, so it has to count money. Each
  // scripted turn costs 15 tokens and the budget is four of them: an agent cut
  // off at three has been charged for turns it never took, and the failure is
  // the one the token budget was introduced to replace — stopping in the
  // middle of the work rather than at the end of the money.
  test('an agent whose budget covers four turns is allowed all four', async () => {
    const { host } = makeHost(
      { m: [text('one'), text('two'), text('three'), text('four')] },
      { limits: { maxHops: 3, maxTokensPerAgent: 60 } },
    )
    await host.spawn(def('coder', 'm'))

    for (const say of ['first', 'second', 'third', 'fourth']) {
      await host.tell('coder', say)
      await host.idle()
    }

    expect(host.list()[0]?.turns).toBe(4)
    expect(host.list()[0]?.usage).toMatchObject({ inputTokens: 40, outputTokens: 20 })
    await host.shutdown()
  })

  test('a resumed agent is not charged again for the session it is resuming', async () => {
    // usageFor seeds an agent with what it spent before. Charging the governor
    // the running total spends that history over again on every turn, so the
    // third of these turns is the one that goes missing.
    const { host } = makeHost(
      { m: [text('one'), text('two'), text('three')] },
      {
        limits: { maxHops: 3, maxTokensPerAgent: 100 },
        usageFor: () => ({ inputTokens: 20, outputTokens: 10 }),
      },
    )
    await host.spawn(def('coder', 'm'))

    for (const say of ['first', 'second', 'third']) {
      await host.tell('coder', say)
      await host.idle()
    }

    expect(host.list()[0]?.turns).toBe(3)
    await host.shutdown()
  })
})

/**
 * What the per-turn send allowance counts.
 *
 * It bounds how wide one turn's conversation gets, which is the agent's own
 * doing. Two things were being charged to it that are not: the closing reply
 * the harness sends on the agent's behalf, and attempts that delivered nothing.
 */
describe('the send allowance', () => {
  test('is not charged for the closing reply the harness sends', async () => {
    // Watched: an agent that had used its three sends fanning work out had
    // its own report refused as a fourth — "already sent 3 messages this
    // turn" — and was blamed in the transcript for the harness's message.
    const { host, events } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'coder', message: 'build it' }), text('handed on')],
        work: [call('s2', 'agent_send', { to: 'tester', message: 'check it' }), text('built')],
        check: [text('all pass')],
      },
      { limits: { maxHops: 3, maxMessagesPerTurn: 1 } },
    )
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))
    await host.spawn(def('tester', 'check'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(events).toContainEqual({
      type: 'agent_message',
      from: 'coder',
      to: 'architect',
      text: 'built',
    })
    expect(events.filter((event) => event.type === 'agent_blocked')).toEqual([])
    await host.shutdown()
  })

  test('counts what was delivered, not what was attempted', async () => {
    // A typo in a name is answered with "no agent named", which is fine; it
    // was also costing one of the three sends, so the corrected message
    // could be the one refused.
    const { host, events } = makeHost(
      {
        m1: [
          call('t1', 'agent_send', { to: 'reveiwer', message: 'have a look' }),
          call('t2', 'agent_send', { to: 'reviewer', message: 'have a look' }),
          text('sent'),
        ],
        m2: [text('looked')],
      },
      { limits: { maxHops: 3, maxMessagesPerTurn: 1 } },
    )
    await host.spawn(def('coder', 'm1'))
    await host.spawn(def('reviewer', 'm2'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(events).toContainEqual({
      type: 'agent_message',
      from: 'coder',
      to: 'reviewer',
      text: 'have a look',
    })
    await host.shutdown()
  })
})

describe('stopping', () => {
  test('kills an agent and removes it from the list', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'm'))

    await host.kill('coder')

    expect(host.list()).toEqual([])
    await host.shutdown()
  })

  test('shutdown stops everyone', async () => {
    const { host } = makeHost({})
    await host.spawn(def('a', 'm'))
    await host.spawn(def('b', 'm'))

    await host.shutdown()

    expect(host.list()).toEqual([])
  })
})

describe('resuming a conversation', () => {
  test('an agent picks up what it had already said', async () => {
    // Without this, reopening a project introduces you to an agent that has
    // been working with you for an hour.
    const seen: Message[][] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'watching',
        async *send(request) {
          // Copied: the host replaces the contents of this array when the turn
          // ends, so holding the reference would show the state afterwards.
          seen.push([...request.messages])
          for (const delta of text('go on then')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
      historyFor: () => [{ role: 'user', content: [{ type: 'text', text: 'remember this' }] }],
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'and now this')
    await host.idle()
    await host.shutdown()

    expect(seen[0]?.map((message) => message.content)).toEqual([
      [{ type: 'text', text: 'remember this' }],
      [{ type: 'text', text: 'and now this' }],
    ])
  })

  test('hands back the whole conversation after every instruction', async () => {
    // The whole thing, not the new part: the loop rewrites what it holds, so
    // the state it ended in is the only one worth keeping.
    const kept: { agentId: string; count: number }[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'brief',
        async *send() {
          for (const delta of text('done')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
      onHistory: (agentId, messages) => kept.push({ agentId, count: messages.length }),
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'first')
    await host.idle()
    await host.tell('coder', 'second')
    await host.idle()
    await host.shutdown()

    expect(kept).toEqual([
      { agentId: 'coder', count: 2 },
      { agentId: 'coder', count: 4 },
    ])
  })

  test('keeps what was said even when the turn fails', async () => {
    // The failure this exists to prevent: an agent that worked for an hour and
    // ended on a provider error had nothing written down, so reopening the
    // session found it with no idea what it had been doing. What was said
    // before the failure is exactly what makes the next attempt possible.
    const kept: { agentId: string; count: number }[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'broken',
        async *send() {
          // The yield is unreachable and the linter is right to notice; a
          // generator that only throws is still the shape a provider has.
          if (Math.max(0, 1) === 0) yield { type: 'text_delta', text: '' }
          throw new Error('the service is down')
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
      onHistory: (agentId, messages) => kept.push({ agentId, count: messages.length }),
    })

    await host.spawn(def('coder', 'any'))
    await host.tell('coder', 'do the thing')
    await host.idle()
    await host.shutdown()

    // The instruction itself, at the very least: without it the agent comes
    // back not knowing it was ever asked.
    expect(kept.at(-1)).toMatchObject({ agentId: 'coder', count: 1 })
  })

  test('keeps what was said when the turn is cancelled halfway', async () => {
    const kept: { agentId: string; count: number }[] = []
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'slow',
        async *send() {
          yield { type: 'text_delta', text: 'thinking' }
          await held
          for (const delta of text('done')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
      onHistory: (agentId, messages) => kept.push({ agentId, count: messages.length }),
    })

    await host.spawn(def('coder', 'any'))
    await host.tell('coder', 'a long job')
    // Cancelled the way esc cancels it, mid-turn.
    await Bun.sleep(10)
    host.cancel('coder')
    release()
    await host.idle()
    await host.shutdown()

    expect(kept.length).toBeGreaterThan(0)
  })

  test('a conversation with a call nobody answered is repaired, not replayed', async () => {
    // The failure this prevents: one tool call left open by an interrupted
    // turn makes every later request fail — "No tool output found for
    // function call" — so the agent can never speak again, and the thing it
    // cannot get past is in its own history.
    const sent: Message[][] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'checking',
        async *send(request) {
          sent.push(request.messages)
          for (const delta of text('ok')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
      historyFor: () => [
        { role: 'user', content: [{ type: 'text', text: 'write it' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write', input: {} }] },
      ],
    })

    await host.spawn(def('coder', 'any'))
    await host.tell('coder', 'carry on')
    await host.idle()

    const results = (sent[0] ?? []).flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_result'),
    )
    expect(results).toHaveLength(1)
    await host.shutdown()
  })

  test('never writes down a conversation with a call left open', async () => {
    const kept: Message[][] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'stops-midway',
        async *send() {
          // Asks for a tool and the turn ends there, which is what an
          // interrupted turn looks like from the conversation's side.
          yield { type: 'tool_use_start', id: 'c9', name: 'write' }
          yield { type: 'tool_use_delta', id: 'c9', partialInput: '{}' }
          yield { type: 'tool_use_end', id: 'c9' }
          yield { type: 'done', stopReason: 'tool_use', usage }
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      maxTurnsPerInstruction: 1,
      onEvent: () => {},
      onHistory: (_id, messages) => kept.push(messages),
    })

    await host.spawn(def('coder', 'any'))
    await host.tell('coder', 'go')
    await host.idle()

    const written = kept.at(-1) ?? []
    const called = written.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_use'),
    )
    const results = written.flatMap((message) =>
      message.content.filter((block) => block.type === 'tool_result'),
    )
    expect(results.length).toBe(called.length)
    await host.shutdown()
  })

  test('starts clean when nothing was kept', async () => {
    const seen: Message[][] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'watching',
        async *send(request) {
          seen.push([...request.messages])
          for (const delta of text('hello')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'hello')
    await host.idle()
    await host.shutdown()

    expect(seen[0]).toHaveLength(1)
  })
})

describe('instructions sent while an agent is busy', () => {
  test('all reach the model, whether as their own turn or inside this one', async () => {
    const seen: string[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'slow',
        async *send(request) {
          for (const message of request.messages) {
            for (const block of message.content) {
              if (block.type === 'text') seen.push(block.text)
            }
          }
          for (const delta of text('done')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    await host.spawn(def('coder', 'any'))
    await host.tell('coder', 'first')
    await host.tell('coder', 'second')
    await host.tell('coder', 'third')
    await host.idle()
    await host.shutdown()

    // Typed while it was working, so the later two reach the turn already
    // running rather than waiting for turns of their own — which is the point
    // of them: you type while watching precisely because you want the next
    // thing it does to change. What matters is that none of the three is lost.
    const said = seen.join(' ')
    for (const instruction of ['first', 'second', 'third']) {
      expect(said).toContain(instruction)
    }
  })

  test('what is waiting is counted, so the interface can say so', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'held',
        async *send() {
          await held
          for (const delta of text('done')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'running')
    await host.tell('coder', 'waiting')
    await host.tell('coder', 'also waiting')

    expect(host.list()[0]?.queued).toBe(2)

    release()
    await host.idle()
    await host.shutdown()
  })

  test('what is waiting can be dropped without disturbing the turn in progress', async () => {
    // "Actually, not that" is the common case, and the alternative was killing
    // the agent — which throws away the work in progress too.
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const seen: string[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'held',
        async *send(request) {
          for (const message of request.messages) {
            for (const block of message.content) {
              if (block.type === 'text') seen.push(block.text)
            }
          }
          await held
          for (const delta of text('done')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'running')
    await host.tell('coder', 'never mind this')

    expect(host.clearQueue('coder')).toBe(1)

    release()
    await host.idle()
    await host.shutdown()

    expect(seen).toEqual(['running'])
  })

  test('dropping nothing reports nothing dropped', () => {
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({ id: 'x', async *send() {} }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })
    host.spawn(def('coder', 'any'))

    expect(host.clearQueue('coder')).toBe(0)
    expect(host.clearQueue('nobody')).toBe(0)
  })
})

describe('stopping a turn that has run away', () => {
  test('the agent stops working and stays standing', async () => {
    // Different from killing it: the worktree stays, the conversation stays,
    // and it can be told something else. A model looping should cost the turn,
    // not the agent and everything it had already done.
    let entered = (): void => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'held',
        async *send(_request, signal) {
          entered()
          // Waits for the abort and then ends the turn properly, the way a
          // provider that notices its request was cancelled would.
          await new Promise((resolve) => signal.addEventListener('abort', resolve))
          for (const delta of text('(stopped)')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'something long')
    await started

    expect(host.cancel('coder')).toBe(true)
    await host.idle()

    expect(host.list().map((agent) => agent.id)).toEqual(['coder'])
    await host.shutdown()
  })

  test('drops what was queued behind it too', async () => {
    // Whatever made you stop this turn almost certainly applies to the
    // instruction waiting behind it.
    let entered = (): void => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const seen: string[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'held',
        async *send(request, signal) {
          for (const message of request.messages) {
            for (const block of message.content) {
              if (block.type === 'text') seen.push(block.text)
            }
          }
          entered()
          await new Promise((resolve) => signal.addEventListener('abort', resolve))
          for (const delta of text('(stopped)')) yield delta
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'first')
    await host.tell('coder', 'second')
    await started

    host.cancel('coder')
    await host.idle()
    await host.shutdown()

    expect(seen).toEqual(['first'])
  })

  test('is not a failure when the request throws on the abort, and keeps what it spent', async () => {
    // What fetch() does when its signal fires is throw an AbortError, and
    // that is how the escape key reaches the loop from a real provider. The
    // host assumed a quiet 'aborted' stop instead: the screen said
    // "agent_failed: The operation was aborted." about something the person
    // had just done on purpose, and the two requests that had completed
    // before the key were written down as free.
    let calls = 0
    let entered = (): void => {}
    const started = new Promise<void>((resolve) => {
      entered = resolve
    })
    const aborting: Provider = {
      id: 'aborting',
      async *send(_request, signal) {
        calls += 1
        if (calls <= 2) {
          yield { type: 'tool_use_start', id: `t${calls}`, name: 'noop' }
          yield { type: 'tool_use_end', id: `t${calls}` }
          yield {
            type: 'done',
            stopReason: 'tool_use',
            usage: { inputTokens: 50_000, outputTokens: 2_000 },
          }
          return
        }
        entered()
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new DOMException('The operation was aborted.', 'AbortError')),
          )
        })
      },
    }
    const { host, events } = makeHost({}, { providerFor: { coder: aborting }, tools: [noop] })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'something long')
    await started
    host.cancel('coder')
    await host.idle()

    expect(events.filter((event) => event.type === 'agent_failed')).toEqual([])
    expect(host.list()[0]).toMatchObject({
      status: 'idle',
      turns: 1,
      usage: { inputTokens: 100_000, outputTokens: 4_000 },
    })
    expect(host.internals.governor.spentBy('coder')).toBe(104_000)
    await host.shutdown()
  })

  test('says there was nothing to stop when the agent is idle', () => {
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({ id: 'x', async *send() {} }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })
    host.spawn(def('coder', 'any'))

    expect(host.cancel('coder')).toBe(false)
    expect(host.cancel('nobody')).toBe(false)
  })
})

describe('what an agent has spent', () => {
  test('counts the cached halves as well as the plain ones', async () => {
    // Dropped, an agent's total disagreed with the same sum inside the loop —
    // and cost is worked out from these numbers, so a bill would have been
    // quietly short by whatever the cache saved.
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'cached',
        async *send() {
          yield { type: 'text_delta', text: 'ok' }
          yield {
            type: 'done',
            stopReason: 'end_turn',
            usage: {
              inputTokens: 10,
              outputTokens: 5,
              cacheReadTokens: 900,
              cacheWriteTokens: 100,
            },
          }
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'go')
    await host.idle()

    // Read before shutting down, which takes the agents with it.
    expect(host.list()[0]?.usage).toMatchObject({
      inputTokens: 10,
      cacheReadTokens: 900,
      cacheWriteTokens: 100,
    })
    await host.shutdown()
  })

  test('adds up what the providers said each turn cost', async () => {
    // Two turns, because one would pass whether the figure was summed or
    // simply the last one seen.
    let turn = 0
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'stating',
        async *send() {
          turn += 1
          yield { type: 'text_delta', text: 'ok' }
          yield {
            type: 'done',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1, listedUsd: turn === 1 ? 0.1 : 0.2 },
          }
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'go')
    await host.idle()
    await host.tell('coder', 'again')
    await host.idle()

    expect(host.list()[0]?.usage.listedUsd).toBeCloseTo(0.3, 10)
    await host.shutdown()
  })

  test('says nothing about money when no provider stated any', async () => {
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({
        id: 'quiet',
        async *send() {
          yield { type: 'done', stopReason: 'end_turn', usage }
        },
      }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })

    host.spawn(def('coder', 'any'))
    await host.tell('coder', 'go')
    await host.idle()

    expect(host.list()[0]?.usage.listedUsd).toBeUndefined()
    expect(host.list()[0]?.usage.chargedUsd).toBeUndefined()
    await host.shutdown()
  })
})

describe('an agent whose copy of the repository has aged', () => {
  test('carries how far behind it is, so it can be seen without asking', async () => {
    // It grows while the agent does nothing: every commit made outside leaves
    // every idle agent one further back, and one that looks idle and current
    // is the one that answers confidently about code that has changed.
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: () => ({ id: 'x', async *send() {} }),
      tools: [],
      limits: { maxHops: 3 },
      isolate: false,
      onEvent: () => {},
    })
    host.spawn(def('coder', 'any'))

    await host.sweep()

    expect(host.list()[0]?.behind).toBe(0)
    await host.shutdown()
  })
})

describe('plugins changing while the team is running', () => {
  test('the next turn has the new tools', async () => {
    // The README has promised "no restart" since the beginning. An agent's
    // tools are worked out at the start of every turn, so the only thing
    // missing was somewhere to put the new ones.
    const asked: string[][] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      tools: [],
      limits: { maxTokensPerAgent: 100_000, maxHops: 5 },
      isolate: false,
      onEvent: () => {},
      providerFor: () => ({
        id: 'scripted',
        async *send(request) {
          asked.push((request.tools ?? []).map((tool) => tool.name))
          yield { type: 'text_delta', text: 'ok' }
          yield {
            type: 'done',
            stopReason: 'end_turn',
            usage: { inputTokens: 1, outputTokens: 1 },
          }
        },
      }),
    })

    await host.spawn({ id: 'coder', description: '', systemPrompt: '' })
    await host.tell('coder', 'first')
    await host.idle()

    host.setTools([
      {
        name: 'brand-new',
        description: 'Appeared without a restart.',
        inputSchema: { type: 'object' },
        execute: async () => ({ content: '' }),
      },
    ])

    await host.tell('coder', 'second')
    await host.idle()

    expect(asked[0]).not.toContain('brand-new')
    expect(asked[1]).toContain('brand-new')
    await host.shutdown()
  })
})

describe('a turn that did not finish', () => {
  test('says so, naming the tool that never ran', async () => {
    // Taken from a real session: an agent asked to write three files was cut
    // off by the output cap partway through the third `write`, so the call
    // arrived with an empty input and was never executed. The loop knew — it
    // returned `max_tokens` — and this host read the messages, the usage and
    // the last text off the result and never looked at the stop reason. The
    // team then sat still for three hours and forty minutes with nothing on
    // screen saying why, while the status row showed the agent's last
    // sentence, which was that it was about to build the plugin.
    const { host, events } = makeHost({
      cut: [
        [
          { type: 'tool_use_start', id: 'w1', name: 'write' },
          { type: 'done', stopReason: 'max_tokens', usage },
        ],
      ],
    })
    await host.spawn(def('writer', 'cut'))

    await host.tell('writer', 'write the three files')
    await host.idle()

    expect(events).toContainEqual({
      type: 'agent_cut_short',
      id: 'writer',
      reason: 'max_tokens',
      tool: 'write',
    })
    await host.shutdown()
  })

  test('says nothing about a turn that simply ended', async () => {
    const { host, events } = makeHost({ fine: [text('done')] })
    await host.spawn(def('writer', 'fine'))

    await host.tell('writer', 'say something')
    await host.idle()

    expect(events.filter((event) => event.type === 'agent_cut_short')).toEqual([])
    await host.shutdown()
  })

  test('says so when the cap landed in the middle of the arguments', async () => {
    // The call arrives with half its JSON. That is the output cap, not a
    // provider speaking the protocol wrongly — but it was rejected as one:
    // the loop threw, the sentence before the call was never saved, and the
    // screen said "sent arguments that are not valid JSON" where it should
    // have named the write that never ran.
    const { host, events } = makeHost({
      cut: [
        [
          { type: 'text_delta', text: 'Writing the file now.' },
          { type: 'tool_use_start', id: 'w1', name: 'write' },
          { type: 'tool_use_delta', id: 'w1', partialInput: '{"path":"a.ts","content":"export ' },
          { type: 'tool_use_end', id: 'w1' },
          { type: 'done', stopReason: 'max_tokens', usage },
        ],
      ],
    })
    await host.spawn(def('writer', 'cut'))

    await host.tell('writer', 'write the file')
    await host.idle()

    expect(events).toContainEqual({
      type: 'agent_cut_short',
      id: 'writer',
      reason: 'max_tokens',
      tool: 'write',
    })
    expect(events.filter((event) => event.type === 'agent_failed')).toEqual([])
    expect(host.list()[0]?.lastText).toBe('Writing the file now.')
    await host.shutdown()
  })
})

describe('work handed over and not come back', () => {
  test('is still outstanding when the team goes quiet', async () => {
    const { host } = makeHost({
      lead: [call('s1', 'agent_send', { to: 'writer', message: 'build it' }), text('handed over')],
      cut: [
        [
          { type: 'tool_use_start', id: 'w1', name: 'write' },
          { type: 'done', stopReason: 'max_tokens', usage },
        ],
      ],
    })
    await host.spawn(def('lead', 'lead'))
    await host.spawn(def('writer', 'cut'))

    await host.tell('lead', 'get the first tool built')
    await host.idle()

    expect(host.stalled()).toMatchObject([{ from: 'lead', to: 'writer', cutShort: 'max_tokens' }])
    await host.shutdown()
  })

  test('says nothing when the team simply finished', async () => {
    const { host } = makeHost({
      lead: [call('s1', 'agent_send', { to: 'writer', message: 'build it' }), text('handed over')],
      done: [text('built it')],
    })
    await host.spawn(def('lead', 'lead'))
    await host.spawn(def('writer', 'done'))

    await host.tell('lead', 'get the first tool built')
    await host.idle()

    expect(host.stalled()).toBeUndefined()
    await host.shutdown()
  })

  test('says nothing while somebody is still working', async () => {
    // The test that decides whether this survives contact with a four-minute
    // `bun test`. The only difference between the two assertions is that the
    // agent stopped — same clock, same ledger. A predicate written on elapsed
    // silence, on a status timestamp or on queue depth fails the first one,
    // and a notice that fires while somebody is thinking is one people switch
    // off before it is ever right.
    const slow = gated()
    const { host } = makeHost(
      {
        lead: [
          call('s1', 'agent_send', { to: 'writer', message: 'build it' }),
          text('handed over'),
        ],
      },
      { providerFor: { writer: slow.provider } },
    )
    await host.spawn(def('lead', 'lead'))
    await host.spawn(def('writer', 'slow'))

    const running = host.tell('lead', 'get the first tool built')
    await slow.entered

    expect(host.stalled()).toBeUndefined()

    slow.release()
    await running
    await host.idle()

    expect(host.stalled()).toMatchObject([{ from: 'lead', to: 'writer' }])
    await host.shutdown()
  })

  test('says nothing before anybody has been told anything', async () => {
    // The two most ordinary moments in the product — a fresh start and a
    // resumed session — must both be silent. Every agent is born idle with an
    // empty mailbox, so a detector on idleness alone fires at both.
    const { host } = makeHost({})
    await host.spawn(def('lead', 'lead'))
    await host.spawn(def('writer', 'writer'))

    expect(host.stalled()).toBeUndefined()
    await host.shutdown()
  })

  test('says nothing about an agent somebody stopped by hand', async () => {
    const { host } = makeHost({
      lead: [call('s1', 'agent_send', { to: 'writer', message: 'build it' }), text('handed over')],
      cut: [
        [
          { type: 'tool_use_start', id: 'w1', name: 'write' },
          { type: 'done', stopReason: 'max_tokens', usage },
        ],
      ],
    })
    await host.spawn(def('lead', 'lead'))
    await host.spawn(def('writer', 'cut'))
    await host.tell('lead', 'get the first tool built')
    await host.idle()

    host.clearQueue('writer')
    await host.tell('writer', 'never mind, do it yourself')
    await host.idle()

    expect(host.stalled()).toBeUndefined()
    await host.shutdown()
  })
})

describe('starting an agent over', () => {
  test('forgets what it has said, and keeps what it has spent', async () => {
    // A conversation is sent again in full on every turn, so a long one costs
    // money for as long as it lives. Shortening it is what compaction does;
    // this is the other thing somebody wants, which is to begin again — and
    // there was no way to do it at all.
    //
    // The spending stays: those tokens were bought and the bill does not
    // reset because you changed the subject.
    const { host } = makeHost({ m: [text('the first thing'), text('the second')] })
    await host.spawn(def('coder', 'm'))
    await host.tell('coder', 'say something')
    await host.idle()

    const spent = host.list()[0]?.usage.inputTokens
    expect(host.forget('coder')).toBe(true)

    await host.tell('coder', 'say something else')
    await host.idle()
    expect(host.list()[0]?.usage.inputTokens).toBeGreaterThan(spent ?? 0)
    await host.shutdown()
  })

  test('says so when there is no such agent', async () => {
    const { host } = makeHost({})

    expect(host.forget('nobody')).toBe(false)
    await host.shutdown()
  })

  test('refuses while the agent is in the middle of a turn', async () => {
    // Emptying the messages under a running loop would hand the provider a
    // conversation with a tool call whose result has just been thrown away,
    // which providers reject outright.
    const slow = gated()
    const { host } = makeHost({}, { providerFor: { coder: slow.provider } })
    await host.spawn(def('coder', 'slow'))

    const running = host.tell('coder', 'work on it')
    await slow.entered

    expect(host.forget('coder')).toBe(false)

    slow.release()
    await running
    await host.shutdown()
  })
})

describe('knowing who else is on the team', () => {
  test('the tool that talks to them says who they are', async () => {
    // The description said "send a message to another agent by name" and the
    // names appeared nowhere. A parameter that is a name nothing lists is a
    // name to be guessed at — which is why the instruction had to say who to
    // hand the work to, when the harness is the thing that knows.
    const seen: Tool[] = []
    const { host } = makeHost(
      { m: [text('done')] },
      {
        tools: [
          {
            name: 'noop',
            description: 'does nothing',
            inputSchema: { type: 'object' },
            execute: async () => ({ content: '' }),
          },
        ],
      },
    )
    await host.spawn({ ...def('architect', 'm'), description: 'plans the work' })
    await host.spawn({ ...def('coder', 'm'), description: 'writes the code' })
    await host.spawn(def('reviewer', 'm'))

    // The tools an agent is given are built per turn, so they are read from a
    // turn rather than from the host.
    const original = host.internals.options.onEvent
    host.internals.options.onEvent = (event) => {
      if (event.type === 'agent_event' && event.event.type === 'turn_start') seen.push()
      original(event)
    }
    await host.tell('architect', 'go')
    await host.idle()

    const description = describeTeam(
      [
        { id: 'architect', description: 'plans the work' },
        { id: 'coder', description: 'writes the code' },
        { id: 'reviewer', description: '' },
      ],
      'architect',
    )

    // Everybody but the sender, each with what they are for.
    expect(description).toContain('coder')
    expect(description).toContain('writes the code')
    expect(description).toContain('reviewer')
    expect(description).not.toMatch(/\barchitect\b/)
    await host.shutdown()
  })

  test('says plainly when there is nobody else', async () => {
    // An agent alone must not be told to hand work to a list of nobody.
    expect(describeTeam([{ id: 'coder', description: 'writes' }], 'coder')).toContain('nobody else')
  })

  test('says who is busy and who is free, when it knows', () => {
    // A model choosing between two coders sees only their names and picks
    // the first, which is mid-turn, while the second sits idle. The choice
    // was invisible to it and to the transcript both.
    const line = describeTeam(
      [
        { id: 'coder', description: 'writes the code', busy: true },
        { id: 'coder-2', description: 'writes the code', busy: false },
        { id: 'tester', busy: false },
      ],
      'architect',
    )

    expect(line).toContain('coder (writes the code) [busy]')
    expect(line).toContain('coder-2 (writes the code) [free]')
    expect(line).toContain('tester [free]')
  })

  /** A team where the coder is provably mid-turn when the architect speaks. */
  async function withCoderBusy(seen: { systems: string[]; tools: string[] }) {
    const slow = gated()
    const { host } = makeHost(
      { m: [text('ok')] },
      {
        providerFor: {
          coder: slow.provider,
          architect: {
            id: 'noting',
            async *send(request) {
              seen.systems.push(request.system)
              seen.tools.push(
                request.tools.find((tool) => tool.name === 'agent_send')?.description ?? '',
              )
              for (const delta of text('noted')) yield delta
            },
          },
        },
      },
    )
    await host.spawn(def('architect', 'm'))
    await host.spawn(def('coder', 'm'))
    await host.spawn(def('reviewer', 'm'))

    await host.tell('coder', 'a long job')
    await slow.entered
    await host.tell('architect', 'go')
    await host.idle({ except: ['coder'] })

    slow.release()
    await host.idle()
    await host.shutdown()
  }

  test('the tool an agent is handed says which colleagues are mid-turn right now', async () => {
    const seen = { systems: [] as string[], tools: [] as string[] }
    await withCoderBusy(seen)

    expect(seen.tools[0]).toMatch(/coder \(the coder\) \[busy\]/)
    expect(seen.tools[0]).toMatch(/reviewer \(the reviewer\) \[free\]/)
  })

  test('the system prompt does not say it, so a cached prefix survives a colleague finishing', async () => {
    // The tool description is built per turn anyway. The system prompt is
    // what a provider caches across turns, and it changes only when the team
    // does: a colleague going idle must not invalidate it.
    const seen = { systems: [] as string[], tools: [] as string[] }
    await withCoderBusy(seen)

    expect(seen.systems[0]).toContain('coder')
    expect(seen.systems[0]).not.toMatch(/\[busy\]|\[free\]/)
  })
})

/**
 * What an agent is told about the situation it is in, as opposed to the job.
 *
 * An agent's own file says what it is for. It cannot say who else is here,
 * because that is decided when the session opens and changes while it runs —
 * so until this existed, an agent's only clue that it was on a team at all
 * was the description of the tool for talking to one.
 */
describe('the briefing an agent gets for being on a team', () => {
  const team = [
    { id: 'architect', description: 'plans the work' },
    { id: 'coder', description: 'writes the code' },
    { id: 'tester', description: 'proves it works' },
  ]

  test('says nothing at all to an agent working alone', () => {
    // A single agent told to hand work to a list of nobody spends turns
    // looking for somebody to hand it to.
    expect(teamBriefing({ agents: [team[0] as AgentLine], from: 'architect' })).toBeUndefined()
  })

  test('names everybody else and what they are for', () => {
    const briefing = teamBriefing({ agents: team, from: 'architect' }) ?? ''

    expect(briefing).toContain('coder')
    expect(briefing).toContain('writes the code')
    expect(briefing).toContain('tester')
  })

  test('does not offer the agent itself as somebody to hand work to', () => {
    const briefing = teamBriefing({ agents: team, from: 'coder' }) ?? ''

    // Named once, as the reader. Never in the roster: the governor refuses a
    // message an agent sends to itself, so listing it is offering a mistake.
    expect(briefing).toContain('architect')
    expect(briefing).toContain('tester')
    expect(briefing.split('coder').length - 1).toBeLessThanOrEqual(1)
  })

  test('tells it to carry on rather than end the turn asking', () => {
    // This is the whole point. Left to itself a model finishes by asking
    // whether it should proceed, and there is nobody there to answer — so the
    // work stops on a question addressed to an empty room.
    const briefing = teamBriefing({ agents: team, from: 'architect' }) ?? ''

    expect(briefing).toMatch(/nobody is watching|no one is watching/i)
    expect(briefing).toMatch(/agent_send/)
  })

  test('says that finishing means checked rather than written', () => {
    const briefing = teamBriefing({ agents: team, from: 'coder' }) ?? ''

    expect(briefing).toMatch(/test/i)
  })

  test('mentions the shared note only when the team is keeping one', () => {
    const withNotes = teamBriefing({ agents: team, from: 'coder', sharedMemory: true }) ?? ''
    const without = teamBriefing({ agents: team, from: 'coder' }) ?? ''

    // A tool an agent cannot call is a tool it will call anyway and be refused.
    expect(withNotes).toContain('task_note')
    expect(without).not.toContain('task_note')
  })

  test('stays short, because it is sent on every request of every turn', () => {
    const briefing = teamBriefing({ agents: team, from: 'coder', sharedMemory: true }) ?? ''

    // Not a style rule. This rides along with the system prompt on every
    // request each agent makes, so a paragraph nobody needed is a bill.
    expect(briefing.split(/\s+/).length).toBeLessThan(320)
  })
})

describe('a project that says how its own team should work', () => {
  const team = [
    { id: 'architect', description: 'plans the work' },
    { id: 'coder', description: 'writes the code' },
  ]

  test('uses what ORCHESTRATE.md says instead of the built-in wording', () => {
    const briefing =
      teamBriefing({ agents: team, from: 'coder', instructions: 'Ship on Fridays only.' }) ?? ''

    expect(briefing).toContain('Ship on Fridays only.')
    expect(briefing).not.toContain('Nobody is watching')
  })

  test('still supplies the roster, which is the half a file cannot know', () => {
    // Who is on the team is decided when the session opens and changes while
    // it runs, so an edited file must not be able to leave an agent without it.
    const briefing =
      teamBriefing({ agents: team, from: 'coder', instructions: 'Ship on Fridays only.' }) ?? ''

    expect(briefing).toContain('architect')
    expect(briefing).toContain('plans the work')
  })

  test('falls back to the built-in wording when the file is there but empty', () => {
    const briefing = teamBriefing({ agents: team, from: 'coder', instructions: '   \n  ' }) ?? ''

    expect(briefing).toContain('Nobody is watching')
  })

  test('the file it writes for somebody to edit is the wording it would have used', () => {
    // Otherwise `aidcrew orchestrate` hands over a file that changes the
    // behaviour merely by existing, which is the worst kind of default.
    const builtIn = teamBriefing({ agents: team, from: 'coder' }) ?? ''

    expect(builtIn).toContain(ORCHESTRATION.trim())
  })
})

describe('what the model is actually sent about its team', () => {
  /** A provider that keeps the system prompt of every request it is given. */
  function watching(systems: string[]) {
    return {
      id: 'watching',
      async *send(request: { system: string }) {
        systems.push(request.system)
        yield { type: 'text_delta' as const, text: 'ok' }
        yield { type: 'done' as const, stopReason: 'end_turn' as const, usage }
      },
    }
  }

  test('an agent on a team is told it is on one, and who else is here', async () => {
    // The point of the whole thing: until this, an agent's only clue that it
    // was not alone was the description of the tool for talking to somebody.
    const systems: string[] = []
    const { host } = makeHost({}, { providerFor: { architect: watching(systems) } })
    await host.spawn({ ...def('architect', 'm'), description: 'plans the work' })
    await host.spawn({ ...def('coder', 'm'), description: 'writes the code' })

    await host.tell('architect', 'go')
    await host.idle()

    expect(systems[0]).toContain('You are architect.')
    expect(systems[0]).toContain('coder')
    expect(systems[0]).toContain('writes the code')
    expect(systems[0]).toContain('Nobody is watching')
    await host.shutdown()
  })

  test('an agent working alone is sent its own file and nothing else', async () => {
    // A single agent told to hand its work to nobody spends turns looking for
    // somebody to hand it to, and pays for the paragraph that said so.
    const systems: string[] = []
    const { host } = makeHost({}, { providerFor: { coder: watching(systems) } })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(systems[0]).toBe('You are coder.')
    await host.shutdown()
  })

  test('somebody spawned mid-session is on the roster at the next turn', async () => {
    // Rebuilt per turn rather than at spawn, so a team that grows does not
    // need a restart before anybody can be handed anything.
    const systems: string[] = []
    const { host } = makeHost({}, { providerFor: { architect: watching(systems) } })
    await host.spawn(def('architect', 'm'))
    await host.tell('architect', 'first')
    await host.idle()

    await host.spawn({ ...def('tester', 'm'), description: 'proves it works' })
    await host.tell('architect', 'second')
    await host.idle()

    expect(systems[0]).not.toContain('tester')
    expect(systems[1]).toContain('proves it works')
    await host.shutdown()
  })

  test('what the project wrote in ORCHESTRATE.md is what the agents are told', async () => {
    const systems: string[] = []
    const { host } = makeHost(
      {},
      {
        providerFor: { architect: watching(systems) },
        orchestration: 'Work in pairs. Nothing lands without a second name on it.',
      },
    )
    await host.spawn(def('architect', 'm'))
    await host.spawn(def('coder', 'm'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(systems[0]).toContain('Nothing lands without a second name on it.')
    expect(systems[0]).toContain('coder')
    expect(systems[0]).not.toContain('Nobody is watching')
    await host.shutdown()
  })
})

/**
 * What happens to a handoff nobody answers.
 *
 * The ledger settled a handoff whenever the recipient's turn ended cleanly,
 * on the reasoning that "a turn that ends cleanly is an answer: the recipient
 * did the work and said so". It does not follow. An agent can finish its work,
 * say so to nobody, and stop — and then the agent that handed it over is
 * waiting for a message that will never arrive, with no turn in which to
 * notice. Observed, not imagined: a three-agent chain ended with the middle
 * agent writing "Verification passed" into its own transcript and the first
 * agent never learning the job was done.
 */
describe('a handoff that is finished but not answered', () => {
  /** A provider that does what the script says and reports nothing back. */
  function silent(turns: StreamDelta[][]) {
    return {
      id: 'silent',
      async *send() {
        for (const delta of turns.shift() ?? text('(nothing scripted)')) yield delta
      },
    }
  }

  test('is not settled by a turn that finished without answering', async () => {
    // The rule this changed, asked of the ledger directly. Constructing a
    // stranded chain through the agents is now genuinely hard — handing work
    // onward settles what was handed to you, and the far end reports to the
    // owner — which is the point. What has to stay true underneath is that
    // finishing and answering are different things.
    const slow = gated()
    const { host } = makeHost({}, { providerFor: { coder: slow.provider } })
    await host.spawn(def('architect', 'm'))
    await host.spawn(def('coder', 'm'))

    await host.relay({ from: 'architect', to: 'coder', text: 'do it', hops: 1 })
    expect(host.outstanding()).toHaveLength(1)

    host.turnEnded('coder', 'end_turn', false)
    expect(host.outstanding()).toHaveLength(1)

    host.turnEnded('coder', 'end_turn', true)
    expect(host.outstanding()).toEqual([])

    slow.release()
    await host.shutdown()
  })

  test('comes back to whoever asked, so they get a turn to act on it', async () => {
    // The fix that matters. A request with no reply is a protocol failure and
    // not a diligence failure, so the harness closes the loop rather than
    // asking a model to remember to.
    const { host } = makeHost({
      plan: [call('s1', 'agent_send', { to: 'coder', message: 'do it' }), text('handed over')],
      work: [text('the cap now applies before the discount')],
    })
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(host.list().find((one) => one.id === 'architect')?.turns).toBeGreaterThan(1)
    await host.shutdown()
  })

  test('carries what the agent actually said, addressed to whoever asked', async () => {
    const messages: { from: string; to: string; text: string }[] = []
    const { host } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'coder', message: 'do it' }), text('handed over')],
        work: [text('the cap now applies before the discount')],
      },
      {
        onEvent: (event) => {
          if (event.type === 'agent_message') {
            messages.push({ from: event.from, to: event.to, text: event.text })
          }
        },
      },
    )
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))

    await host.tell('architect', 'go')
    await host.idle()

    const back = messages.find((one) => one.from === 'coder' && one.to === 'architect')
    expect(back?.text).toContain('the cap now applies before the discount')
    await host.shutdown()
  })

  test('says nothing back when the agent already answered', async () => {
    // Otherwise every reply arrives twice, and the second one is the harness
    // talking over the agent it is meant to be carrying.
    const { host } = makeHost({
      plan: [call('s1', 'agent_send', { to: 'coder', message: 'do it' }), text('handed over')],
      work: [call('s2', 'agent_send', { to: 'architect', message: 'done' }), text('replied')],
    })
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(host.outstanding().filter((one) => one.from === 'architect')).toHaveLength(0)
    await host.shutdown()
  })

  test('says nothing back to the person, who is reading the screen', async () => {
    // The loop is closed between agents. A turn the user started ends by
    // being on the screen, and a reply addressed to nobody is a turn spent
    // talking to a transcript.
    const { host } = makeHost({ m: [text('done')] })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(host.list()[0]?.turns).toBe(1)
    await host.shutdown()
  })

  /** Two files' worth of change, as a diff the host would read off a worktree. */
  const twoFiles = 'diff --git a/a.ts b/a.ts\n+1\ndiff --git a/b.ts b/b.ts\n+2\n'

  test('reports back for an agent whose turn ended with no closing message', async () => {
    // Some models end a turn straight after a tool call with nothing said:
    // the tool ran, the next response was an empty message with end_turn,
    // and there was no closing sentence to relay. Nothing went back, the
    // ledger stayed open, and the leader sat waiting on an answer that had
    // in every sense but the words already arrived.
    const messages: { from: string; to: string; text: string }[] = []
    const { host } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'coder', message: 'do it' }), text('handed over')],
        work: [
          [{ type: 'text_delta', text: 'running the tests' }, ...call('t1', 'noop', {})],
          silence(),
        ],
      },
      {
        tools: [noop],
        diffFor: async (id) => (id === 'coder' ? twoFiles : ''),
        onEvent: (event) => {
          if (event.type === 'agent_message') {
            messages.push({ from: event.from, to: event.to, text: event.text })
          }
        },
      },
    )
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))

    await host.tell('architect', 'go')
    await host.idle()

    const back = messages.find((one) => one.from === 'coder' && one.to === 'architect')
    expect(back?.text).toMatch(/without a closing message/)
    // What it did say, and what it did, are the report.
    expect(back?.text).toContain('running the tests')
    expect(back?.text).toContain('2 files')
    // And said to be the harness's words, not the coder's.
    expect(back?.text).toMatch(/harness/)
    expect(host.outstanding()).toEqual([])
    await host.shutdown()
  })

  test('never passes off what the agent said last time as this answer', async () => {
    // The closing words were read off the whole conversation, backwards, to
    // the first non-empty text. A turn that said nothing therefore answered
    // with the last thing the agent had said on its previous job — a
    // confident, specific, entirely unrelated sentence.
    const messages: { from: string; to: string; text: string }[] = []
    const { host } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'coder', message: 'do it' }), text('handed over')],
        work: [
          text('the cap now applies before the discount'),
          [...call('t1', 'noop', {})],
          silence(),
        ],
      },
      {
        tools: [noop],
        onEvent: (event) => {
          if (event.type === 'agent_message') {
            messages.push({ from: event.from, to: event.to, text: event.text })
          }
        },
      },
    )
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))

    await host.tell('coder', 'the earlier job')
    await host.idle()
    await host.tell('architect', 'go')
    await host.idle()

    const back = messages.find((one) => one.from === 'coder' && one.to === 'architect')
    expect(back?.text).toMatch(/without a closing message/)
    expect(back?.text).not.toContain('the cap now applies before the discount')
    expect(host.outstanding()).toEqual([])
    await host.shutdown()
  })
})

/**
 * Who a chain reports back to.
 *
 * Answering the agent that asked unwinds a chain one link at a time, which is
 * the wrong shape for the job: with architect → coder → tester, the architect
 * hears from the coder and not from the tester, so it learns the work is
 * written before anybody has learned it passes — and the last thing it has to
 * do, merging, is the thing it would then do too early.
 *
 * The agent the person spoke to owns the job. Everything on that chain reports
 * to it, however far along the chain it happened.
 */
describe('the agent that was given the job', () => {
  test('hears from the end of the chain, not only from the next link', async () => {
    const messages: { from: string; to: string }[] = []
    const { host } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'coder', message: 'build it' }), text('handed on')],
        work: [call('s2', 'agent_send', { to: 'tester', message: 'check it' }), text('handed on')],
        check: [text('all twelve pass')],
      },
      {
        onEvent: (event) => {
          if (event.type === 'agent_message') messages.push({ from: event.from, to: event.to })
        },
      },
    )
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))
    await host.spawn(def('tester', 'check'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(messages).toContainEqual({ from: 'tester', to: 'architect' })
    await host.shutdown()
  })

  test('is not told twice by the same agent', async () => {
    // An agent that has already spoken to the leader in its own words has
    // answered; a second copy is the harness talking over it.
    const messages: { from: string; to: string }[] = []
    const { host } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'coder', message: 'build it' }), text('handed on')],
        work: [call('s2', 'agent_send', { to: 'architect', message: 'done' }), text('told them')],
      },
      {
        onEvent: (event) => {
          if (event.type === 'agent_message') messages.push({ from: event.from, to: event.to })
        },
      },
    )
    await host.spawn(def('architect', 'plan'))
    await host.spawn(def('coder', 'work'))

    await host.tell('architect', 'go')
    await host.idle()

    expect(messages.filter((one) => one.from === 'coder' && one.to === 'architect')).toHaveLength(1)
    await host.shutdown()
  })

  test('does not report to itself', async () => {
    const { host } = makeHost({ m: [text('done')] })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(host.list()[0]?.turns).toBe(1)
    await host.shutdown()
  })

  test('is not told twice when the answer was addressed to its role', async () => {
    // bea is the reviewer. The coder answered "reviewer", which reached bea,
    // but the turn kept the name as typed: "reviewer" was not "bea", so the
    // turn looked unanswered and the harness sent bea the coder's closing
    // words as well — two messages, two turns, one answer.
    const messages: { from: string; to: string }[] = []
    const { host, events } = makeHost(
      {
        ask: [call('s1', 'agent_send', { to: 'coder', message: 'do it' }), text('asked')],
        work: [call('s2', 'agent_send', { to: 'reviewer', message: 'done' }), text('told them')],
      },
      {
        onEvent: (event) => {
          if (event.type === 'agent_message') messages.push({ from: event.from, to: event.to })
        },
      },
    )
    await host.spawn({ ...def('bea', 'ask'), role: 'reviewer' })
    await host.spawn(def('coder', 'work'))

    await host.tell('bea', 'go')
    await host.idle()

    expect(messages.filter((one) => one.from === 'coder' && one.to === 'bea')).toHaveLength(1)
    // And the coder was told who actually has it, not the role it typed.
    const results = events.flatMap((event) =>
      event.type === 'agent_event' &&
      event.event.type === 'tool_end' &&
      event.event.name === 'agent_send'
        ? [event.event.output.content]
        : [],
    )
    expect(results).toContain('delivered to bea')
    await host.shutdown()
  })
})

/**
 * The one agent a project always has.
 *
 * Reporting to whoever was spoken to makes the owner of a job whichever agent
 * somebody happened to type at, which is not a role — it changes with the
 * keystroke and there is nobody to hold the end of a job that outlives one
 * instruction. A team leader is a position rather than a kind: it can be an
 * architect, a coder, a fashion stylist, and what makes it the leader is that
 * everything comes back to it and it cannot be taken off the team.
 */
describe('the team leader', () => {
  test('is where a chain reports, whoever was spoken to', async () => {
    const messages: { from: string; to: string }[] = []
    const { host } = makeHost(
      {
        plan: [call('s1', 'agent_send', { to: 'tester', message: 'check it' }), text('handed on')],
        check: [text('all twelve pass')],
      },
      {
        leader: 'architect',
        onEvent: (event) => {
          if (event.type === 'agent_message') messages.push({ from: event.from, to: event.to })
        },
      },
    )
    await host.spawn(def('architect', 'idle-model'))
    await host.spawn(def('coder', 'plan'))
    await host.spawn(def('tester', 'check'))

    // Spoken to directly, and the answer still finds its way to the leader.
    await host.tell('coder', 'go')
    await host.idle()

    expect(messages).toContainEqual({ from: 'tester', to: 'architect' })
    await host.shutdown()
  })

  test('cannot be taken off the team', async () => {
    const { host } = makeHost({}, { leader: 'architect' })
    await host.spawn(def('architect', 'm'))
    await host.spawn(def('coder', 'm'))

    await host.kill('architect')

    expect(host.list().map((one) => one.id)).toContain('architect')
    await host.shutdown()
  })

  test('says so, rather than failing silently', async () => {
    const { host, events } = makeHost({}, { leader: 'architect' })
    await host.spawn(def('architect', 'm'))

    await host.kill('architect')

    expect(events.some((event) => event.type === 'agent_blocked')).toBe(true)
    await host.shutdown()
  })

  test('leaves everybody else removable', async () => {
    const { host } = makeHost({}, { leader: 'architect' })
    await host.spawn(def('architect', 'm'))
    await host.spawn(def('coder', 'm'))

    await host.kill('coder')

    expect(host.list().map((one) => one.id)).toEqual(['architect'])
    await host.shutdown()
  })

  test('still goes when the whole session does', async () => {
    // Not removable is about the team, not about the process. A leader that
    // survived shutdown would hold the worktree open and the program with it.
    const { host } = makeHost({}, { leader: 'architect' })
    await host.spawn(def('architect', 'm'))

    await host.shutdown()

    expect(host.list()).toEqual([])
  })
})

/**
 * Changing what an agent runs on without stopping it.
 *
 * `/model` wrote the config and told you to restart the session, while the
 * team editor killed the agent and started it again — two ways to say one
 * thing, and only one of them worked. Restarting is also no longer available
 * for the leader, which cannot be taken off the team, so the agent most likely
 * to be moved to a better model was the one that could not be.
 *
 * Nothing has to stop. The model is read from the definition at the top of
 * every turn, so replacing the definition is enough.
 */
describe('moving an agent to another model', () => {
  test('takes effect on the next turn, without a restart', async () => {
    const { host } = makeHost({
      slow: [text('on the slow one')],
      quick: [text('on the quick one')],
    })
    await host.spawn(def('coder', 'slow'))

    await host.tell('coder', 'first')
    await host.idle()
    expect(host.list()[0]?.lastText).toBe('on the slow one')

    expect(host.setModel('coder', { model: 'quick' })).toBe(true)

    await host.tell('coder', 'second')
    await host.idle()
    expect(host.list()[0]?.lastText).toBe('on the quick one')
    await host.shutdown()
  })

  test('says so on the tab, which is where the model is read', async () => {
    const { host } = makeHost({})
    await host.spawn(def('coder', 'slow'))

    host.setModel('coder', { model: 'quick' })

    expect(host.list()[0]?.model).toBe('quick')
    await host.shutdown()
  })

  test('keeps the conversation, because the agent did not go anywhere', async () => {
    const { host } = makeHost({ slow: [text('one')], quick: [text('two')] })
    await host.spawn(def('coder', 'slow'))
    await host.tell('coder', 'first')
    await host.idle()

    host.setModel('coder', { model: 'quick' })
    await host.tell('coder', 'second')
    await host.idle()

    expect(host.list()[0]?.turns).toBe(2)
    await host.shutdown()
  })

  test('works on the leader, which cannot be restarted at all', async () => {
    const { host } = makeHost({}, { leader: 'architect' })
    await host.spawn(def('architect', 'slow'))

    expect(host.setModel('architect', { model: 'quick' })).toBe(true)
    expect(host.list()[0]?.model).toBe('quick')
    await host.shutdown()
  })

  test('says plainly when there is no such agent', async () => {
    const { host } = makeHost({})
    expect(host.setModel('ghost', { model: 'quick' })).toBe(false)
    await host.shutdown()
  })
})

/**
 * A checkout with work in it outlives the session, and the team is told.
 *
 * Watched: a coder built a whole project over two hours in its worktree,
 * never committed, and the checkout was removed with `--force` when the
 * terminal closed. The next session started in an empty directory. What the
 * host owes the person is two sentences: that the checkout stayed, and — the
 * next morning — that the agent is starting where the last one left off.
 */
describe('a checkout that outlives the session', () => {
  async function repository(): Promise<string> {
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-host-wt-')))
    const git = async (args: string[], cwd = repo) => {
      const proc = Bun.spawn(['git', ...args], {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'T',
          GIT_AUTHOR_EMAIL: 't@t',
          GIT_COMMITTER_NAME: 'T',
          GIT_COMMITTER_EMAIL: 't@t',
        },
      })
      await proc.exited
    }
    await git(['init', '-q', '-b', 'main'])
    writeFileSync(join(repo, 'app.ts'), 'export const version = 1\n')
    await git(['add', '.'])
    await git(['commit', '-qm', 'initial'])
    return repo
  }

  function isolatedHost(cwd: string) {
    const events: TeamEvent[] = []
    const host = new InProcessHost({
      cwd,
      providerFor: () => scripted({})('default'),
      tools: [],
      limits: { maxHops: 3 },
      isolate: true,
      onEvent: (event) => events.push(event),
    })
    return { host, events }
  }

  test('is kept, and said to be kept, when the last agent on it goes', async () => {
    const repo = await repository()
    try {
      const { host, events } = isolatedHost(repo)
      const coder = await host.spawn(def('coder', 'm'))
      writeFileSync(join(coder.workspace, 'new.ts'), 'export const fresh = true\n')

      const outcome = await host.kill('coder')

      expect(outcome.workspace).toBe('kept')
      expect(events).toContainEqual({ type: 'workspace_kept', task: 'main', path: coder.workspace })
      await host.shutdown()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('is announced to the agent that starts in it the next time', async () => {
    const repo = await repository()
    try {
      const earlier = isolatedHost(repo)
      const before = await earlier.host.spawn(def('coder', 'm'))
      writeFileSync(join(before.workspace, 'new.ts'), 'export const fresh = true\n')
      await earlier.host.shutdown()

      const later = isolatedHost(repo)
      const after = await later.host.spawn(def('coder', 'm'))
      // A second agent on the same task joins the same checkout: the news is
      // about the checkout, and it is said once.
      await later.host.spawn(def('reviewer', 'm'))

      expect(after.workspace).toBe(before.workspace)
      expect(later.events.filter((event) => event.type === 'workspace_resumed')).toEqual([
        { type: 'workspace_resumed', id: 'coder', task: 'main', changed: 1 },
      ])
      await later.host.shutdown()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('a clean checkout is taken away, as before', async () => {
    const repo = await repository()
    try {
      const { host, events } = isolatedHost(repo)
      await host.spawn(def('coder', 'm'))

      const outcome = await host.kill('coder')

      expect(outcome.workspace).toBe('removed')
      expect(events.some((event) => event.type === 'workspace_kept')).toBe(false)
      await host.shutdown()
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })
})

/**
 * An agent turned loose carries on past its turn limit.
 *
 * The limit exists to stop a model that is going round in circles, and it
 * stops one that is building something too: a coder forty tool calls into a
 * project stopped with a file half-edited and the line "stopped after its
 * turn limit without finishing", and the person who had said "stop only when
 * you have something to show me" came back three hours later to type "go
 * on?". Unleashed means nobody is watching — so the harness says "go on"
 * itself, a bounded number of times, and stops for good only after that.
 */
describe('an agent that reaches its turn limit', () => {
  function limitedHost(scripts: Record<string, StreamDelta[][]>) {
    const events: TeamEvent[] = []
    const host = new InProcessHost({
      cwd: process.cwd(),
      providerFor: (agent) => scripted(scripts)(agent.model ?? 'default'),
      tools: [noop],
      limits: { maxHops: 3 },
      isolate: false,
      maxTurnsPerInstruction: 1,
      onEvent: (event) => events.push(event),
    })
    return { host, events }
  }

  test('carries on by itself when it is unleashed', async () => {
    const { host, events } = limitedHost({
      m: [call('t1', 'noop', {}), text('all done')],
    })
    await host.spawn(def('coder', 'm'))
    host.setYolo('coder', true)

    await host.tell('coder', 'build it')
    await host.idle()

    expect(events.filter((event) => event.type === 'agent_cut_short')).toEqual([])
    expect(events).toContainEqual({ type: 'agent_continued', id: 'coder', round: 1, of: 4 })
    expect(host.list()[0]?.lastText).toBe('all done')
    await host.shutdown()
  })

  test('stops and says so when somebody is watching', async () => {
    const { host, events } = limitedHost({
      m: [call('t1', 'noop', {}), text('all done')],
    })
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'build it')
    await host.idle()

    expect(events).toContainEqual({ type: 'agent_cut_short', id: 'coder', reason: 'max_turns' })
    expect(events.some((event) => event.type === 'agent_continued')).toBe(false)
    await host.shutdown()
  })

  test('does not carry on for ever', async () => {
    const { host, events } = limitedHost({
      m: Array.from({ length: 12 }, (_, at) => call(`t${at}`, 'noop', {})),
    })
    await host.spawn(def('coder', 'm'))
    host.setYolo('coder', true)

    await host.tell('coder', 'build it')
    await host.idle()

    expect(events.filter((event) => event.type === 'agent_continued')).toHaveLength(4)
    expect(events).toContainEqual({ type: 'agent_cut_short', id: 'coder', reason: 'max_turns' })
    await host.shutdown()
  })

  test('the continuation still reports back to whoever asked', async () => {
    const { host, events } = limitedHost({
      a: [call('a1', 'agent_send', { to: 'coder', message: 'build it' }), text('thanks')],
      m: [call('t1', 'noop', {}), text('built')],
    })
    await host.spawn(def('architect', 'a'))
    await host.spawn(def('coder', 'm'))
    host.setYolo('coder', true)

    await host.tell('architect', 'plan it')
    await host.idle()

    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'agent_message',
        from: 'coder',
        to: 'architect',
        text: 'built',
      }),
    )
    await host.shutdown()
  })
})

/**
 * A request that timed out says where it was going.
 *
 * "The operation timed out." is what a stalled request says of itself, and on
 * a screen with five agents on three services it says nothing anybody can act
 * on. Watched: an agent on a slow service went quiet for twenty minutes and
 * ended on those four words.
 */
describe('a turn that ends on a timeout', () => {
  test('names the service and the model it was waiting on', async () => {
    const stalled: Provider = {
      id: 'slow',
      // biome-ignore lint/correctness/useYield: a provider that never answers
      async *send() {
        throw new DOMException('The operation timed out.', 'TimeoutError')
      },
    }
    const { host, events } = makeHost({}, { providerFor: { coder: stalled } })
    await host.spawn({ ...def('coder', 'hy4-preview'), provider: 'opencode-go' })

    await host.tell('coder', 'go')
    await host.idle()

    const failed = events.find((event) => event.type === 'agent_failed')
    expect(failed).toMatchObject({
      type: 'agent_failed',
      id: 'coder',
      reason: 'the request to opencode-go for hy4-preview timed out before it answered',
    })
    await host.shutdown()
  })
})

/**
 * `kill` stops an agent and then waits for its turn to unwind, and for that
 * long the agent is still on the roster with a mailbox that drops everything
 * put in it.
 */
describe('an agent that is being stopped', () => {
  /** A provider that holds its turn open until the turn is cancelled. */
  function untilCancelled(): { provider: Provider; entered: Promise<void> } {
    let enter = (): void => {}
    const entered = new Promise<void>((resolve) => {
      enter = resolve
    })
    return {
      entered,
      provider: {
        id: 'held',
        async *send(_request, signal) {
          enter()
          await new Promise((resolve) => signal.addEventListener('abort', resolve))
          for (const delta of text('(stopped)')) yield delta
        },
      },
    }
  }

  test('is not handed work by a colleague, who is told why', async () => {
    // A message sent in that window was recorded as a handoff, "delivered"
    // to a mailbox that drops everything, and the sender's tool result said
    // it had arrived. The message was gone, and the ledger said nobody was
    // waiting on anything.
    const held = untilCancelled()
    const { host, events } = makeHost({}, { providerFor: { reviewer: held.provider } })
    await host.spawn(def('coder', 'm'))
    await host.spawn(def('reviewer', 'm'))
    await host.tell('reviewer', 'a long job')
    await held.entered

    const killing = host.kill('reviewer')
    const sent = await host.relay({ from: 'coder', to: 'reviewer', text: 'please review', hops: 1 })
    await killing

    expect(sent).toEqual({ delivered: false, reason: 'reviewer is being stopped' })
    expect(events.filter((event) => event.type === 'agent_message')).toEqual([])
    expect(host.outstanding()).toEqual([])
    await host.shutdown()
  })

  test('cannot be told anything either', async () => {
    const held = untilCancelled()
    const { host } = makeHost({}, { providerFor: { reviewer: held.provider } })
    await host.spawn(def('reviewer', 'm'))
    await host.tell('reviewer', 'a long job')
    await held.entered

    const killing = host.kill('reviewer')
    await expect(host.tell('reviewer', 'one more thing')).rejects.toThrow(/being stopped/)
    await killing

    expect(host.outstanding()).toEqual([])
    await host.shutdown()
  })
})

describe('an instruction given the moment an agent goes idle', () => {
  test('is carried out, and waiting for the team still ends', async () => {
    // An interface that queues the next thing from the idle event. The event
    // was emitted from inside the pump, which cleared itself only afterwards,
    // so the instruction landed in a mailbox whose pump was about to vanish:
    // nothing ran it, and idle() — an agent busy with no pump to wait on —
    // spun without ever yielding, for the rest of the process.
    let calls = 0
    let told = false
    const { host } = makeHost(
      {},
      {
        providerFor: {
          coder: {
            id: 'counting',
            async *send() {
              calls += 1
              for (const delta of text(`answer ${calls}`)) yield delta
            },
          },
        },
        onEvent: (event) => {
          if (event.type !== 'agent_status' || event.status !== 'idle' || told) return
          told = true
          void host.tell('coder', 'and now the second thing')
        },
      },
    )
    await host.spawn(def('coder', 'm'))

    await host.tell('coder', 'the first thing')
    // Waited for by the clock first, because before the fix idle() never
    // came back — and a test that hangs the runner explains nothing.
    await Bun.sleep(50)
    expect(calls).toBe(2)
    expect(host.list()[0]?.queued).toBe(0)

    await host.idle()
    expect(host.list()[0]?.status).toBe('idle')
    await host.shutdown()
  })
})

/**
 * A turn that failed, in the ledger.
 *
 * The stall notice reads the ledger to say why nobody is working, and a turn
 * that threw left no mark at all — so it said "architect never took a turn on
 * it" about an agent that had taken one and lost it to a provider error. The
 * error was on the screen; the notice contradicted it.
 */
describe('a turn that ends in an error', () => {
  test('is marked in the ledger as having failed, not as never having happened', async () => {
    const broken: Provider = {
      id: 'broken',
      // biome-ignore lint/correctness/useYield: a provider that only fails
      async *send() {
        throw new Error('the service said no')
      },
    }
    const { host } = makeHost({}, { providerFor: { coder: broken } })
    await host.spawn(def('coder', 'any'))

    await host.tell('coder', 'go')
    await host.idle()

    expect(host.outstanding()).toEqual([
      expect.objectContaining({ from: 'user', to: 'coder', cutShort: 'failed' }),
    ])
    await host.shutdown()
  })
})
