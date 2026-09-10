// Persistence + identity automated check: bun test/persistence.test.ts
// Fully isolated: spawns its own server on a temp port with a temp DB via a
// child Bun process. Never touches the canonical preview or its database.
import { afterAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import { FRAGMENT_SPOTS } from "../shared/terrain.js";

const tmp = mkdtempSync(join(tmpdir(), "skyforge-test-"));
const DB_PATH = join(tmp, "test.sqlite");
const PORT = 8795;
const BASE = `ws://localhost:${PORT}/ws`;
const HTTP = `http://localhost:${PORT}`;

const proc = spawn("bun", [join(import.meta.dir, "..", "server.ts")], {
  env: { ...process.env, PORT: String(PORT), DB_PATH },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
proc.stdout.on("data", (d) => (serverLog += d));
proc.stderr.on("data", (d) => (serverLog += d));

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${HTTP}/shared/terrain.js`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("test server never became ready\n" + serverLog);
}
await waitReady();

function connect(nickname: string, token?: string) {
  return new Promise<{ ws: WebSocket; out: any[] }>((resolve) => {
    const ws = new WebSocket(BASE);
    const out: any[] = [];
    ws.onmessage = (e) => out.push(JSON.parse(e.data));
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", nickname, token }));
    resolve({ ws, out });
  });
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const editsCount = () =>
  (new Database(DB_PATH, { readonly: true }).query("SELECT count(*) c FROM edits").get() as any).c;

afterAll(() => {
  proc.kill("SIGKILL");
  try { rmSync(tmp, { recursive: true, force: true }); } catch {}
});

describe("persistence", () => {
  test("edits accepted before ack are durable and restored to late joiners after restart-simulation", async () => {
    const { ws, out } = await connect("PersistProbe");
    await wait(500);
    const joined = out.find((m) => m.type === "joined");
    expect(joined).toBeTruthy();
    // find the top surface block at column (6, z=6) by probing breaks at descending y
    let top: number | null = null;
    for (let y = 6; y >= -2; y--) {
      ws.send(JSON.stringify({ type: "edit", action: "break", x: 6, y, z: 6 }));
      await wait(30);
      const acc = out.find((m) => m.type === "edit-accepted" && m.x === 6 && m.z === 6);
      if (acc) { top = y; break; }
    }
    expect(top).not.toBeNull();
    // place on top
    ws.send(JSON.stringify({ type: "edit", action: "place", x: 6, y: top + 1, z: 6, block: "stone" }));
    await wait(300);
    expect(out.find((m) => m.type === "edit-accepted" && m.x === 6 && m.y === top + 1)).toBeTruthy();
    const db = new Database(DB_PATH, { readonly: true });
    const row = db.query("SELECT block FROM edits WHERE x=6 AND y=? AND z=6").get(top + 1) as any;
    expect(row?.block).toBe("stone");
    ws.close();
  }, 15000);

  test("malformed edits rejected and not persisted", async () => {
    const { ws, out } = await connect("PersistProbe2");
    await wait(400);
    ws.send(JSON.stringify({ type: "edit", action: "place", x: 9999, y: 0, z: 0, block: "stone" }));
    ws.send(JSON.stringify({ type: "edit", action: "place", x: 0.5, y: 0, z: 0, block: "stone" }));
    await wait(300);
    expect(out.filter((m) => m.type === "edit-rejected").length).toBeGreaterThanOrEqual(2);
    const db = new Database(DB_PATH, { readonly: true });
    const n = db.query("SELECT count(*) c FROM edits WHERE x=9999 OR x=0.5").get() as any;
    expect(n.c).toBe(0);
    ws.close();
  }, 10000);
});

describe("terrain-aware edit validation", () => {
  function pickNatural(): { x: number; y: number; z: number; top: { x: number; y: number; z: number } } {
    // find a natural grass voxel with air above, avoiding columns that already have edits
    const { generateTerrain } = require("../shared/terrain.js");
    const { world, key } = generateTerrain();
    const db = new Database(DB_PATH, { readonly: true });
    const hasEdit = (x: number, y: number, z: number) => !!db.query("SELECT 1 FROM edits WHERE x=? AND y=? AND z=?").get(x, y, z);
    for (const [k, name] of world) {
      if (name !== "grass") continue;
      const [x, y, z] = k.split(",").map(Number);
      if (world.has(key(x, y + 1, z))) continue;
      if (hasEdit(x, y, z) || hasEdit(x, y + 1, z)) continue;
      return { x, y, z, top: { x, y: y + 1, z } };
    }
    throw new Error("no untouched natural grass voxel found");
  }

  test("fresh DB: break natural, place adjacent to natural, floating rejected, double-break rejected", async () => {
    const spot = pickNatural(); // (-11,0,0) grass with air above
    const { ws, out } = await connect("TerrainProbe");
    await wait(500);
    const edits = () => out.filter((m) => m.type.startsWith("edit"));
    // 1. break a natural block
    ws.send(JSON.stringify({ type: "edit", action: "break", ...spot }));
    await wait(200);
    expect(edits().some((m) => m.type === "edit-accepted" && m.action === "break" && m.x === spot.x && m.y === spot.y && m.z === spot.z)).toBe(true);
    // 2. double-break same voxel -> rejected
    ws.send(JSON.stringify({ type: "edit", action: "break", ...spot }));
    await wait(200);
    expect(edits().some((m) => m.type === "edit-rejected" && m.reason === "Nothing to break there")).toBe(true);
    // 3. place on top of intact natural ground (5,1,6) is grass -> place at (5,2,6)
    ws.send(JSON.stringify({ type: "edit", action: "place", block: "stone", x: 5, y: 2, z: 6 }));
    await wait(200);
    expect(edits().some((m) => m.type === "edit-accepted" && m.action === "place" && m.x === 5 && m.y === 2 && m.z === 6)).toBe(true);
    // 4. floating place far from any block -> rejected
    ws.send(JSON.stringify({ type: "edit", action: "place", block: "stone", x: 999, y: 8, z: 999 }));
    await wait(200);
    expect(edits().some((m) => m.type === "edit-rejected" && m.x === 999)).toBe(true);
    ws.close();
  }, 15000);
});

describe("resume and checkpoint integrity", () => {
  test("checkpoint position survives disconnect/rejoin; spawned fresh player gets no stale row", async () => {
    const { ws, out } = await connect("ResProbe");
    await wait(500);
    const joined = out.find((m) => m.type === "joined");
    expect(joined.token).toBeString();
    const token = joined.token;
    ws.send(JSON.stringify({ type: "checkpoint", x: 6, y: 1.5, z: 9.97, yaw: 0.5, pitch: 0.1, selected: 1 }));
    await wait(300);
    // init carries resume:false for a fresh player
    const init = out.find((m) => m.type === "init");
    expect(init.resume).toBe(false);
    ws.close();
    await wait(200);

    const re = await connect("ResProbe", token);
    await wait(500);
    const reJoined = re.out.find((m) => m.type === "joined");
    expect(reJoined.resume).toBe(true);
    expect(reJoined.pos).toEqual({ x: 6, y: 1.5, z: 9.97, yaw: 0.5, pitch: 0.1 });
    const reInit = re.out.find((m) => m.type === "init");
    expect(reInit.resume).toBe(true);
    re.ws.close();
  }, 15000);
});

describe("beacon objective", () => {
  test("fragments validate proximity/duplicate, early activation refused, celebration broadcast, state in init", async () => {
    const { ws, out } = await connect("BeaconProbe");
    await wait(500);
    const init = out.find((m) => m.type === "init");
    expect(init.fragments).toEqual([]);
    expect(init.beaconLit).toBe(false);

    // early activation refused
    ws.send(JSON.stringify({ type: "activate-beacon" }));
    await wait(200);
    expect(out.some((m) => m.type === "beacon-lit")).toBe(false);

    // far collect refused: server-tracked position is spawn (player just joined, sent state at spawn)
    ws.send(JSON.stringify({ type: "state", x: 6, y: 4, z: 6, yaw: 0, pitch: 0 }));
    await wait(150);
    ws.send(JSON.stringify({ type: "collect-fragment", idx: 0 }));
    await wait(200);
    expect(out.some((m) => m.type === "fragment-collected")).toBe(false);

    // walk to each spot via state messages (server-authoritative proximity), collect all three
    for (let idx = 0; idx < 3; idx++) {
      const s = FRAGMENT_SPOTS[idx];
      ws.send(JSON.stringify({ type: "state", x: s.x + 0.5, y: s.y + 0.5, z: s.z + 0.5, yaw: 0, pitch: 0 }));
      await wait(150);
      ws.send(JSON.stringify({ type: "collect-fragment", idx }));
      await wait(200);
    }
    expect(out.filter((m) => m.type === "fragment-collected").length).toBe(3);
    // duplicate collect refused (position still at spot 0 — proves one-time rule, not proximity)
    const s0 = FRAGMENT_SPOTS[0];
    ws.send(JSON.stringify({ type: "state", x: s0.x + 0.5, y: s0.y + 0.5, z: s0.z + 0.5, yaw: 0, pitch: 0 }));
    await wait(150);
    ws.send(JSON.stringify({ type: "collect-fragment", idx: 0 }));
    await wait(200);
    expect(out.filter((m) => m.type === "fragment-collected").length).toBe(3);

    // now activation succeeds
    ws.send(JSON.stringify({ type: "activate-beacon" }));
    await wait(300);
    expect(out.some((m) => m.type === "beacon-lit")).toBe(true);
    // double activation refused
    ws.send(JSON.stringify({ type: "activate-beacon" }));
    await wait(200);
    expect(out.filter((m) => m.type === "beacon-lit").length).toBe(1);

    // late joiner sees the same state
    const late = await connect("LateBeacon");
    await wait(500);
    const lateInit = late.out.find((m) => m.type === "init");
    expect([...lateInit.fragments].sort()).toEqual([0, 1, 2]);
    expect(lateInit.beaconLit).toBe(true);
    late.ws.close();
    ws.close();
  }, 20000);
});

describe("identity hardening", () => {
  const pidOf = (db: Database, nickname: string) =>
    (db.query("SELECT id FROM players WHERE nickname=?").all(nickname) as any[]);

  test("same-nickname fresh clients get distinct pids; token resumes owner+pos; revoked/invalid token cannot resume", async () => {
    const db = new Database(DB_PATH, { readonly: true });
    // 1. two tokenless joins with the SAME nickname → distinct pids, distinct tokens
    const a = await connect("IdentProbe");
    await wait(400);
    const aJ = a.out.find((m) => m.type === "joined");
    expect(aJ.token).toBeString();
    a.ws.send(JSON.stringify({ type: "checkpoint", x: 3, y: 1.5, z: 4, yaw: 0.2, pitch: 0, selected: 0 }));
    await wait(250);
    a.ws.close();
    await wait(200);

    const b = await connect("IdentProbe");
    await wait(400);
    const bJ = b.out.find((m) => m.type === "joined");
    expect(bJ.token).toBeString();
    expect(bJ.token).not.toBe(aJ.token);
    const rows = pidOf(db, "IdentProbe");
    expect(rows.length).toBe(2); // two distinct pids, never merged by nickname
    b.ws.close();
    await wait(200);

    // 2. valid token resumes owner and position
    const a2 = await connect("IdentProbe", aJ.token);
    await wait(400);
    const a2J = a2.out.find((m) => m.type === "joined");
    expect(a2J.resume).toBe(true);
    expect(a2J.pos).toEqual({ x: 3, y: 1.5, z: 4, yaw: 0.2, pitch: 0 });
    a2.ws.close();
    await wait(200);

    // 3. invalid token → fresh pid, resume:false, and NO fallback to name-based pid
    const bad = await connect("IdentProbe", "f".repeat(64));
    await wait(400);
    const badJ = bad.out.find((m) => m.type === "joined");
    expect(badJ.resume).toBe(false);
    expect(badJ.token).toBeString();
    expect(pidOf(db, "IdentProbe").length).toBe(3); // got a NEW pid, did not reuse a's or b's
    bad.ws.close();
    await wait(200);

    // 4. revoked token: exchange-and-rotate via /revoke, old token no longer resumes
    const r = await fetch(`${HTTP}/revoke`, { method: "POST", body: JSON.stringify({ token: aJ.token }) });
    expect((await r.json()).ok).toBe(true);
    const dead = await connect("IdentProbe", aJ.token);
    await wait(400);
    const deadJ = dead.out.find((m) => m.type === "joined");
    expect(deadJ.resume).toBe(false);
    dead.ws.close();
  }, 25000);
});
