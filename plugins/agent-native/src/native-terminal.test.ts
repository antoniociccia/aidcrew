import { expect, test } from 'bun:test'
import { startNativeTerminal } from './native-terminal.ts'

const command = [
  process.execPath,
  '-e',
  `process.stdout.write(process.stdin.isTTY ? 'TTY_READY\\n' : 'NO_TTY\\n'); process.stdin.setRawMode(true); process.stdin.on('data', data => { if (data.toString() === 'q') process.exit(0); else process.stdout.write('reply:' + data.toString()); });`,
]

async function waitUntil(predicate: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return
    await Bun.sleep(10)
  }
  throw new Error('Timed out waiting for terminal output')
}

test('runs an interactive terminal and forwards input, output and exit', async () => {
  let output = ''
  const exits: (number | null)[] = []
  const session = startNativeTerminal(
    {
      cwd: process.cwd(),
      cols: 80,
      rows: 24,
      onData: (data) => {
        output += new TextDecoder().decode(data)
      },
      onExit: (code) => exits.push(code),
    },
    { command },
  )
  try {
    await waitUntil(() => output.includes('TTY_READY'))
    session.resize(100, 30)
    session.write('hello')
    await waitUntil(() => output.includes('reply:hello'))
    expect(new TextDecoder().decode(session.history())).toContain('TTY_READY')
    session.write('q')
    expect(await session.exited).toBe(0)
    expect(exits).toEqual([0])
  } finally {
    session.close()
  }
})

test('rejects invalid geometry and missing commands before starting a session', () => {
  const options = { cwd: process.cwd(), cols: 0, rows: 24, onData: () => {}, onExit: () => {} }
  expect(() => startNativeTerminal(options, { command })).toThrow('Terminal dimensions')
  expect(() =>
    startNativeTerminal({ ...options, cols: 80 }, { command: ['/definitely/missing/claude'] }),
  ).toThrow('not found')
})

test('bounds replay memory and makes close idempotent', async () => {
  const session = startNativeTerminal(
    { cwd: process.cwd(), cols: 80, rows: 24, onData: () => {}, onExit: () => {} },
    {
      command: [
        process.execPath,
        '-e',
        `process.stdout.write('x'.repeat(800000)); setInterval(() => {}, 1000)`,
      ],
    },
  )
  try {
    await waitUntil(() => session.history().length >= 500000)
    expect(session.history().length).toBeLessThanOrEqual(512 * 1024)
    session.close()
    session.close()
    await session.exited
    expect(() => session.write('ignored')).toThrow('closed')
  } finally {
    session.close()
  }
})

test('does not pass API credentials or provider overrides to the native process', async () => {
  const names = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
  ]
  const original = names.map((name) => process.env[name])
  const marker = process.env.AIDCREW_AUTH_FIXTURE
  let session: ReturnType<typeof startNativeTerminal> | undefined
  try {
    for (const name of names) process.env[name] = 'test-only-override'
    process.env.AIDCREW_AUTH_FIXTURE = 'preserved'
    session = startNativeTerminal(
      { cwd: process.cwd(), cols: 80, rows: 24, onData: () => {}, onExit: () => {} },
      {
        command: [
          process.execPath,
          '-e',
          `const names=${JSON.stringify(names)};process.stdout.write(names.some(name=>Boolean(process.env[name]))?'API_OVERRIDE_PRESENT':'SUBSCRIPTION_ENVIRONMENT');if(process.env.AIDCREW_AUTH_FIXTURE==='preserved')process.stdout.write('PARENT_SETTING_PRESENT');`,
        ],
      },
    )
    await session.exited
    expect(new TextDecoder().decode(session.history())).toContain('SUBSCRIPTION_ENVIRONMENT')
    expect(new TextDecoder().decode(session.history())).toContain('PARENT_SETTING_PRESENT')
    for (const name of names) expect(process.env[name]).toBe('test-only-override')
  } finally {
    session?.close()
    if (marker === undefined) delete process.env.AIDCREW_AUTH_FIXTURE
    else process.env.AIDCREW_AUTH_FIXTURE = marker
    names.forEach((name, index) => {
      const value = original[index]
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    })
  }
})
