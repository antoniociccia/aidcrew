# Skyforge Islands

Source snapshot from agent commit `aba6e52`. The supervised session closed with the house milestone cancelled. See the parent case report for measured results and known defects. The only packaging changes are license notices, documentation corrections and removal of an unused legacy QR bundle.

Multiplayer browser voxel sandbox: float between seeded islands, build, and light the beacon with friends.

## Run

```
bun install
bun run dev        # serves http://localhost:8787/
```

Env: `PORT` (default 8787), `DB_PATH` (default `./data/world.sqlite` — parent directories are created automatically), `WORLD_SEED` (default 1337), `CHECKPOINT_INTERVAL` (position save interval, default 5s).

## Controls

Keyboard + mouse:
- **WASD** move · **Space** jump · mouse look (click canvas for pointer lock)
- **Left-click** break · **Right-click** place · **1-4** select block
- No pointer lock? **Arrow keys** look · **B** place · **N** break
- **E** collect energy fragment (when near one) · **F** activate the beacon (at 3/3)
- **V** wave · **M** mute
- **Leave** button disconnects cleanly (saves your position)

Touch (coarse-pointer devices): virtual joystick drives WASD, drag to look, on-screen jump/break/place buttons, plus Leave.

## Objective — Light the Beacon

Three energy fragments sit at three nearby landmark isles (a ruin, a satellite dish isle, a tree isle). Collect them with **E** — collection is validated server-side against your server-tracked position, so each fragment can only be taken once and only from within range. At **3/3**, press **F** at the beacon: the sky warms, particles burst, and the celebration is broadcast to everyone. Progress and the lit state are persisted and visible to late joiners.

## Identity & recovery

- Joining as a guest always creates a fresh player identity; your browser stores a 64-hex token. Reconnecting (even after a server restart) resumes your player and position via that token.
- The QR panel (🔐 button) shows a **recovery QR encoding a one-time credential** (`/#r=<token>`): opening that URL on another device prefills recovery, and confirming transfers that player's identity. Credentials are single-use and exchanged for a fresh token; "Revoke & regenerate" rotates yours atomically.
- A **join QR** (world invite) encodes just the world URL, no credentials.
- Nicknames are display-only: two players may share a name; tokens, not names, prove identity.

## Persistence

All block edits, player identities, session positions (checkpoints every `CHECKPOINT_INTERVAL` seconds), fragment collection and beacon state live in SQLite at `DB_PATH` and survive restarts. The server checks edit bounds and placement constraints, fragment collection and beacon state. Player movement remains client-authoritative; this is not a hardened anti-cheat implementation.

## Limitations

- Touch controls are wired to the same input paths as keyboard but have not been visually verified on a real touch device.
- Pointer-lock click editing (break/place) requires a human mouse test; automated checks cover the server paths.
- The recorded house was incomplete; this source export starts a fresh world and contains no recorded database.
- Grass structures can affect spawn selection.
- **P** displays position and camera direction; the read-only build-assist panel reports targeting feedback.

## Third-party notices

- [three.js](https://threejs.org) r169 (MIT) — vendored as `public/vendor/three.module.js`.
- [node-qrcode](https://github.com/soldair/node-qrcode) 1.5.4 (MIT) — bundled as `public/vendor/qrcode.bundle.js`.
