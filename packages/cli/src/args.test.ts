import { describe, expect, test } from 'bun:test'
import { parseCliArgs, USAGE, UsageError } from './args.ts'

describe('parseCliArgs', () => {
  test('reads the task from the prompt flag', () => {
    expect(parseCliArgs(['-p', 'fix the failing test']).prompt).toBe('fix the failing test')
  })

  test('accepts the long form of every flag', () => {
    const args = parseCliArgs(['--prompt', 'x', '--cwd', '/repo', '--max-turns', '3'])

    expect(args).toMatchObject({ prompt: 'x', cwd: '/repo', maxTurns: 3 })
  })

  test('defaults the workspace to the current directory', () => {
    expect(parseCliArgs(['-p', 'x']).cwd).toBe(process.cwd())
  })

  test('normalises the workspace, so "proj/" and "." name the directory and not a spelling', () => {
    // Everything keyed by the workspace — trust, the transcript, the "outside
    // this project" test on the config — compared the string it was given.
    // `-C proj/`, which is what shell completion types, made every one of the
    // project's own files "outside this project". Resolved once, here, so
    // nothing downstream has to remember to.
    expect(parseCliArgs(['-p', 'x', '-C', '/repo/']).cwd).toBe('/repo')
    expect(parseCliArgs(['-p', 'x', '-C', '.']).cwd).toBe(process.cwd())
    expect(parseCliArgs(['config', '-C', '/repo/']).cwd).toBe('/repo')
    expect(parseCliArgs(['-C', '/repo/']).cwd).toBe('/repo')
  })

  test('opens the interface when given nothing at all', () => {
    // Someone who typed `aidcrew` wants to start working, not read usage.
    expect(parseCliArgs([]).command).toBe('ui')
  })

  test('answers what version it is, which a bug report has to say', () => {
    expect(parseCliArgs(['--version']).version).toBe(true)
    expect(parseCliArgs(['-v']).version).toBe(true)
    expect(parseCliArgs(['-p', 'x']).version).toBe(false)
  })

  test('still asks for a task when a subcommand needs one', () => {
    expect(() => parseCliArgs(['team'])).toThrow(UsageError)
  })

  test('rejects a blank task rather than sending it', () => {
    expect(() => parseCliArgs(['-p', '   '])).toThrow(UsageError)
  })

  test('rejects an unknown flag instead of ignoring it', () => {
    // A silently dropped flag reads as the harness disobeying an instruction.
    expect(() => parseCliArgs(['-p', 'x', '--turbo'])).toThrow(UsageError)
  })

  test('rejects a turn limit that is not a positive whole number', () => {
    expect(() => parseCliArgs(['-p', 'x', '--max-turns', '0'])).toThrow(UsageError)
    expect(() => parseCliArgs(['-p', 'x', '--max-turns', 'many'])).toThrow(UsageError)
  })

  test('does not require a task when asking for help', () => {
    expect(parseCliArgs(['--help']).help).toBe(true)
  })

  test('defaults to running a single agent', () => {
    expect(parseCliArgs(['-p', 'x']).command).toBe('run')
  })

  test('reads the team subcommand', () => {
    expect(parseCliArgs(['team', '-p', 'x']).command).toBe('team')
  })

  test('reads which agent a team instruction is for', () => {
    expect(parseCliArgs(['team', '-p', 'x', '--to', 'coder']).to).toBe('coder')
  })

  test('rejects an unknown subcommand rather than treating it as a task', () => {
    expect(() => parseCliArgs(['teem', '-p', 'x'])).toThrow(UsageError)
  })

  test('reads the config command and its action', () => {
    const args = parseCliArgs(['config', 'set-key', 'provider:zen'])

    expect(args.command).toBe('config')
    expect(args.rest).toEqual(['set-key', 'provider:zen'])
  })

  test('does not demand a task for config', () => {
    expect(() => parseCliArgs(['config'])).not.toThrow()
  })

  test('rejects a stray extra argument', () => {
    expect(() => parseCliArgs(['team', 'extra', '-p', 'x'])).toThrow(UsageError)
  })

  test('refuses --to outside a team run, instead of ignoring it', () => {
    expect(() => parseCliArgs(['-p', 'x', '--to', 'coder'])).toThrow(UsageError)
  })
})

describe('taking a change back', () => {
  test('undo takes no task, the way the other settings commands do not', () => {
    expect(parseCliArgs(['undo'])).toMatchObject({ command: 'undo', prompt: '' })
  })

  test('carries --list through to the command that reads it', () => {
    // Declared in the parser as well as forwarded: strict parsing rejects an
    // undeclared flag before the command ever sees it, which reads as the
    // harness disobeying an instruction.
    expect(parseCliArgs(['undo', '--list']).rest).toContain('--list')
  })

  test('names undo among the commands when something else is typed', () => {
    expect(() => parseCliArgs(['undoo'])).toThrow(/undo/)
  })
})

describe('the commands it will admit to having', () => {
  const commands = [
    'config',
    'forget',
    'ui',
    'models',
    'undo',
    'mcp',
    'plugin',
    'project',
    'keys',
    'team',
  ] as const

  // Not a near-miss of the command itself: the message quotes back what was
  // typed, so `pluginx` makes any test looking for "plugin" pass without the
  // message ever offering it.
  const complaint = (): string => {
    try {
      parseCliArgs(['zzz'])
    } catch (cause) {
      return cause instanceof Error ? cause.message : String(cause)
    }
    throw new Error('parsing "zzz" was supposed to fail')
  }

  for (const command of commands) {
    test(`${command} is one of the commands it names`, () => {
      // A verb the parser accepts and the error never names is a verb nobody
      // finds. `plugin` was one, which for a project whose whole claim is
      // that everything is a plugin is the worst one to lose.
      expect(complaint()).toContain(command)
    })
  }

  test('every one of them is documented in the usage text', () => {
    for (const command of commands) expect(USAGE).toContain(`aidcrew ${command}`)
  })
})
