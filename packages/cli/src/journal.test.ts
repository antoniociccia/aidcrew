import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Message } from '@aidcrew/core'
import { importDatabase, journalPath, openJournal, orphanedRecords, slugOf } from './journal.ts'

let home: string
let repo: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-home-')))
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-repo-')))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  rmSync(repo, { recursive: true, force: true })
})

const said = (text: string): Message => ({ role: 'assistant', content: [{ type: 'text', text }] })
const asked = (text: string): Message => ({ role: 'user', content: [{ type: 'text', text }] })

describe('where the record lives', () => {
  test('under the home directory, not in the project', () => {
    // A transcript is what somebody did, not a property of the repository: it
    // changes on every run and holds the contents of files that were read.
    expect(journalPath(repo, home).startsWith(join(home, '.aidcrew'))).toBe(true)
    expect(journalPath(repo, home).startsWith(repo)).toBe(false)
  })

  test('named after the project, so a folder of them can be told apart', () => {
    expect(slugOf('/Users/me/work/api')).toMatch(/^-Users-me-work-api-[0-9a-f]{8}$/)
    expect(journalPath('/a/b', home)).not.toBe(journalPath('/a/c', home))
  })

  test('two paths that differ only in where a separator falls get two records', () => {
    // Separators became dashes and nothing else did, so `/x/dev-tools` and
    // `/x/dev/tools` were one folder: project B's agent came up holding
    // project A's conversation, and the contents of the files A had read.
    const a = join(repo, 'dev-tools')
    const b = join(repo, 'dev', 'tools')
    mkdirSync(a)
    mkdirSync(b, { recursive: true })
    const first = openJournal(a, home)
    first.remember('coder', [asked('what A said')])
    first.close()

    expect(journalPath(b, home)).not.toBe(journalPath(a, home))
    expect(openJournal(b, home).messages('coder')).toEqual([])
  })
})

describe('keeping a conversation', () => {
  test('comes back after a restart', () => {
    const first = openJournal(repo, home)
    first.remember('coder', [asked('fix the bug'), said('fixed')])
    first.close()

    const second = openJournal(repo, home)
    expect(second.messages('coder')).toEqual([asked('fix the bug'), said('fixed')])
  })

  test('writes only what is new, which is the point of all of this', () => {
    const journal = openJournal(repo, home)
    journal.remember('coder', [asked('one'), said('done')])
    const afterFirst = readFileSync(journal.path, 'utf8').split('\n').filter(Boolean).length

    journal.remember('coder', [asked('one'), said('done'), asked('two'), said('done')])
    const afterSecond = readFileSync(journal.path, 'utf8').split('\n').filter(Boolean).length

    // Two more messages, two more lines — not the whole conversation again.
    expect(afterSecond - afterFirst).toBe(2)
  })

  test('writes the whole thing when it was compacted, and replays it right', () => {
    const journal = openJournal(repo, home)
    journal.remember('coder', [asked('one'), said('a'), asked('two'), said('b')])
    // What compaction produces: a summary in place of what came before.
    journal.remember('coder', [asked('summary of earlier'), said('b')])
    journal.close()

    const reopened = openJournal(repo, home)
    expect(reopened.messages('coder')).toEqual([asked('summary of earlier'), said('b')])
  })

  test('keeps each agent apart', () => {
    const journal = openJournal(repo, home)
    journal.remember('coder', [asked('code')])
    journal.remember('reviewer', [asked('review')])
    journal.close()

    const reopened = openJournal(repo, home)
    expect(reopened.messages('coder')).toEqual([asked('code')])
    expect(reopened.messages('reviewer')).toEqual([asked('review')])
  })

  test('forgets an agent that was killed', () => {
    const journal = openJournal(repo, home)
    journal.remember('coder', [asked('one')])
    journal.forget('coder')
    journal.close()

    expect(openJournal(repo, home).messages('coder')).toEqual([])
  })
})

describe('what an agent has spent', () => {
  test('comes back with the conversation', () => {
    const journal = openJournal(repo, home)
    journal.remember('coder', [asked('one')], { inputTokens: 1200, outputTokens: 340 })
    journal.close()

    expect(openJournal(repo, home).usageOf('coder')).toEqual({
      inputTokens: 1200,
      outputTokens: 340,
    })
  })

  test('is nothing for an agent that has spent nothing', () => {
    expect(openJournal(repo, home).usageOf('nobody')).toBeUndefined()
  })
})

describe('the transcript', () => {
  test('comes back in the order it happened', () => {
    const journal = openJournal(repo, home)
    journal.append({ agentId: 'coder', kind: 'ask', text: 'fix it' })
    journal.append({ agentId: 'coder', kind: 'say', text: 'fixed' })
    journal.close()

    expect(openJournal(repo, home).transcript()).toEqual([
      { agentId: 'coder', kind: 'ask', text: 'fix it' },
      { agentId: 'coder', kind: 'say', text: 'fixed' },
    ])
  })

  // What `/clear` means. Forgetting dropped the conversation and kept every
  // line of it, so the word cleared what you could not see and left what you
  // could — and reopening the session brought back what it had cleared.
  test('forgetting an agent takes its lines with the conversation', () => {
    const journal = openJournal(repo, home)
    journal.append({ agentId: 'coder', kind: 'ask', text: 'fix it' })
    journal.append({ agentId: 'architect', kind: 'say', text: 'planned it' })

    journal.forget('coder')

    expect(journal.transcript()).toEqual([
      { agentId: 'architect', kind: 'say', text: 'planned it' },
    ])
  })

  test('and does not bring them back the next time it is opened', () => {
    const journal = openJournal(repo, home)
    journal.append({ agentId: 'coder', kind: 'ask', text: 'fix it' })
    journal.append({ agentId: 'architect', kind: 'say', text: 'planned it' })
    journal.forget('coder')
    journal.close()

    expect(openJournal(repo, home).transcript()).toEqual([
      { agentId: 'architect', kind: 'say', text: 'planned it' },
    ])
  })

  test('leaves what an agent says after being forgotten', () => {
    // Clearing is a line in the record, not a rewrite of it: what happens
    // after it happened after it.
    const journal = openJournal(repo, home)
    journal.append({ agentId: 'coder', kind: 'ask', text: 'fix it' })
    journal.forget('coder')
    journal.append({ agentId: 'coder', kind: 'note', text: 'starts again from here' })
    journal.close()

    expect(openJournal(repo, home).transcript()).toEqual([
      { agentId: 'coder', kind: 'note', text: 'starts again from here' },
    ])
  })
})

describe('surviving what actually goes wrong', () => {
  test('a half-written last line loses that line and nothing else', () => {
    // A machine losing power mid-write. Everything before is still good,
    // which is the whole reason for writing this way rather than rewriting a
    // row that has a moment when it has not been written yet.
    const journal = openJournal(repo, home)
    journal.remember('coder', [asked('one'), said('a')])
    journal.close()
    appendFileSync(journal.path, '{"type":"message","agentId":"coder","mess')

    const reopened = openJournal(repo, home)
    expect(reopened.messages('coder')).toEqual([asked('one'), said('a')])
  })

  test('a line of a kind it has never seen is skipped, not fatal', () => {
    const journal = openJournal(repo, home)
    journal.append({ agentId: 'coder', kind: 'say', text: 'hello' })
    journal.close()
    appendFileSync(journal.path, '{"type":"something-new","agentId":"coder","at":1}\n')

    expect(openJournal(repo, home).transcript()).toHaveLength(1)
  })

  test('writes nothing after close, rather than throwing on the way out', () => {
    const journal = openJournal(repo, home)
    journal.close()

    expect(() => journal.append({ agentId: 'a', kind: 'say', text: 'late' })).not.toThrow()
  })

  test('opening a project that has never been opened is empty, not an error', () => {
    const journal = openJournal(repo, home)

    expect(journal.transcript()).toEqual([])
    expect(journal.messages('anyone')).toEqual([])
  })
})

describe('coming from the database that used to hold this', () => {
  const older = {
    transcript: () => [
      { agentId: 'coder', kind: 'ask', text: 'fix it' },
      { agentId: 'coder', kind: 'say', text: 'fixed' },
    ],
    messages: (agentId: string) => (agentId === 'coder' ? [asked('fix it'), said('fixed')] : []),
    usageOf: () => ({ inputTokens: 500, outputTokens: 100 }),
  }

  test('brings the transcript, the conversation and the total across', () => {
    const journal = openJournal(repo, home)

    expect(importDatabase(journal, older)).toBe(2)
    journal.close()

    const reopened = openJournal(repo, home)
    expect(reopened.transcript()).toHaveLength(2)
    expect(reopened.messages('coder')).toHaveLength(2)
    expect(reopened.usageOf('coder')).toEqual({ inputTokens: 500, outputTokens: 100 })
  })

  test('does it once, so opening twice does not double everything', () => {
    const journal = openJournal(repo, home)
    importDatabase(journal, older)
    journal.close()

    const again = openJournal(repo, home)
    expect(importDatabase(again, older)).toBe(0)
    expect(again.transcript()).toHaveLength(2)
  })
})

describe('what a whole task has cost', () => {
  test('is kept apart from what each agent cost', () => {
    // An agent can be killed and its total go with it while the job carries
    // on, and "what did this piece of work cost" is the question people ask.
    const journal = openJournal(repo, home)
    journal.remember('auth/coder', [asked('go')], { inputTokens: 100, outputTokens: 20 })
    journal.rememberTask('auth', { inputTokens: 340, outputTokens: 90 })
    journal.close()

    const reopened = openJournal(repo, home)
    expect(reopened.usageOfTask('auth')).toEqual({ inputTokens: 340, outputTokens: 90 })
    expect(reopened.usageOf('auth/coder')).toEqual({ inputTokens: 100, outputTokens: 20 })
  })

  test('is written once when nothing has changed', () => {
    // Asked for on every redraw of the tasks screen, and every answer used to
    // go to disk: sixteen identical lines in seven seconds, on a record that
    // is meant to hold what happened.
    const journal = openJournal(repo, home)
    journal.rememberTask('auth', { inputTokens: 340, outputTokens: 90 })
    journal.rememberTask('auth', { inputTokens: 340, outputTokens: 90 })
    journal.rememberTask('auth', { inputTokens: 340, outputTokens: 90 })
    journal.rememberTask('auth', { inputTokens: 400, outputTokens: 90 })
    journal.close()

    const written = readFileSync(journal.path, 'utf8')
      .split('\n')
      .filter((line) => line.includes('"task-usage"'))
    expect(written).toHaveLength(2)
    expect(openJournal(repo, home).usageOfTask('auth')).toEqual({
      inputTokens: 400,
      outputTokens: 90,
    })
  })

  test('is nothing for a task that has not run', () => {
    expect(openJournal(repo, home).usageOfTask('nothing')).toBeUndefined()
  })
})

describe('knowing which project a record belongs to', () => {
  test('writes the path down, because the folder name cannot be read back', () => {
    // The directory is named by turning the path's separators into dashes,
    // which is not reversible: a project with a dash in its name reconstructs
    // to a different path, or to one that happens to exist. So the record says
    // where it came from, and nothing has to guess.
    const journal = openJournal(repo, home)
    journal.close()

    expect(readFileSync(join(dirname(journalPath(repo, home)), 'path'), 'utf8')).toBe(repo)
  })

  test('keeps reading a record written before the name carried a hash', () => {
    // A record is where somebody's afternoon went. Changing how its folder is
    // named must not leave every existing one behind, so the old name is
    // tried first and used when the note beside it says this project.
    const older = join(home, '.aidcrew', 'projects', repo.replace(/[/\\:]/g, '-'))
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, 'path'), repo)
    const entry = { type: 'message', agentId: 'coder', message: asked('from before'), at: 1 }
    writeFileSync(join(older, 'session.jsonl'), `${JSON.stringify(entry)}\n`)

    expect(journalPath(repo, home)).toBe(join(older, 'session.jsonl'))
    expect(openJournal(repo, home).messages('coder')).toEqual([asked('from before')])
  })

  test('does not adopt an older record whose note says it belongs to somewhere else', () => {
    // The old name for `/x/dev/tools` is the folder `/x/dev-tools` already
    // has. The note says whose it is, and the note is what to believe.
    const a = join(repo, 'dev-tools')
    const b = join(repo, 'dev', 'tools')
    mkdirSync(a)
    mkdirSync(b, { recursive: true })
    const older = join(home, '.aidcrew', 'projects', a.replace(/[/\\:]/g, '-'))
    mkdirSync(older, { recursive: true })
    writeFileSync(join(older, 'path'), a)

    expect(journalPath(a, home)).toBe(join(older, 'session.jsonl'))
    expect(journalPath(b, home)).not.toBe(join(older, 'session.jsonl'))
  })

  test('a record whose project is gone can be told from one whose is not', () => {
    // Which is the whole point: these hold tool output and the contents of
    // files that were read, and they accumulate for projects that no longer
    // exist with nothing showing them and nothing taking them away.
    openJournal(repo, home).close()
    const vanished = join(repo, 'went-away')
    mkdirSync(vanished, { recursive: true })
    openJournal(vanished, home).close()
    rmSync(vanished, { recursive: true, force: true })

    expect(orphanedRecords(home).map((one) => one.cwd)).toEqual([vanished])
  })
})
