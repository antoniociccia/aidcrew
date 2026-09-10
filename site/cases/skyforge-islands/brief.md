# AIDCrew-Blocks — Skyforge Islands

## Product

Build AIDCrew-Blocks: Skyforge Islands, an original multiplayer browser voxel
sandbox. Friends build, explore floating islands and bring a dormant beacon
back to life. Create original visuals and assets. Prioritize a small, polished
creative playground: finite seeded terrain, grass, stone, wood, sand, trees,
sky, fog, crosshair and a readable block-selection hotbar.

Players can walk, look around, jump, collide with terrain, place and remove
blocks. Two independent browser sessions must see each other's named avatars
and block edits. Target 2–4 players in a shared world. Provide desktop
mouse/keyboard controls and basic touch controls for players joining from phones.
Do not spend the first build on crafting, mobs, survival or infinite terrain.

## Visual direction and feel

Create an inviting first frame with turquoise skies, warm sunlight, soft fog
and a cohesive block palette. Give the floating terrain recognizable silhouettes,
small ruins, hanging roots and a few satellite islands worth exploring. Make
the central beacon the visual centerpiece. Add lightweight clouds and subtle
water animation where appropriate; keep effects cheap and readable.

Use a crisp interface with restrained typography, clear icons, consistent
spacing and a polished hotbar. Hide debug clutter. Show loading, joining and
connection states clearly. A short onboarding sequence should get a new player
moving and building within seconds, with keyboard and touch controls explained.

Make movement responsive, with reliable collision, jumping, coyote time and
jump buffering. Provide a targeted-block outline and a translucent placement
preview that distinguishes valid and invalid placement and explains rejection.
Give placement and breaking satisfying feedback using small particles, brief
animation and subtle original synthesized sounds. Start audio only after user
interaction and include mute. Recover gracefully from falling and reconnecting.
Never solve collision or placement defects by disabling validation.

Players have distinct colors, readable names and a simple wave emote. Make
teammates' movement and building easy to follow. Keep graphics smooth on a Mac
laptop; measure representative frame timing, avoid heavy dependencies and
simplify effects that hurt performance or obscure interaction.

## Cooperative objective: Light the Beacon

Add one compact shared objective after the sandbox fundamentals work. Place
three energy fragments at three nearby, distinct landmarks. Players explore,
collect them together and build their way to the central beacon. Show shared
progress clearly. Server-side validation must prevent collecting the same
fragment twice or activating the beacon before the objective is complete.

Activation triggers a short celebration: a pulse of light, particles and a
beautiful change in the sky. Preserve free building after completion. Arrange
landmarks and travel distances for a satisfying 60–90 second route;
verify the route instead of promising the timing without a playthrough.
Persist fragment collection and beacon activation alongside player construction.
Late joiners and returning players must see the same objective state. Keep this
small; it is a cooperative finale, not a large survival or quest system.

## Suggested architecture

TypeScript client with Three.js; Bun HTTP/WebSocket server; bun:sqlite.
One persistent server process owns world state and validates block edits,
coordinates and message sizes. Clients interpolate remote movement. Render
visible voxel surfaces in chunks or another bounded draw-call approach.
Use a deterministic terrain seed and persist modifications, including removed
blocks. Persist player identity, position and selected block. Save accepted
block edits transactionally before acknowledging persistence. Position may
be checkpointed periodically with its interval documented.

SQLite lives outside build outputs and disposable checkouts, at a configurable
path. Serve client and sockets from the same origin. Support local play;
public hosting requires a runtime supporting WebSockets and persistent disk.

## Identity and QR

Allow instant guest creation with a nickname and automatic session return.
Provide a private, downloadable recovery QR to return as that same player
after logout or in a fresh browser. Its credential must be random, revocable,
stored hashed on the server, and exchanged for a session. Do not put the
credential in server access logs; remove it from the browser URL after exchange.
Explain that the recovery QR grants access to that player.

Provide a separate public join QR containing only the game URL. Scanning this
creates or resumes the scanning person's own player. Never publish the private
recovery QR as the join QR. A short-lived pairing QR can be added after recovery
works; it is not a substitute for durable account recovery.

## Observable milestones

1. Document startup commands and show a rendered island in the browser.
2. Make movement, collision and block placement/removal playable.
3. Connect two independent players and synchronize edits and avatars.
4. Persist edits and player state through a server restart.
5. Recover the same player in a fresh browser via private QR.
6. Finish touch controls, connection feedback and the acceptance checks.
7. Refine movement, placement feedback, onboarding and the visual style.
8. Add and verify Light the Beacon, multiplayer presence and its celebration.
9. Run the complete two-player acceptance test and final polish review.

Establish the visual palette from the first scene, but fix rendering and actual
gameplay defects before decorative effects. Keep each increment small and
independently reviewed; do not attempt a large rewrite or one untested final
polish pass. Brief exploration, implementation and real interaction checks
should alternate throughout the build.

Keep the game runnable after each milestone. Verify the current implementation through real browser interactions.

## Completion evidence

- Two isolated browser sessions join as different players.
- A block placed or removed by A changes visibly for B.
- Walking and jumping do not pass through solid terrain in normal play.
- Reload preserves edits; restarting the server preserves them too.
- A private recovery QR restores the same player in a fresh browser.
- A revoked recovery credential is refused.
- A public join QR does not authenticate as its creator.
- Malformed and out-of-bounds edits are rejected by the server.
- A third client joining later receives the current world.
- Automated checks cover persistence, identity and the socket protocol.
- Real-browser checks cover rendering, controls and two-player interaction.
- Voxel faces are complete; targeting and placement feedback agree with actual edits.
- Falling and reconnecting return the player to a usable game state.
- Two players collect the fragments and activate the beacon through real controls.
- Both clients see the same progress and celebration; duplicate collection is refused.
- A server restart preserves constructions, collected fragments and beacon activation.
- Onboarding, hotbar, wave emote, mute and basic touch interaction work.
- Report representative performance measurements and any simplified effects.
- Report exactly which checks passed, unverified behavior and known limits.

Tests must validate behavior, not merely that the page loads. Provide startup
instructions and a dependency lockfile. Verify two independent players joining,
building together and activating the beacon, followed by a server restart and
return to the same world. Direct state mutations and synthetic socket messages
alone do not verify this gameplay path. Report passed checks and remaining limits.

## Live preview

Keep the game available at http://localhost:8787/ during development. Show
working increments as they become available, and update the preview after
changes. Display connection and loading errors clearly, reconnect after a
server restart, and verify the final delivered branch in the live preview.

## Exploration and building experience

Include a scenic exploration route with broad views of the floating islands,
recognizable landmarks and a suitable building area. Verify the building
experience by constructing a small, attractive house through normal gameplay
controls, with walls, a doorway, windows and a roof. Have a second independent
player participate and observe the construction as it happens. Do not create
the house by injecting world state, loading a prefab or editing the database.
Restart the server and confirm that both players return to the same intact
house. Finish with a walk through the house and a panoramic view of the world.

## Living world and idle showcase

Make the world visibly alive from the first playable scene: slowly drifting
clouds, gentle beacon pulses, subtle water motion and lightweight ambient
particles. Add these progressively without delaying the first working preview.
Keep animation readable and inexpensive, respecting reduced-motion preferences.

Offer a clearly labeled automatic scenic camera mode before joining and after
an idle interval, with smooth, slow views of the actual current islands and
player constructions. Return immediately to normal controls on player input;
never move the player's authoritative position or perform gameplay actions on
their behalf. Preserve the player's viewpoint when leaving the scenic camera.
Provide a visible toggle to disable it. Avoid abrupt cuts or rapid orbiting.

Show real construction progress as it happens. Keep the presentation page
connected and render world updates when it is not focused; recover cleanly when
visibility resumes. Changes to the world, remote players and the beacon should
remain observable. Do not substitute a prerecorded animation, fabricated
activity, scripted construction or a completed scene for the live world.
Verify that the scenic mode displays newly placed blocks, yields to controls,
and does not break multiplayer synchronization or persistence.
