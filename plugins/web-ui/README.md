# AIDCrew Web UI

A bundled native AIDCrew plugin. The web server, browser client, request schema and
assets live here. The TUI supplies a `SessionBridge` over its existing `LiveTeam`:
there is one team, one journal and one credential store, regardless of how many
browser tabs connect. Closing a browser tab does not stop agents.

## Start

Run `aidcrew -C /absolute/project/path`. The terminal and web server start together,
and the default browser opens with a per-process access link. No frontend build,
CDN, hosted account or additional model calls are needed. Assets are included in
the compiled executable. The default port is **4318**, separate from a project's
preview port. If that default is occupied, another available port is selected.

A private access file is created at `~/.aidcrew/web/<pid>.json` (directory 0700,
file 0600), containing the exact address and access link. Its path is shown in the
terminal. It is removed when that process exits normally. A new launch creates a
new token; old links stop working. Do not publish the private access file.

- `AIDCREW_WEB=0`: terminal only.
- `AIDCREW_WEB_OPEN=0`: start both interfaces without opening a browser window.
- `AIDCREW_WEB_PORT=4321`: explicitly choose a port; conflicts are reported.

The running executable must contain this plugin. An already running older harness
cannot acquire it without restarting.

## Remote access

The server listens on loopback, not the public network. From another computer,
forward its port over SSH (replace the host and port with your own):

```sh
ssh -N -L 4318:127.0.0.1:4318 user@your-mac
```

Open `http://127.0.0.1:4318/` on that computer and paste the access token from the
private access file, or open its access URL. If you choose a different local port,
replace the port in the URL too. SSH must already be configured on the host.
Keep the harness terminal running, for example inside `tmux`, to survive a remote
terminal disconnect. Stopping the harness stops the WebUI; closing the browser
only disconnects that browser.

Requests use bearer authentication; origins and hosts are checked, API responses
are not cached, and the token is removed from the browser address bar immediately.
Tokens live in sessionStorage, isolated to that browser tab's session. No wildcard
CORS or unauthenticated control endpoints are provided. The token grants control
of the local harness, including the tools its agents may run.

## Controls and synchronization

The mission view shows real agent state, cost and conversation. Activity combines
all agents. Tasks and shared memory read the same worktrees and journal as the
terminal. Team settings include model/provider changes, per-session YOLO, queue
clearing, history reset, role creation/editing/removal, provider keys, defaults,
sources and terminal appearance. Changes can be inspected and merged through the
normal verification path. Guard and contention decisions use the same pending
request as the terminal; a stale or duplicate web answer is refused.

Every mutation is bound to the workspace session that the browser displayed;
a stale tab cannot send an old instruction into a newly opened project. Switching
workspaces clears browser drafts and open action dialogs.

Snapshots refresh every 750 ms while connected; reconnect is automatic. Transcript
views render the most recent 400 matching lines from the runtime's 2,000-line
window. Earlier conversation remains in the same journal. Cost is not guessed:
unavailable prices show a dash, zero is a number, and list-price estimates are
labelled. No `free` badge is introduced.

The composer also accepts terminal slash commands and project-file attachments.
It targets the selected browser agent even when another agent is selected in the
terminal. `/copy`, `/split` and `/tour` remain terminal presentation commands;
the browser has its own Activity view and keyboard guide. Browser drafts and view
selection are local; mutations and approvals are shared. Provider credentials are
write-only in the web API. Role instruction edits take effect on the next session
start, matching the saved project definitions.

## Keyboard

Outside text fields: **J/K** select agents, **/** focuses the composer, **R** toggles
reasoning, **Escape** stops the selected agent, **?** opens the guide.
**Command/Ctrl+Enter** sends a message. Activated shortcuts flash; toggle buttons
stay highlighted while enabled. The TUI also highlights active modes and promotes
the last used shortcut into its limited tray space.

## Validation

`bun test plugins/web-ui packages/tui/src/web-session.test.ts packages/tui/src/web-integration.test.tsx`
checks authentication, origin/host rejection, schema validation, shared transport,
and a rendered TUI backed by a local mock model. The integration test verifies
messages in both directions, correct model-change targeting and exactly-once
approvals without spending provider credits.

## Conversation layout

The web wordmark matches the terminal: spaced AI and CREW, with D on a filled block. Compact navigation and team cards leave most of the desktop viewport to the conversation. Messages use larger type, the composer remains visible, and the transcript scrolls independently. The responsive layout also increases transcript space on narrow screens.
