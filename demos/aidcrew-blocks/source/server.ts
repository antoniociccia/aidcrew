import { Database } from "bun:sqlite";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { generateTerrain } from "./shared/terrain.js";

const PORT = Number(process.env.PORT ?? 8787);
const DB_PATH = process.env.DB_PATH ?? join(process.cwd(), "data", "world.sqlite");
const WORLD_SEED = Number(process.env.WORLD_SEED ?? 1337);
const CHECKPOINT_INTERVAL = Number(process.env.CHECKPOINT_INTERVAL ?? 5); // seconds

mkdirSync(dirname(DB_PATH), { recursive: true }); // fresh installs: data/ may not exist
const db = new Database(DB_PATH, { create: true });
db.run("CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, nickname TEXT, color TEXT, last_seen INTEGER)");
db.run(`CREATE TABLE IF NOT EXISTS sessions (
  pid TEXT PRIMARY KEY REFERENCES players(id),
  x REAL, y REAL, z REAL, yaw REAL, pitch REAL, selected INTEGER
)`);
db.run(`CREATE TABLE IF NOT EXISTS edits (
  x INTEGER NOT NULL, y INTEGER NOT NULL, z INTEGER NOT NULL,
  block TEXT, -- NULL = removed
  PRIMARY KEY (x, y, z)
)`);
db.run(`CREATE TABLE IF NOT EXISTS identities (
  token TEXT PRIMARY KEY, -- random, hashed here
  pid TEXT REFERENCES players(id)
)`);
db.run(`CREATE TABLE IF NOT EXISTS fragments (
  idx INTEGER PRIMARY KEY, -- 0..2
  collected_by TEXT REFERENCES players(id),
  collected_at INTEGER
)`);
db.run(`CREATE TABLE IF NOT EXISTS beacon (id INTEGER PRIMARY KEY CHECK (id=1), lit INTEGER DEFAULT 0, lit_by TEXT, lit_at INTEGER)`);

const COLORS = ["#ff5d5d", "#ffc84a", "#6ee86e", "#5db8ff", "#c07dff", "#ff8ad8"];
function colorFor(n: number) { return COLORS[n % COLORS.length]; }

const BLOCK_NAMES = new Set(["grass", "stone", "wood", "sand"]);
const BOUND = 48, Y_MIN = -32, Y_MAX = 40;

const editRows = db.query("SELECT x, y, z, block FROM edits").all();

const clients = new Map<unknown, { name: string; color: string; pid: string; pos: { x: number; y: number; z: number } | null }>();

const server = Bun.serve({
  port: PORT,
  websocket: {
    open(ws) {
      ws.data.color = colorFor(clients.size);
    },
    async message(ws, raw) {
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (typeof raw !== "string" && !(raw instanceof Buffer && raw.length < 4096)) return;

      // resume: client sends stored token; server matches identity
      if (msg?.type === "join" && typeof msg.nickname === "string" && msg.nickname.length <= 24) {
        let player: { id: string; nickname: string; color: string } | null = null;
        let authed = false;
        // token resume path: the ONLY way to reclaim an existing pid
        if (typeof msg.token === "string" && /^[a-f0-9]{64}$/.test(msg.token)) {
          const h = await hashToken(msg.token);
          const row = db.query("SELECT pid FROM identities WHERE token=?").get(h) as any;
          if (row) {
            player = db.query("SELECT id, nickname, color FROM players WHERE id=?").get(row.pid) as any;
            authed = !!player;
          }
        }
        // nickname is display-only: tokenless or invalid-token joins always create a fresh pid
        if (!player) {
          const id = crypto.randomUUID();
          const nickname = msg.nickname.trim().slice(0, 24) || "Guest";
          // pick a color no persisted player has, falling back through the palette
          const used = new Set((db.query("SELECT DISTINCT color FROM players").all() as any[]).map(r => r.color));
          const color = COLORS.find(c => !used.has(c)) ?? colorFor(used.size);
          db.query("INSERT INTO players (id, nickname, color, last_seen) VALUES (?, ?, ?, ?)").run(id, nickname, color, Date.now());
          player = { id, nickname, color };
        }
        db.query("UPDATE players SET last_seen=? WHERE id=?").run(Date.now(), player.id);

        const taken = new Set([...clients.values()].map(c => c.name));
        let name = player.nickname;
        while (taken.has(name)) name = name + "-2";
        ws.data.name = name;
        ws.data.color = player.color;
        ws.data.pid = player.id;
        ws.data.pos = null;
        clients.set(ws, ws.data);

        const sess = db.query("SELECT x, y, z, yaw, pitch, selected FROM sessions WHERE pid=?").get(player.id) as any;
        // issue a fresh token whenever this connection was not authenticated by a valid token
        let token: string | null = null;
        if (!authed) {
          token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
          db.query("INSERT OR REPLACE INTO identities (token, pid) VALUES (?, ?)").run(await hashToken(token), player.id);
        }

        ws.send(JSON.stringify({
          type: "joined", name, color: player.color, seed: WORLD_SEED,
          resume: !!sess, pos: sess ? { x: sess.x, y: sess.y, z: sess.z, yaw: sess.yaw, pitch: sess.pitch } : null,
          selected: sess?.selected ?? null, token,
        }));
        ws.subscribe("world");
        const editRows = db.query("SELECT x, y, z, block FROM edits").all();
        const frags = db.query("SELECT idx, collected_by FROM fragments WHERE collected_by IS NOT NULL").all().map((r: any) => r.idx);
        const bcn = db.query("SELECT lit FROM beacon WHERE id=1").get() as any;
        ws.send(JSON.stringify({ type: "init", edits: editRows, resume: !!sess, fragments: frags, beaconLit: !!(bcn?.lit) }));
        server.publish("world", JSON.stringify({ type: "presence", players: [...clients.values()] }));
        return;
      }
      if (!ws.data.name) return;

      if (msg?.type === "edit") {
        const { action, x, y, z, block } = msg;
        if (action !== "place" && action !== "break") return reject(ws, msg, "Unknown action");
        if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return reject(ws, msg, "Bad coordinates");
        if (Math.abs(x) > BOUND || Math.abs(z) > BOUND || y < Y_MIN || y > Y_MAX) return reject(ws, msg, "Out of bounds");
        if (action === "place") {
          if (typeof block !== "string" || !BLOCK_NAMES.has(block)) return reject(ws, msg, "Unknown block");
          if (blockAt(x, y, z)) return reject(ws, msg, "Block occupied");
          if (!hasNeighbor(x, y, z)) return reject(ws, msg, "Must touch an existing block");
          accept(ws, { action, x, y, z, block });
        } else {
          if (!blockAt(x, y, z)) return reject(ws, msg, "Nothing to break there");
          accept(ws, { action, x, y, z, block: null, removed: terrainBlockAt(x, y, z) !== null });
        }
        return;
      }
      if (msg?.type === "checkpoint") {
        const { x, y, z, yaw, pitch, selected } = msg;
        if (![x, y, z, yaw, pitch].every(Number.isFinite) || !Number.isInteger(selected)) return;
        db.query(`INSERT OR REPLACE INTO sessions (pid, x, y, z, yaw, pitch, selected) VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(ws.data.pid, x, y, z, yaw, pitch, selected);
        return;
      }
      if (msg?.type === "emote" && msg.kind === "wave") {
        server.publish("world", JSON.stringify({ type: "emote", name: ws.data.name, color: ws.data.color }));
        return;
      }
      if (msg?.type === "collect-fragment") {
        const { idx } = msg;
        const spot = FRAGMENT_SPOTS[idx];
        if (!spot) return reject(ws, msg, "Unknown fragment");
        // authoritative proximity: measured against the server-tracked position from state messages
        const p = ws.data.pos;
        if (!p) return reject(ws, msg, "No position reported yet");
        const dist = Math.hypot(p.x - spot.x, p.y - spot.y, p.z - spot.z);
        if (dist > 4) return reject(ws, msg, "Too far from fragment");
        const taken = db.query("SELECT collected_by FROM fragments WHERE idx=?").get(idx) as any;
        if (taken?.collected_by) return reject(ws, msg, "Fragment already collected");
        db.query("UPDATE fragments SET collected_by=?, collected_at=? WHERE idx=? AND collected_by IS NULL").run(ws.data.pid, Date.now(), idx);
        const count = (db.query("SELECT COUNT(*) AS n FROM fragments WHERE collected_by IS NOT NULL").get() as any).n;
        server.publish("world", JSON.stringify({
          type: "fragment-collected", idx, name: ws.data.name, count,
        }));
        return;
      }
      if (msg?.type === "activate-beacon") {
        const lit = (db.query("SELECT lit FROM beacon WHERE id=1").get() as any).lit;
        if (lit) return reject(ws, msg, "Beacon already lit");
        const count = (db.query("SELECT COUNT(*) AS n FROM fragments WHERE collected_by IS NOT NULL").get() as any).n;
        if (count < FRAGMENT_SPOTS.length) return reject(ws, msg, `Need all ${FRAGMENT_SPOTS.length} fragments (${count}/${FRAGMENT_SPOTS.length})`);
        db.query("UPDATE beacon SET lit=1, lit_by=?, lit_at=? WHERE id=1").run(ws.data.pid, Date.now());
        server.publish("world", JSON.stringify({ type: "beacon-lit", name: ws.data.name }));
        return;
      }
      if (msg?.type === "state" && ws.data.name) {
        const { x, y, z, yaw, pitch } = msg;
        if (![x, y, z, yaw, pitch].every(Number.isFinite)) return;
        ws.data.pos = { x, y, z };
        server.publish("world", JSON.stringify({
          type: "player-state", name: ws.data.name, color: ws.data.color,
          x, y, z, yaw, pitch,
        }));
        return;
      }
      if (msg?.type === "ping") ws.send(JSON.stringify({ type: "pong" }));
    },
    close(ws) {
      clients.delete(ws);
      server.publish("world", JSON.stringify({ type: "presence", players: [...clients.values()] }));
    },
  },
  async fetch(req, srv) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      if (srv.upgrade(req, { data: { name: null, color: null } })) return;
      return new Response("upgrade failed", { status: 400 });
    }
    const path = url.pathname === "/" ? "/index.html" : url.pathname;

    // QR recovery API. Credential flows only in POST bodies — never logged in URLs/access logs.
    if (path === "/recover" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const cred = typeof body?.credential === "string" ? body.credential.trim() : "";
      if (!/^[a-f0-9]{64}$/.test(cred)) return Response.json({ ok: false, error: "Malformed credential" }, { status: 400 });
      const h = await hashToken(cred);
      const row = db.query("SELECT pid FROM identities WHERE token=?").get(h) as any;
      if (!row) return Response.json({ ok: false, error: "Credential not recognized — it may have been revoked or regenerated" }, { status: 404 });
      const player = db.query("SELECT id, nickname FROM players WHERE id=?").get(row.pid) as any;
      if (!player) return Response.json({ ok: false, error: "Player no longer exists" }, { status: 404 });
      // exchange: consume the QR credential, issue a fresh token bound to same pid
      db.query("DELETE FROM identities WHERE token=?").run(h);
      const token = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
      db.query("INSERT OR REPLACE INTO identities (token, pid) VALUES (?, ?)").run(await hashToken(token), player.id);
      return Response.json({ ok: true, token, nickname: player.nickname });
    }
    if (path === "/revoke" && req.method === "POST") {
      const body = await req.json().catch(() => null);
      const token = typeof body?.token === "string" ? body.token : "";
      if (!/^[a-f0-9]{64}$/.test(token)) return Response.json({ ok: false, error: "Malformed token" }, { status: 400 });
      const h = await hashToken(token);
      const row = db.query("SELECT pid FROM identities WHERE token=?").get(h) as any;
      if (!row) return Response.json({ ok: false, error: "Unknown token" }, { status: 404 });
      // atomic rotation: consume the presented credential and issue a fresh token for the SAME player
      const fresh = [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
      const freshHash = await hashToken(fresh);
      db.transaction(() => {
        db.query("DELETE FROM identities WHERE pid=?").run(row.pid);
        db.query("INSERT INTO identities (token, pid) VALUES (?, ?)").run(freshHash, row.pid);
      })();
      return Response.json({ ok: true, token: fresh });
    }
    if (path === "/recover-info" && req.method === "POST") {
      // preview a credential's player without consuming it (shows name before confirming exchange)
      const body = await req.json().catch(() => null);
      const cred = typeof body?.credential === "string" ? body.credential.trim() : "";
      if (!/^[a-f0-9]{64}$/.test(cred)) return Response.json({ ok: false, error: "Malformed credential" }, { status: 400 });
      const row = db.query("SELECT pid FROM identities WHERE token=?").get(await hashToken(cred)) as any;
      if (!row) return Response.json({ ok: false, error: "Credential not recognized" }, { status: 404 });
      const player = db.query("SELECT nickname, color FROM players WHERE id=?").get(row.pid) as any;
      return Response.json({ ok: true, nickname: player?.nickname, color: player?.color });
    }

    if (path.startsWith("/shared/")) {
      const f = Bun.file(join(import.meta.dir, path));
      if (await f.exists()) return new Response(f);
      return new Response("not found", { status: 404 });
    }
    const file = Bun.file(join(import.meta.dir, "public", path));
    if (await file.exists()) return new Response(file);
    return new Response("not found", { status: 404 });
  },
});

// Base terrain is generated deterministically from the same shared module as the client;
// the edits table layers player changes on top. Server is full edit authority.
const { world: baseTerrain, FRAGMENT_SPOTS } = generateTerrain();
for (let i = 0; i < FRAGMENT_SPOTS.length; i++) {
  db.run("INSERT OR IGNORE INTO fragments (idx) VALUES (?)", [i]);
}
db.run("INSERT OR IGNORE INTO beacon (id, lit) VALUES (1, 0)");
function terrainBlockAt(x: number, y: number, z: number): string | null {
  return baseTerrain.get(x + "," + y + "," + z) ?? null;
}
function blockAt(x: number, y: number, z: number): string | null {
  const row = db.query("SELECT block FROM edits WHERE x=? AND y=? AND z=?").get(x, y, z) as any;
  if (row) return row.block; // NULL block = broken
  return terrainBlockAt(x, y, z);
}
function hasNeighbor(x: number, y: number, z: number): boolean {
  return !!(
    blockAt(x + 1, y, z) || blockAt(x - 1, y, z) || blockAt(x, y + 1, z) ||
    blockAt(x, y - 1, z) || blockAt(x, y, z + 1) || blockAt(x, y, z - 1)
  );
}
function reject(ws: any, msg0: any, reason: string) {
  ws.send(JSON.stringify({ type: "edit-rejected", reason, x: msg0?.x, y: msg0?.y, z: msg0?.z }));
}
function accept(ws: any, edit: any) {
  db.transaction(() => {
    if (edit.action === "break" && edit.removed) {
      db.query("DELETE FROM edits WHERE x=? AND y=? AND z=?").run(edit.x, edit.y, edit.z);
      db.query("INSERT OR REPLACE INTO edits (x, y, z, block) VALUES (?, ?, ?, NULL)").run(edit.x, edit.y, edit.z);
    } else {
      db.query("INSERT OR REPLACE INTO edits (x, y, z, block) VALUES (?, ?, ?, ?)").run(edit.x, edit.y, edit.z, edit.block);
    }
    db.query("UPDATE players SET last_seen=? WHERE id=?").run(Date.now(), ws.data.pid);
  })();
  server.publish("world", JSON.stringify({ type: "edit-accepted", ...edit, by: ws.data.name }));
}
async function hashToken(t: string) {
  return Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t))).toString("hex");
}

console.log(`Skyforge Islands dev server on http://localhost:${PORT} (db: ${DB_PATH}, seed: ${WORLD_SEED}, persisted edits: ${editRows.length}, checkpoint: ${CHECKPOINT_INTERVAL}s)`);