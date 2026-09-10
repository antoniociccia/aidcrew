# browser-chromium

An optional AIDCrew plugin for debugging a shared visible Chromium through
Chrome DevTools MCP. The agent loop and UI need no browser-specific changes.
The plugin loads through the normal plugin loader, uses the existing MCP
transport, and closes its MCP child when the session is cancelled. Chromium
is a separate process and stays open after disconnect.

Six tools: `browser_help`, `browser_inspect`, `browser_navigate`,
`browser_evaluate`, `browser_interact`, `browser_screenshot`.
`browser_inspect` combines console, network and canvas measurements in one
diagnostic call. Every page operation has an explicit page ID, so separate
agents do not accidentally act on a shared selected-page pointer. Models receive
small text results; screenshots are saved for human review, not described as
model vision. Usage guidance is supplied automatically through the plugin instruction hook
when the agent has browser tools. It does not enter conversation history or
require a task-specific prompt/file. `browser_help` provides extra examples
when needed.

The generic `hooks.instructions(context)` capability receives the agent's
filtered tool names, model and working directory. A plugin returns concise
guidance or undefined. The loop composes it into each request's system prompt,
deduplicates identical text, and never appends it to persisted messages.
It survives compaction without accumulating in history. Agents without
`browser_inspect` receive no browser guidance. Cancelled or failed hooks do
not strand a session. This mechanism is available to any plugin, not just
Chromium.

## Install from this checkout

```sh
npm ci --prefix plugins/browser-chromium/mcp
bun plugins/browser-chromium/install.ts /path/to/project
aidcrew plugin trust browser-chromium -C /path/to/project
python3 /path/to/project/.aidcrew/plugins/browser-chromium/runtime.py chromium start
```

Restart AIDCrew to load the plugin. If agent tools are explicitly restricted,
add the six names above to their `tools` list. Inspect installation with
`aidcrew plugin check /path/to/project/.aidcrew/plugins/browser-chromium`.

The installer bundles only our adapter code. The separate MCP dependency is
pinned by `mcp/package-lock.json`; it is not vendored into the plugin. The
generated project config points at the installed MCP entry, so no npm download
is needed while agents work. Run the installer again after moving the harness
checkout. To use an independently installed MCP server, configure:

```toml
[plugins.browser-chromium]
command = "npx"
args = ["--yes", "chrome-devtools-mcp@1.9.0"]
browserUrl = "http://127.0.0.1:9222"
timeoutMs = 20000
```

Only a trusted installed plugin runs this command. No `.mcp.json` is necessary.
The browser is connected lazily on the first tool call; failed calls return
errors with a deadline rather than leaving a model waiting indefinitely.
The runtime helper starts only a dedicated profile and stops only its owned
process group, never every Chromium process on the computer. It retains GPU
rendering and disables background throttling. This does not guarantee macOS
window capture across Spaces: verify the saved OBS recording independently.

## Dependency attribution

The AIDCrew adapter and helper are original code under this repository's MIT
license. Chrome DevTools MCP is maintained by the ChromeDevTools project and
distributed under Apache-2.0; its package retains its LICENSE and bundled
third-party notices. Chromium is installed separately under its own licenses.
No Chromium executable, third-party assets, logos or game assets are included.
Names identify interoperable software and do not imply affiliation.

- https://github.com/ChromeDevTools/chrome-devtools-mcp
- https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/LICENSE
- https://www.chromium.org/chromium-projects/

Validation: unit tests use an injected MCP caller to verify tool routing,
error handling and browser instructions without model requests.

## First preview after startup

`runtime.py chromium start` also starts an owned local preview watcher. It
checks the preview server once a second and, when the server becomes available,
navigates existing Chromium tabs on that local port to their current URL. This
recovers connection-error pages without a model call or a manual refresh. It
rearms after two failed health checks, so a later server restart is handled too.
Only local preview tabs are touched; unrelated sites and ports are excluded.
Navigation attempts are bounded to three per offline/online transition.

The watcher is independent of the generated application and is installed with
the plugin. It is stopped with `runtime.py chromium stop`; preview shutdown
leaves it waiting for the next server start. It does not implement live reload
for source edits while the server stays online.
