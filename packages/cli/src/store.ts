import { Database } from 'bun:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What aidcrew remembers between sessions.
 *
 * Keys included. They sit in the clear, the way ~/.aws/credentials and
 * ~/.npmrc do; the file is owner-readable only and nothing ever prints a key
 * back out, not even in a listing.
 *
 * SQLite because Bun ships it — no dependency, no daemon, one file — and
 * because a settings screen writes single fields, which a TOML file cannot do
 * without rewriting and reformatting the whole thing.
 */

export type Credential = {
  apiKey: string
  baseUrl?: string
}

/** What a settings screen may show: everything except the key itself. */
export type KnownSecret = {
  scope: string
  /** Last few characters, enough to tell two keys apart and no more. */
  hint: string
  baseUrl?: string
  updatedAt: number
}

export type Workspace = {
  path: string
  /** What to call it on screen; the directory name unless renamed. */
  name: string
  lastOpened: number
}

export type SettingsStore = {
  readonly path: string

  setCredential(scope: string, credential: Credential): void
  getCredential(scope: string): Credential | undefined
  forgetSecret(scope: string): void
  knownSecrets(): KnownSecret[]

  rememberWorkspace(path: string, name?: string): void
  forgetWorkspace(path: string): void
  workspaces(): Workspace[]

  set(key: string, value: string): void
  get(key: string): string | undefined
  list(): { key: string; value: string }[]
  unset(key: string): void

  close(): void
}

/**
 * Schema changes, in order, applied to whatever version a database is at.
 *
 * Needed because `CREATE TABLE IF NOT EXISTS` leaves an existing table exactly
 * as it found it: a database written by an older version kept its old columns
 * and every query against a new one failed. SQLite's `user_version` records
 * how far a file has come, so each change runs once and only once.
 *
 * Never edit a migration that has shipped — add another one. Someone's
 * database is already at that version.
 */
const MIGRATIONS: ((db: Database) => void)[] = [
  // 1 — the original tables.
  (db) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS workspaces (
        path TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        last_opened INTEGER NOT NULL
      )
    `)
    db.run(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `)
  },

  // 2 — keys live here again, so `secrets` holds the key rather than a note
  //     about where it was kept. The old rows carried no key to preserve.
  (db) => {
    db.run('DROP TABLE IF EXISTS secrets')
    db.run(`
      CREATE TABLE secrets (
        scope TEXT PRIMARY KEY,
        api_key TEXT NOT NULL,
        base_url TEXT,
        updated_at INTEGER NOT NULL
      )
    `)
  },
]

function migrate(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const applied = row?.user_version ?? 0

  // One transaction: a half-migrated database is worse than an old one.
  db.transaction(() => {
    for (let version = applied; version < MIGRATIONS.length; version++) {
      MIGRATIONS[version]?.(db)
    }
    db.run(`PRAGMA user_version = ${MIGRATIONS.length}`)
  })()
}

export function openStore(home: string): SettingsStore {
  const directory = join(home, '.aidcrew')
  // The same mode the session record asks for, and for a stronger reason: this
  // directory holds the keys. Locking the file and leaving the directory open
  // still tells anyone on the machine what is in here and when it was last
  // touched. An existing directory with other permissions is the user's
  // business, which is why this is not a chmod.
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, 'aidcrew.db')

  const db = new Database(path, { create: true })
  // Set before anything is written: this file records what a person works on
  // and which services they use, which is nobody else's business.
  chmodSync(path, 0o600)

  db.run('PRAGMA journal_mode = WAL')
  migrate(db)

  // Written through on every commit. WAL is faster the other way, but a
  // settings file that loses the last change when the terminal is closed with
  // ^C is worse than a settings file that writes a few milliseconds slower.
  db.run('PRAGMA synchronous = FULL')

  return {
    path,

    setCredential(scope, credential) {
      if (credential.apiKey.trim() === '') {
        throw new Error(`refusing to store an empty key for ${scope}`)
      }
      db.run(
        `INSERT INTO secrets (scope, api_key, base_url, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           api_key = excluded.api_key,
           base_url = excluded.base_url,
           updated_at = excluded.updated_at`,
        [scope, credential.apiKey, credential.baseUrl ?? null, Date.now()],
      )
    },

    getCredential(scope) {
      const row = db.query('SELECT api_key, base_url FROM secrets WHERE scope = ?').get(scope) as {
        api_key: string
        base_url: string | null
      } | null

      if (!row) return undefined
      return { apiKey: row.api_key, ...(row.base_url ? { baseUrl: row.base_url } : {}) }
    },

    forgetSecret(scope) {
      db.run('DELETE FROM secrets WHERE scope = ?', [scope])
    },

    /** Never returns a key: a list is for showing on screen. */
    knownSecrets() {
      const rows = db
        .query('SELECT scope, api_key, base_url, updated_at FROM secrets ORDER BY scope')
        .all() as { scope: string; api_key: string; base_url: string | null; updated_at: number }[]

      return rows.map((row) => ({
        scope: row.scope,
        hint: row.api_key.length < 12 ? '••••' : `••••${row.api_key.slice(-4)}`,
        ...(row.base_url ? { baseUrl: row.base_url } : {}),
        updatedAt: row.updated_at,
      }))
    },

    rememberWorkspace(path, name) {
      db.run(
        `INSERT INTO workspaces (path, name, last_opened) VALUES (?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name, last_opened = excluded.last_opened`,
        [path, name ?? basenameOf(path), Date.now()],
      )
    },

    forgetWorkspace(path) {
      db.run('DELETE FROM workspaces WHERE path = ?', [path])
    },

    /** Most recently opened first: that is the order a switcher wants. */
    workspaces() {
      const rows = db
        .query('SELECT path, name, last_opened FROM workspaces ORDER BY last_opened DESC')
        .all() as { path: string; name: string; last_opened: number }[]

      return rows.map((row) => ({
        path: row.path,
        name: row.name,
        lastOpened: row.last_opened,
      }))
    },

    set(key, value) {
      db.run(
        `INSERT INTO settings (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [key, value],
      )
    },

    get(key) {
      const row = db.query('SELECT value FROM settings WHERE key = ?').get(key) as {
        value: string
      } | null
      return row?.value
    },

    list() {
      return db.query('SELECT key, value FROM settings ORDER BY key').all() as {
        key: string
        value: string
      }[]
    },

    unset(key) {
      db.run('DELETE FROM settings WHERE key = ?', [key])
    },

    close() {
      // Folds the write-ahead log back into the database, so what was saved
      // is in the file itself rather than only in a sidecar next to it.
      try {
        db.run('PRAGMA wal_checkpoint(TRUNCATE)')
      } catch {
        // A checkpoint that fails costs nothing: the data is still in the WAL.
      }
      db.close()
    },
  }
}

function basenameOf(path: string): string {
  return path.split('/').filter(Boolean).at(-1) ?? path
}
