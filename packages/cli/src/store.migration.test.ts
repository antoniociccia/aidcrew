import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from './store.ts'

let home: string
const dbPath = () => join(home, '.aidcrew', 'aidcrew.db')

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-migrate-')))
  mkdirSync(join(home, '.aidcrew'), { recursive: true })
})

afterEach(() => rmSync(home, { recursive: true, force: true }))

/** The schema shipped before keys moved back into the database. */
function writeOldSchema(withRows = true): void {
  const db = new Database(dbPath(), { create: true })
  db.run(
    'CREATE TABLE secrets (scope TEXT PRIMARY KEY, backend TEXT NOT NULL, updated_at INTEGER NOT NULL)',
  )
  db.run(
    'CREATE TABLE workspaces (path TEXT PRIMARY KEY, name TEXT NOT NULL, last_opened INTEGER NOT NULL)',
  )
  db.run('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)')

  if (withRows) {
    db.run('INSERT INTO secrets VALUES (?, ?, ?)', ['provider:zen', 'keychain', 1])
    db.run('INSERT INTO workspaces VALUES (?, ?, ?)', ['/repos/api', 'api', 1])
    db.run('INSERT INTO settings VALUES (?, ?)', ['default.model', 'a-model'])
  }
  db.close()
}

describe('opening a database written by an older version', () => {
  test('does not fail on the missing column', () => {
    // The exact crash: "no such column: api_key", because CREATE TABLE
    // IF NOT EXISTS leaves an existing table exactly as it found it.
    writeOldSchema()

    const store = openStore(home)

    expect(() => store.knownSecrets()).not.toThrow()
    store.close()
  })

  test('keeps the projects and settings that were already there', () => {
    writeOldSchema()

    const store = openStore(home)

    expect(store.workspaces().map((w) => w.path)).toEqual(['/repos/api'])
    expect(store.get('default.model')).toBe('a-model')
    store.close()
  })

  test('drops the old key rows, which held no key to keep', () => {
    // The previous version stored only a note that a key existed elsewhere;
    // carrying those forward would list keys that are not there.
    writeOldSchema()

    const store = openStore(home)

    expect(store.knownSecrets()).toEqual([])
    store.close()
  })

  test('accepts a key afterwards, as a fresh database would', () => {
    writeOldSchema()
    const store = openStore(home)

    store.setCredential('provider:zen', { apiKey: 'a-new-key-1234' })

    expect(store.getCredential('provider:zen')?.apiKey).toBe('a-new-key-1234')
    store.close()
  })

  test('migrates only once, however many times it is opened', () => {
    writeOldSchema()

    openStore(home).close()
    const store = openStore(home)
    store.setCredential('provider:zen', { apiKey: 'kept-across-opens' })
    store.close()

    const reopened = openStore(home)
    expect(reopened.getCredential('provider:zen')?.apiKey).toBe('kept-across-opens')
    reopened.close()
  })

  test('leaves a current database untouched', () => {
    const first = openStore(home)
    first.setCredential('provider:zen', { apiKey: 'should-survive' })
    first.close()

    const second = openStore(home)

    expect(second.getCredential('provider:zen')?.apiKey).toBe('should-survive')
    second.close()
  })
})

describe('a database from before there was any schema at all', () => {
  test('creates everything from nothing', () => {
    const store = openStore(home)

    expect(store.knownSecrets()).toEqual([])
    expect(store.workspaces()).toEqual([])
    store.close()
  })
})
