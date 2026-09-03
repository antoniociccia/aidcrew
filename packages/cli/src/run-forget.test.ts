import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { journalPath, openJournal } from './journal.ts'
import { runForget } from './run-forget.ts'
import { pluginTrustKey } from './run-plugins.ts'
import { projectTrustKey } from './run-project.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'

let home: string
let out: string[]
let store: SettingsStore

const io = () => ({ write: (text: string) => out.push(text), writeError: () => {} })

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-forget-')))
  store = openStore(home)
  out = []
})

afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

/** A project that was opened once, given permissions, and then deleted. */
function vanished(): string {
  const where = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-gone-')))
  openJournal(where, home).close()
  store.set(pluginTrustKey(where, 'ticket'), 'allow')
  store.set(projectTrustKey(where, 'agents.coder.yolo'), 'allow')
  const record = journalPath(where, home)
  rmSync(where, { recursive: true, force: true })
  return record
}

describe('what a project leaves behind when it is deleted', () => {
  test('goes, all of it: the transcript and every permission it was given', async () => {
    // One fact rather than two. The transcript holds tool output and the
    // contents of files that were read, so a record for a project you deleted
    // is a copy of it in your home directory — and the permissions are
    // answers to questions nobody will ever ask again.
    const record = vanished()

    expect(await runForget(store, io(), home)).toBe(0)

    expect(existsSync(dirname(record))).toBe(false)
    expect(store.list().filter((one) => one.key.includes('.trust.'))).toEqual([])
  })

  test('leaves alone what belongs to a project that is still there', async () => {
    const here = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-here-')))
    try {
      openJournal(here, home).close()
      store.set(pluginTrustKey(here, 'ticket'), 'allow')

      await runForget(store, io(), home)

      expect(existsSync(dirname(journalPath(here, home)))).toBe(true)
      expect(store.get(pluginTrustKey(here, 'ticket'))).toBe('allow')
    } finally {
      rmSync(here, { recursive: true, force: true })
    }
  })

  test('leaves alone a project whose path merely begins with a deleted one', async () => {
    // Deleting `/x/app` took the permissions of `/x/app2` with it: a key was
    // stale if the deleted path appeared anywhere in it, and it appears in
    // every key of every project whose name begins the same way.
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-pair-')))
    try {
      const gone = join(parent, 'app')
      const here = join(parent, 'app2')
      mkdirSync(gone)
      mkdirSync(here)
      openJournal(gone, home).close()
      store.set(pluginTrustKey(here, 'ticket'), 'allow')
      store.set(projectTrustKey(here, 'agents.coder.yolo'), 'allow')
      rmSync(gone, { recursive: true, force: true })

      await runForget(store, io(), home)

      expect(store.get(pluginTrustKey(here, 'ticket'))).toBe('allow')
      expect(store.get(projectTrustKey(here, 'agents.coder.yolo'))).toBe('allow')
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('deleting one project does not take the transcript of one that shares its name', async () => {
    // `/x/dev-tools` and `/x/dev/tools` shared one record. Deleting the second
    // made that record an orphan, and forgetting it took the first project's
    // transcript while the first project was still there.
    const parent = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-pair-')))
    try {
      const kept = join(parent, 'dev-tools')
      const gone = join(parent, 'dev', 'tools')
      mkdirSync(kept)
      mkdirSync(gone, { recursive: true })
      openJournal(kept, home).close()
      openJournal(gone, home).close()
      rmSync(gone, { recursive: true, force: true })

      await runForget(store, io(), home)

      expect(existsSync(dirname(journalPath(kept, home)))).toBe(true)
    } finally {
      rmSync(parent, { recursive: true, force: true })
    }
  })

  test('says what it could not tell about rather than guessing', async () => {
    // A record written before the path was kept beside it says nothing about
    // where it came from, and the folder name cannot be read back — the
    // separators became dashes. Counted and named, never deleted on a guess.
    mkdirSync(join(home, '.aidcrew', 'projects', '-somewhere-old'), { recursive: true })
    vanished()

    await runForget(store, io(), home)

    expect(out.join('')).toMatch(/1 (record|older)/i)
    expect(existsSync(join(home, '.aidcrew', 'projects', '-somewhere-old'))).toBe(true)
  })

  test('says plainly when there is nothing to take', async () => {
    expect(await runForget(store, io(), home)).toBe(0)

    expect(out.join('')).toMatch(/nothing/i)
  })
})

describe('starting a project over', () => {
  test('takes its transcript, leaving the project alone', async () => {
    // Three times in one evening this was done by hand, with `rm`, on a path
    // worked out from the project name. `forget` takes what deleted projects
    // left behind and `/clear` takes one agent's conversation; beginning again
    // on a project that still exists had nothing at all.
    const here = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-here-')))
    try {
      const journal = openJournal(here, home)
      journal.append({ agentId: 'coder', kind: 'say', text: 'something was said' })
      journal.close()
      // The folder, which is what holds the transcript and the note saying
      // which project it belongs to.
      const record = dirname(journalPath(here, home))
      expect(existsSync(record)).toBe(true)

      expect(await runForget(store, io(), home, here)).toBe(0)

      expect(existsSync(record)).toBe(false)
      // The project itself, and what it was trusted with, are untouched: this
      // forgets what was said, not what was decided.
      expect(existsSync(here)).toBe(true)
    } finally {
      rmSync(here, { recursive: true, force: true })
    }
  })

  test('says so when it has nothing to take', async () => {
    const here = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-empty-')))
    try {
      expect(await runForget(store, io(), home, here)).toBe(0)
      expect(out.join('')).toMatch(/nothing|no transcript/i)
    } finally {
      rmSync(here, { recursive: true, force: true })
    }
  })
})
