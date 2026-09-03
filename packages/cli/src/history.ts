import { Database } from 'bun:sqlite'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { Message, Usage } from '@aidcrew/core'

/**
 * The session record, as an earlier version kept it.
 *
 * Superseded by `journal.ts`, which appends what happened rather than
 * rewriting the conversation as a row — measured at 0.05ms a turn against
 * 1.31ms by turn two hundred, and without the moment where a failed turn
 * leaves nothing written at all. This file is kept so a project opened with
 * the older version can have its record brought across once, by
 * `importDatabase`, and it should not be given anything new to hold.
 *
 * What follows is the note it was written with.
 *
 * What each agent has said, kept with the project.
 *
 * It lives next to the worktrees rather than in the home directory because a
 * conversation belongs to the work: clone the repo somewhere else and you are
 * starting fresh, which is right, while opening the same repo tomorrow should
 * find the team where you left it.
 *
 * Two things are kept and they are not the same. The transcript is what you
 * read — lines, in the order they appeared. The messages are what the model
 * reads — the canonical conversation, replaced whole after every instruction
 * because the loop rewrites what it holds as it goes.
 *
 * Nothing here is a search index. Harnesses that retrieve over their own
 * transcript answer "what did we decide about X" with a turn that merely looks
 * like the right one; the whole conversation goes back to the model, and when
 * it no longer fits the answer is compaction, not retrieval.
 */

export type Line = {
  agentId: string
  kind: string
  text: string
}

export type History = {
  path: string
  /** Every line ever shown, oldest first. */
  transcript(): Line[]
  append(line: Line): void
  /** One agent's conversation as the model last left it. */
  messages(agentId: string): Message[]
  /** What that agent had spent when it was last written down. */
  usageOf(agentId: string): Usage | undefined
  remember(agentId: string, messages: Message[], usage?: Usage): void
  /** Throws away everything for one agent, or for all of them. */
  forget(agentId?: string): void
  close(): void
}

export const HISTORY_FILE = join('.aidcrew', 'history.db')

const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE lines (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
    `CREATE TABLE conversations (
      agent_id TEXT PRIMARY KEY,
      messages TEXT NOT NULL,
      at INTEGER NOT NULL
    )`,
    'CREATE INDEX lines_by_agent ON lines (agent_id, seq)',
  ],
  // What each agent has spent, kept beside its conversation. Without it the
  // totals restart at zero every time the interface is reopened, so a figure
  // that should only ever climb appears never to move.
  ['ALTER TABLE conversations ADD COLUMN usage TEXT'],
]

export function openHistory(cwd: string): History {
  const path = join(cwd, HISTORY_FILE)
  mkdirSync(dirname(path), { recursive: true })
  protect(dirname(path))

  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL')
  // A conversation that survives everything except the crash that ended the
  // session is not a conversation that survives.
  db.exec('PRAGMA synchronous = FULL')
  migrate(db)

  /** Set on the way out, so a late line is dropped rather than thrown at. */
  let closed = false

  return {
    path,

    transcript() {
      const rows = db.query('SELECT agent_id, kind, text FROM lines ORDER BY seq').all() as {
        agent_id: string
        kind: string
        text: string
      }[]

      return rows.map((row) => ({ agentId: row.agent_id, kind: row.kind, text: row.text }))
    },

    append(line) {
      // Nothing is written after close. A turn ending while the program exits
      // would otherwise throw from a pump nobody is watching, and a line lost
      // on the way out is a smaller thing than a crash on the way out.
      if (closed) return
      db.query('INSERT INTO lines (agent_id, kind, text, at) VALUES (?, ?, ?, ?)').run(
        line.agentId,
        line.kind,
        line.text,
        Date.now(),
      )
    },

    messages(agentId) {
      const row = db
        .query('SELECT messages FROM conversations WHERE agent_id = ?')
        .get(agentId) as { messages: string } | null
      if (!row) return []

      try {
        const parsed = JSON.parse(row.messages) as unknown
        return Array.isArray(parsed) ? (parsed as Message[]) : []
      } catch {
        // A row that will not parse is a row from a version that wrote
        // something else. Losing the history beats refusing to start.
        return []
      }
    },

    usageOf(agentId) {
      const row = db.query('SELECT usage FROM conversations WHERE agent_id = ?').get(agentId) as {
        usage: string | null
      } | null
      if (!row?.usage) return undefined

      try {
        const parsed = JSON.parse(row.usage) as Usage
        return typeof parsed?.inputTokens === 'number' ? parsed : undefined
      } catch {
        return undefined
      }
    },

    remember(agentId, messages, usage) {
      db.query(
        `INSERT INTO conversations (agent_id, messages, usage, at) VALUES (?, ?, ?, ?)
         ON CONFLICT (agent_id) DO UPDATE SET
           messages = excluded.messages, usage = excluded.usage, at = excluded.at`,
      ).run(agentId, JSON.stringify(messages), usage ? JSON.stringify(usage) : null, Date.now())
    },

    forget(agentId) {
      if (agentId === undefined) {
        db.exec('DELETE FROM lines')
        db.exec('DELETE FROM conversations')
        return
      }
      db.query('DELETE FROM lines WHERE agent_id = ?').run(agentId)
      db.query('DELETE FROM conversations WHERE agent_id = ?').run(agentId)
    },

    close() {
      if (closed) return
      closed = true
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
      db.close()
    },
  }
}

/**
 * Numbered steps rather than `CREATE TABLE IF NOT EXISTS`.
 *
 * The lazy version leaves an old database with its old columns and reports the
 * mismatch as a missing column at the first query — on someone's real data,
 * which is where this was learned.
 */
function migrate(db: Database): void {
  const row = db.query('PRAGMA user_version').get() as { user_version: number } | null
  const at = row?.user_version ?? 0

  for (let step = at; step < MIGRATIONS.length; step++) {
    const statements = MIGRATIONS[step] as string[]
    db.transaction(() => {
      for (const statement of statements) db.exec(statement)
      db.exec(`PRAGMA user_version = ${step + 1}`)
    })()
  }
}

/**
 * Keeps the runtime state out of the repository, without anyone deciding to.
 *
 * `.aidcrew/` holds two kinds of thing side by side: the config and the agent
 * definitions, which are the point of committing it, and this database, which
 * is a binary file of every transcript line — tool output, and the contents of
 * whatever an agent read. Committed by accident it is both a guaranteed merge
 * conflict and a way for a private file to end up in a public repository.
 *
 * Written once, and never touched again: somebody who has edited it has
 * decided something, and this is not the place to argue.
 */
function protect(directory: string): void {
  const path = join(directory, '.gitignore')
  if (existsSync(path)) return

  writeFileSync(
    path,
    [
      '# Written by aidcrew. Runtime state, not project configuration.',
      '# The config and the agents next to this file are meant to be committed.',
      'history.db*',
      'ui.json',
      'wt/',
      '',
    ].join('\n'),
  )
}
