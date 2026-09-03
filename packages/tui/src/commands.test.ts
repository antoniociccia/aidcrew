import { describe, expect, test } from 'bun:test'
import {
  COMMANDS,
  completions,
  fileCompletions,
  isCommand,
  nearest,
  parseCommand,
  partialMention,
} from './commands.ts'

describe('telling a command from a message', () => {
  test('a line starting with a slash is a command', () => {
    expect(isCommand('/help')).toBe(true)
  })

  test('a message that merely mentions a path is not', () => {
    // The common case this protects: pasting a path, or a regular expression.
    for (const text of ['/', '//src/auth.ts is wrong', 'fix /etc/hosts', '']) {
      expect(isCommand(text)).toBe(false)
    }
    expect(parseCommand('look at /usr/bin')).toBeUndefined()
  })

  test('leading spaces do not stop it being one', () => {
    expect(parseCommand('  /help')).toEqual({ at: 'help' })
  })
})

describe('reading each command', () => {
  test('spawn takes a role, and optionally what to run it on', () => {
    expect(parseCommand('/spawn coder')).toEqual({ at: 'spawn', role: 'coder' })
    expect(parseCommand('/spawn coder deepseek-v4')).toEqual({
      at: 'spawn',
      role: 'coder',
      model: 'deepseek-v4',
    })
    // Both spellings people use for saying which service.
    expect(parseCommand('/spawn coder zen deepseek-v4')).toEqual({
      at: 'spawn',
      role: 'coder',
      provider: 'zen',
      model: 'deepseek-v4',
    })
  })

  test('tell keeps the whole message, spaces and all', () => {
    expect(parseCommand('/tell coder run the tests, then tell me')).toEqual({
      at: 'tell',
      agent: 'coder',
      text: 'run the tests, then tell me',
    })
  })

  test('the ones that take an agent work with or without one', () => {
    expect(parseCommand('/diff')).toEqual({ at: 'diff' })
    expect(parseCommand('/diff coder')).toEqual({ at: 'diff', agent: 'coder' })
    expect(parseCommand('/stop')).toEqual({ at: 'stop' })
    expect(parseCommand('/clear reviewer')).toEqual({ at: 'clear', agent: 'reviewer' })
  })

  test('a command missing what it needs is not silently half-run', () => {
    // /kill with no name would otherwise have to guess which agent, and
    // guessing wrong ends the wrong one.
    for (const text of ['/kill', '/tell coder', '/model', '/spawn']) {
      expect(parseCommand(text)).toMatchObject({ at: 'unknown' })
    }
  })
})

describe('letting an agent off the leash', () => {
  test('turns it on for the agent you are talking to', () => {
    expect(parseCommand('/yolo')).toEqual({ at: 'yolo', on: true })
  })

  test('names another agent, or turns it back off, in either order', () => {
    expect(parseCommand('/yolo coder')).toEqual({ at: 'yolo', on: true, agent: 'coder' })
    expect(parseCommand('/yolo off')).toEqual({ at: 'yolo', on: false })
    expect(parseCommand('/yolo coder off')).toEqual({ at: 'yolo', on: false, agent: 'coder' })
    expect(parseCommand('/yolo off coder')).toEqual({ at: 'yolo', on: false, agent: 'coder' })
  })
})

describe('starting a second job', () => {
  test('takes a name, and the roles to put on it', () => {
    expect(parseCommand('/task auth coder reviewer')).toEqual({
      at: 'task',
      name: 'auth',
      roles: ['coder', 'reviewer'],
    })
  })

  test('a name on its own means the whole team', () => {
    expect(parseCommand('/task auth')).toEqual({ at: 'task', name: 'auth', roles: [] })
  })

  test('refuses a task with no name rather than inventing one', () => {
    expect(parseCommand('/task')).toMatchObject({ at: 'unknown' })
  })
})

describe('getting it wrong', () => {
  test('names the nearest command instead of only refusing', () => {
    expect(parseCommand('/spwan coder')).toMatchObject({ at: 'unknown', nearest: 'spawn' })
    expect(nearest('kil')).toBe('kill')
    expect(nearest('modle')).toBe('model')
  })

  test('does not invent a correction for something entirely different', () => {
    // A wrong guess is worse than none: it sends somebody to read about a
    // command that was never what they wanted.
    expect(nearest('deploy')).toBeUndefined()
    expect(parseCommand('/deploy')).toEqual({ at: 'unknown', typed: '/deploy' })
  })
})

describe('completing what has been typed', () => {
  test('offers everything at a bare slash', () => {
    expect(completions('/')).toHaveLength(COMMANDS.length)
  })

  test('narrows as you type', () => {
    expect(completions('/c').map((command) => command.name)).toEqual(['clear', 'copy'])
    expect(completions('/y').map((command) => command.name)).toEqual(['yolo'])
    expect(completions('/sp').map((command) => command.name)).toEqual(['spawn', 'split'])
  })

  test('offers nothing once a command is complete and has arguments', () => {
    expect(completions('/spawn coder').map((command) => command.name)).toEqual(['spawn'])
    expect(completions('hello')).toEqual([])
  })
})

describe('/task and /model', () => {
  test('/task is in the list, since the tasks screen tells you to type it', () => {
    expect(COMMANDS.map((command) => command.name)).toContain('task')
  })

  test('/model takes a provider before the model, the way /spawn does', () => {
    // `/model openai gpt-5` used to move the agent to a model called "openai".
    expect(parseCommand('/model openai gpt-5')).toEqual({
      at: 'model',
      provider: 'openai',
      model: 'gpt-5',
    })
    expect(parseCommand('/model gpt-5')).toEqual({ at: 'model', model: 'gpt-5' })
  })
})

describe('the help', () => {
  test('is the list itself, so it cannot describe a version that is gone', () => {
    expect(COMMANDS.map((command) => command.name)).toContain('spawn')
    for (const command of COMMANDS) {
      expect(command.what.endsWith('.')).toBe(true)
    }
  })
})

describe('naming a file with @', () => {
  const files = ['src/auth/guard.ts', 'src/auth.test.ts', 'README.md', 'docs/auth.md']

  test('sees a mention only while it is the thing being typed', () => {
    expect(partialMention('look at @src/au')).toBe('src/au')
    expect(partialMention('@')).toBe('')
    // Finished, and being written past: completing it now would replace text
    // the person has already moved on from.
    expect(partialMention('look at @src/auth.ts and')).toBeUndefined()
    expect(partialMention('someone@example.com')).toBeUndefined()
  })

  test('matches the part of a path anybody actually remembers', () => {
    // Nobody remembers the directories, and somebody typing `auth` means
    // auth.ts far more often than they mean everything under auth/.
    expect(fileCompletions('auth', files)).toEqual([
      'src/auth.test.ts',
      'docs/auth.md',
      'src/auth/guard.ts',
    ])
  })

  test('puts what starts with what you typed ahead of what merely contains it', () => {
    expect(fileCompletions('src/', files)[0]).toBe('src/auth/guard.ts')
  })

  test('offers a few to start with rather than nothing', () => {
    expect(fileCompletions('', files, 2)).toEqual(['src/auth/guard.ts', 'src/auth.test.ts'])
  })
})
