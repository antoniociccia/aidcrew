// Every run, its events, checkpoints and model exchanges in one SQLite file.
// Values only ever reach SQL as bound parameters.
import { Database, type SQLQueryBindings } from 'bun:sqlite'
import type {
  ExchangeRecord,
  LabSnapshot,
  RunConfig,
  RunStatus,
  RunStore,
  WorldEvent,
} from '../contracts.ts'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  config TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  path TEXT NOT NULL,
  type TEXT NOT NULL,
  agent_id TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_run_tick ON events (run_id, tick);
CREATE TABLE IF NOT EXISTS checkpoints (
  run_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  snapshot TEXT NOT NULL,
  PRIMARY KEY (run_id, tick)
);
CREATE TABLE IF NOT EXISTS exchanges (
  run_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  tick INTEGER NOT NULL,
  path TEXT NOT NULL,
  request TEXT NOT NULL,
  response TEXT NOT NULL,
  usage TEXT,
  PRIMARY KEY (run_id, agent_id, tick, path)
);
`

interface EventRow {
  tick: number
  seq: number
  path: string
  type: WorldEvent['type']
  agent_id: string | null
  payload: string
}

interface ExchangeRow {
  run_id: string
  agent_id: string
  tick: number
  path: string
  request: string
  response: string
  usage: string | null
}

export function openStore(path: string): RunStore & { close(): void } {
  const db = new Database(path, { create: true })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec(SCHEMA)

  const insertEvent = db.query(
    'INSERT INTO events (run_id, tick, seq, path, type, agent_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
  const appendAll = db.transaction((runId: string, events: WorldEvent[]) => {
    for (const e of events) {
      insertEvent.run(runId, e.tick, e.seq, e.path, e.type, e.agentId, JSON.stringify(e.payload))
    }
  })

  return {
    createRun(config) {
      const id = crypto.randomUUID()
      db.query('INSERT INTO runs (id, config, status, created_at) VALUES (?, ?, ?, ?)').run(
        id,
        JSON.stringify(config),
        'running',
        new Date().toISOString(),
      )
      return id
    },
    setStatus(runId, status) {
      db.query('UPDATE runs SET status = ? WHERE id = ?').run(status, runId)
    },
    run(runId) {
      const row = db
        .query<{ config: string; status: RunStatus }, [string]>(
          'SELECT config, status FROM runs WHERE id = ?',
        )
        .get(runId)
      return row ? { config: JSON.parse(row.config) as RunConfig, status: row.status } : null
    },
    runs() {
      return db
        .query<{ id: string; config: string; status: RunStatus; created_at: string }, []>(
          'SELECT id, config, status, created_at FROM runs ORDER BY created_at DESC, rowid DESC',
        )
        .all()
        .map((r) => ({
          runId: r.id,
          config: JSON.parse(r.config) as RunConfig,
          status: r.status,
          createdAt: r.created_at,
        }))
    },
    appendEvents(runId, events) {
      appendAll(runId, events)
    },
    events(runId, filter = {}) {
      const where = ['run_id = ?']
      const args: SQLQueryBindings[] = [runId]
      if (filter.path !== undefined) {
        where.push('path = ?')
        args.push(filter.path)
      }
      if (filter.type !== undefined) {
        where.push('type = ?')
        args.push(filter.type)
      }
      if (filter.agentId !== undefined) {
        where.push('agent_id = ?')
        args.push(filter.agentId)
      }
      if (filter.fromTick !== undefined) {
        where.push('tick >= ?')
        args.push(filter.fromTick)
      }
      if (filter.toTick !== undefined) {
        where.push('tick <= ?')
        args.push(filter.toTick)
      }
      return db
        .query<EventRow, SQLQueryBindings[]>(
          `SELECT tick, seq, path, type, agent_id, payload FROM events WHERE ${where.join(' AND ')} ORDER BY id`,
        )
        .all(...args)
        .map((r) => ({
          tick: r.tick,
          seq: r.seq,
          path: r.path,
          type: r.type,
          agentId: r.agent_id,
          payload: JSON.parse(r.payload) as Record<string, unknown>,
        }))
    },
    deleteEventsFrom(runId, fromTick) {
      db.query('DELETE FROM events WHERE run_id = ? AND tick >= ?').run(runId, fromTick)
    },
    saveCheckpoint(runId, tick, snapshot) {
      db.query('INSERT OR REPLACE INTO checkpoints (run_id, tick, snapshot) VALUES (?, ?, ?)').run(
        runId,
        tick,
        JSON.stringify(snapshot),
      )
    },
    latestCheckpoint(runId) {
      const row = db
        .query<{ tick: number; snapshot: string }, [string]>(
          'SELECT tick, snapshot FROM checkpoints WHERE run_id = ? ORDER BY tick DESC LIMIT 1',
        )
        .get(runId)
      return row ? { tick: row.tick, snapshot: JSON.parse(row.snapshot) as LabSnapshot } : null
    },
    recordExchange(r) {
      db.query(
        'INSERT OR REPLACE INTO exchanges (run_id, agent_id, tick, path, request, response, usage) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(
        r.runId,
        r.agentId,
        r.tick,
        r.path,
        JSON.stringify(r.request),
        r.response,
        r.usage ? JSON.stringify(r.usage) : null,
      )
    },
    findExchange(runId, agentId, tick, path) {
      const row = db
        .query<ExchangeRow, [string, string, number, string]>(
          'SELECT * FROM exchanges WHERE run_id = ? AND agent_id = ? AND tick = ? AND path = ?',
        )
        .get(runId, agentId, tick, path)
      if (!row) return null
      const record: ExchangeRecord = {
        runId: row.run_id,
        agentId: row.agent_id,
        tick: row.tick,
        path: row.path,
        request: JSON.parse(row.request) as unknown,
        response: row.response,
        usage: row.usage ? (JSON.parse(row.usage) as ExchangeRecord['usage']) : null,
      }
      return record
    },
    close() {
      db.close()
    },
  }
}
