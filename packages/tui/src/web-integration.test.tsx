import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openJournal } from '@aidcrew/cli'
import { render } from 'ink'
import { writeAgent } from './agents-file.ts'
import { App } from './app.tsx'
import { openRuntime } from './runtime.ts'
import { webSession } from './web-session.ts'

async function until(check: () => boolean) {
  for (let i = 0; i < 300; i++) {
    if (check()) return
    await Bun.sleep(10)
  }
  throw new Error('Session state did not arrive')
}
test('browser and rendered terminal share messages, model changes and exactly-once approvals', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-web-integration-')))
  const frames: string[] = []
  const requests: string[] = []
  const model = Bun.serve({
    port: 0,
    fetch: async (request) => {
      requests.push(await request.text())
      return new Response(
        'data: {"choices":[{"index":0,"delta":{"content":"Reply from the shared model"}}]}\n\ndata: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    },
  })
  const cwd = join(root, 'project')
  await writeAgent(cwd, { id: 'coder', description: 'Builder', systemPrompt: 'Build.', reason: '' })
  await writeAgent(cwd, {
    id: 'reviewer',
    description: 'Reviewer',
    systemPrompt: 'Review.',
    reason: '',
  })
  await Bun.write(
    join(cwd, '.aidcrew/config.toml'),
    '[sources]\nagents=[".aidcrew/agents"]\n[defaults]\nsharedMemory=true\nprovider="openai-compat"\nmodel="test-model"\n',
  )
  const journal = openJournal(cwd, root)
  journal.rememberShared('main', {
    notes: [{ from: 'previous-coder', text: 'FIRST-START MEMORY MUST REACH THE MODEL', at: 1 }],
  })
  journal.close()
  const runtime = await openRuntime(cwd, root)
  const web = webSession()
  let queued: string | undefined
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => {
      const value = queued
      queued = undefined
      return value ?? null
    },
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  })
  const stdout = Object.assign(new EventEmitter(), {
    isTTY: true,
    columns: 140,
    rows: 38,
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
  })
  const app = render(
    <App
      runtime={runtime}
      home={root}
      initialCwd={cwd}
      env={{ AIDCREW_API_KEY: 'test', AIDCREW_BASE_URL: `${model.url.origin}/v1` }}
      web={web}
    />,
    { stdin: stdin as never, stdout: stdout as never, exitOnCtrlC: false },
  )
  try {
    await until(() => web.snapshot().ready)
    const selected = web.snapshot().target
    const originalModel = web.snapshot().agents.find((a) => a.id === selected)?.model
    const other = web.snapshot().agents.find((a) => a.id !== selected)?.id
    if (!other) throw new Error('Second test agent missing')
    await web.dispatch({ type: 'send', agent: other, text: 'Message from the web' })
    await until(() =>
      web
        .snapshot()
        .lines.some((l) => l.agentId === other && l.text.includes('Reply from the shared model')),
    )
    expect(
      web
        .snapshot()
        .lines.some(
          (l) => l.agentId === other && l.kind === 'ask' && l.text === 'Message from the web',
        ),
    ).toBe(true)
    expect(web.snapshot().sharedMemory).toBe(true)
    expect(requests[0]).toContain('FIRST-START MEMORY MUST REACH THE MODEL')
    queued = '\u0013'
    stdin.emit('readable')
    await Bun.sleep(50)
    await web.dispatch({ type: 'command', agent: other, text: '/model changed-model' })
    expect(await Bun.file(join(cwd, '.aidcrew/config.toml')).text()).toContain('changed-model')
    queued = '\u001b'
    stdin.emit('readable')
    await Bun.sleep(50)
    await until(() =>
      web.snapshot().agents.some((a) => a.id === other && a.model === 'changed-model'),
    )
    expect(web.snapshot().agents.find((a) => a.id === selected)?.model).toBe(originalModel)
    const approved = runtime.session.askPlugin?.({
      plugin: 'integration',
      title: 'Approve exactly once?',
    })
    await until(() => !!web.snapshot().pending)
    const pending = web.snapshot().pending
    if (!pending) throw new Error('Approval did not appear')
    await until(() => frames.join('').includes('Approve exactly once?'))
    await web.dispatch({ type: 'answer', request: pending.id, key: 'y' })
    expect(await approved).toBe(true)
    await expect(web.dispatch({ type: 'answer', request: pending.id, key: 'y' })).rejects.toThrow(
      'already been answered',
    )
    await until(() => !web.snapshot().pending)
    // Terminal input still reaches the same live model after a web-side decision.
    await Bun.sleep(60)
    queued = 'Terminal message'
    stdin.emit('readable')
    await until(() => frames.join('').includes('Terminal message'))
    queued = '\r'
    stdin.emit('readable')
    await until(() =>
      web.snapshot().lines.some((l) => l.kind === 'ask' && l.text === 'Terminal message'),
    )
    const second = join(root, 'second-project')
    await writeAgent(second, {
      id: 'coder',
      description: 'Second builder',
      systemPrompt: 'Build.',
      reason: '',
    })
    await Bun.write(
      join(second, '.aidcrew/config.toml'),
      '[sources]\nagents=[".aidcrew/agents"]\n[defaults]\nsharedMemory=false\nprovider="openai-compat"\n',
    )
    const secondJournal = openJournal(second, root)
    secondJournal.rememberShared('main', {
      notes: [{ from: 'old-session', text: 'SECOND PROJECT MEMORY MUST STAY HIDDEN', at: 1 }],
    })
    secondJournal.close()
    const previousSession = web.snapshot().sessionId
    const changing = web.dispatch({ type: 'open', cwd: second })
    await expect(
      web.dispatch({ type: 'send', agent: selected, text: 'Must not land during switching' }),
    ).rejects.toThrow('workspace is changing')
    await changing
    await until(() => web.snapshot().ready && web.snapshot().cwd === second)
    expect(web.snapshot().sessionId).not.toBe(previousSession)
    expect(web.snapshot().sharedMemory).toBe(false)
    await web.dispatch({ type: 'send', agent: 'coder', text: 'Check the second project' })
    await until(() =>
      web
        .snapshot()
        .lines.some((l) => l.kind === 'say' && l.text.includes('Reply from the shared model')),
    )
    expect(requests.at(-1)).not.toContain('FIRST-START MEMORY MUST REACH THE MODEL')
    expect(requests.at(-1)).not.toContain('SECOND PROJECT MEMORY MUST STAY HIDDEN')
  } finally {
    queued = '\u0003'
    stdin.emit('readable')
    await Bun.sleep(100)
    app.unmount()
    runtime.close()
    model.stop(true)
    rmSync(root, { recursive: true, force: true })
  }
}, 15000)
