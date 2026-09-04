import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Message } from '@aidcrew/core'
import { HISTORY_FILE, openHistory } from './history.ts'

let cwd: string

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-history-')))
})

afterEach(() => rmSync(cwd, { recursive: true, force: true }))

const said = (text: string): Message => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
})

describe('the transcript', () => {
  test('reads back in the order it was written', () => {
    const history = openHistory(cwd)
    history.append({ agentId: 'coder', kind: 'tool', text: 'bash bun test' })
    history.append({ agentId: 'coder', kind: 'say', text: 'all green' })
    history.close()

    const reopened = openHistory(cwd)
    expect(reopened.transcript().map((line) => line.text)).toEqual(['bash bun test', 'all green'])
    reopened.close()
  })

  test('keeps every agent apart', () => {
    const history = openHistory(cwd)
    history.append({ agentId: 'coder', kind: 'say', text: 'mine' })
    history.append({ agentId: 'reviewer', kind: 'say', text: 'theirs' })

    expect(history.transcript().filter((line) => line.agentId === 'coder')).toHaveLength(1)
    history.close()
  })

  test('lives in the project, next to the worktrees', () => {
    const history = openHistory(cwd)

    expect(history.path).toBe(join(cwd, HISTORY_FILE))
    history.close()
  })
})

describe('an agent conversation', () => {
  test('comes back as it was left', () => {
    const history = openHistory(cwd)
    history.remember('coder', [said('the rotation was missing')])
    history.close()

    const reopened = openHistory(cwd)
    expect(reopened.messages('coder')).toEqual([said('the rotation was missing')])
    reopened.close()
  })

  test('is replaced whole, not appended to', () => {
    // The loop rewrites what it holds as it goes, so the last state is the
    // only true one; keeping the earlier ones would replay a stale history.
    const history = openHistory(cwd)
    history.remember('coder', [said('first')])
    history.remember('coder', [said('first'), said('second')])

    expect(history.messages('coder')).toHaveLength(2)
    history.close()
  })

  test('is empty for an agent that has never spoken', () => {
    const history = openHistory(cwd)

    expect(history.messages('nobody')).toEqual([])
    history.close()
  })

  test('can be thrown away for one agent without touching the others', () => {
    const history = openHistory(cwd)
    history.remember('coder', [said('mine')])
    history.remember('reviewer', [said('theirs')])
    history.append({ agentId: 'coder', kind: 'say', text: 'mine' })

    history.forget('coder')

    expect(history.messages('coder')).toEqual([])
    expect(history.messages('reviewer')).toHaveLength(1)
    expect(history.transcript()).toHaveLength(0)
    history.close()
  })
})

describe('opening a database written by an older version', () => {
  test('adds what is missing rather than failing at the first query', () => {
    // The lazy CREATE TABLE IF NOT EXISTS left old columns in place and
    // reported the mismatch as a missing column, on real data.
    const first = openHistory(cwd)
    first.append({ agentId: 'coder', kind: 'say', text: 'kept' })
    first.close()

    const second = openHistory(cwd)
    expect(second.transcript()).toHaveLength(1)
    second.close()
  })
})

describe('keeping the session record out of the repository', () => {
  test('writes an ignore file next to the database', () => {
    // Committed by accident it is a guaranteed merge conflict and a way for a
    // private file an agent happened to read to reach a public repository.
    const history = openHistory(cwd)
    history.close()

    const ignore = readFileSync(join(cwd, '.aidcrew', '.gitignore'), 'utf8')
    expect(ignore).toContain('history.db*')
    expect(ignore).toContain('ui.json')
  })

  test('leaves the config and the agents committable, which is the point', () => {
    const history = openHistory(cwd)
    history.close()

    // The patterns, not the prose around them: the comment mentions both by
    // name, and a test that reads comments passes for the wrong reason.
    const patterns = readFileSync(join(cwd, '.aidcrew', '.gitignore'), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '' && !line.startsWith('#'))

    expect(patterns).toEqual(['history.db*', 'ui.json', 'wt/', 'undo/'])
  })

  test('does not argue with one somebody has already edited', () => {
    mkdirSync(join(cwd, '.aidcrew'), { recursive: true })
    writeFileSync(join(cwd, '.aidcrew', '.gitignore'), 'mine\n')

    openHistory(cwd).close()

    expect(readFileSync(join(cwd, '.aidcrew', '.gitignore'), 'utf8')).toBe('mine\n')
  })
})

describe('what an agent has spent', () => {
  test('survives closing the session, along with the conversation', () => {
    // Without this the totals restart at zero every time the interface is
    // reopened, so a figure that should only ever climb appears never to move
    // — which is how a session that cost real money reads as free.
    const history = openHistory(cwd)
    history.remember('coder', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }], {
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
    })
    history.close()

    const reopened = openHistory(cwd)
    expect(reopened.usageOf('coder')).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
      cacheReadTokens: 9000,
    })
    reopened.close()
  })

  test('is nothing for an agent that has not spent anything yet', () => {
    const history = openHistory(cwd)

    expect(history.usageOf('nobody')).toBeUndefined()
    history.close()
  })

  test('opens a database written before it kept usage at all', () => {
    // The file on disk is older than this feature. Refusing to open it would
    // lose every conversation somebody already had.
    const history = openHistory(cwd)
    history.remember('coder', [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }])
    history.close()

    const reopened = openHistory(cwd)
    expect(reopened.messages('coder')).toHaveLength(1)
    expect(reopened.usageOf('coder')).toBeUndefined()
    reopened.close()
  })
})
