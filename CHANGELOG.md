# Changelog

Releases are cut from a tag (`bun run version:set`, then `git push
--follow-tags`); the tag is what CI builds. Entries say what a release gives
the person using it, in the order it matters.

## Unreleased

### The interface

- Side by side, `^←` and `^→` move the divider beside the pane in focus, four
  columns a press, never narrower than a pane can be read. What a drag does,
  for a keyboard — and for a recording, which has no mouse.
- A closed terminal ends the process. Listening for the hangup so the store
  could be closed and the screen given back had replaced the exit that used
  to follow, leaving sessions running unseen in the background.

### The team

- A job's checkout is on a branch made for it, `work/<job>`, from the moment
  it is made, so a commit in it is kept whatever happens to the checkout —
  no agent has to remember to make one. A later session's checkout for the
  same job starts from the branch. `/merge` brings the branch into the
  repository, or backs out at once and names the conflict.
- Done is checked, not said. When the leader ends a turn with a job that has
  changes, the harness runs the project's check on the job's branch — read
  off the project's files, or named by `[defaults] check` — and merges the
  branch if it passes. If it fails, or the work was never committed, the
  leader is sent back with the output, twice at most, and the job stays open.
  `[defaults] mergeOnDone = false` keeps a verified branch unmerged.

### Cost

- When a job comes home, one line says what it cost, on which models, and
  what the same tokens would have been on `claude-sonnet-5` and `gpt-5` — the
  figure that makes the case for a mixed team, said when the case has just
  been made. The list of jobs shows the same line for each.

### Guards

- The shell refuses a command that would leave the agent's checkout — `cd`,
  `pushd` or `git -C` pointed at another checkout, the repository root
  included — and says where it was going. The file tools already drew that
  line; watched on a real run, a coder's `cd` into the root moved a person's
  own repository onto the coder's branch.

### The project

- `.aidcrew/.gitignore` is written the first time anything creates the
  directory — the wizard, a checkout, an undo snapshot — and it covers the
  snapshots as well as the checkouts, the layout and the transcript database.
  The config and the agents beside it stay committable, which is the point.
- `[defaults] toolCallsPerTurn` raises the bound on tool calls in one turn for
  a project whose jobs are bigger than fifty allow for; a turn stopped at the
  bound now says so, and that what it wrote is in its checkout.

## 0.1.0 — 2026-09-03

The first release. A team of coding agents, each on its own provider and
model, every job in a git worktree of its own, in one terminal — and every
provider, tool, guard and loader a plugin, loaded through the same registry a
stranger's would be.

### One file per platform

- macOS (arm64, x64), Linux (x64, arm64) and Windows (x64), with a
  `checksums.txt` beside them. Before a release is published, the binary it
  built is started on each of the three platforms and its version checked
  against the tag. On Windows the shell tool runs `bash`, which Git for
  Windows provides; the Linux build under WSL is the better-worn road.

### A first run that explains itself

- A five-step setup: the service, a key (read from stdin, masked, never
  shown again), a model from the service's own list ranked for coding, a team
  chosen from five roles, and the wording every agent reads on every request
  — shown as it stands, with one key to write it into the project as
  `ORCHESTRATE.md` where it can be argued with.
- Eight pages then say what this is: a team rather than an assistant, who is
  on it, how you ask, how they hand work over, where the work goes, how to
  watch or not watch them, what it is costing, and where everything else
  lives. `/tour` brings them back.
- `aidcrew demo`: sixty seconds against real files, with a model that does not
  exist, so the whole loop can be seen with no key and no account.

### The team

- Agents are markdown files in `.aidcrew/agents` — or the `.claude/agents`
  files a project already has, read where they are. Which of them are on the
  team, and what each runs on, is `.aidcrew/config.toml`, committed with the
  repository so whoever clones it gets the team.
- One agent leads. Every job comes back to it, however many hands it passed
  through, so the one who was given the work is the one who decides it is
  done. The leader cannot be dropped from the team.
- Handoffs go through `agent_send`, with the diff attached when the
  recipient is on another checkout and one line when they share it. An agent
  addressed by role goes to whichever agent on that role is free; when all
  are busy, the person is asked — wait, start another, or drop it — from the
  pane of the agent it concerns.
- Every job gets a `git worktree` of its own, shared by the agents working
  it. A checkout with work in it outlives the session and is picked up where
  it was left; only a clean one, or one whose work a branch already holds, is
  taken away. `aidcrew undo` takes back the last change any agent made.
- An agent turned loose with `/yolo` acts without asking, and when it reaches
  the bound of a turn with the work unfinished it is sent back to carry on,
  four times at most, so nobody has to be there to say "go on". Anything
  typed while the model was still writing is answered next.

### Tools

- `read`, `write`, `edit`, `grep`, `glob`, `wc`, `awk`, `tree`, `head`,
  `stat`, `json`, `toml`, `outline`, `symbols`, `imports`, `deps`, `git-log`,
  `lsof`, `bash`, `skill` and `agent_send`. Everything that only reads is a
  tool of its own rather than a shell command, so looking something up never
  needs approving. `edit` forgives a match that differs only in whitespace
  and says so; `read` says how many lines there are and where to continue;
  `grep` takes context lines; `bash` returns when the command does, and a
  timeout kills the whole process group and reports what was printed.
- Any MCP server, over stdio or HTTP, declared in the `.mcp.json` a project
  already has. Its tools arrive as ordinary tools; a server a project
  declares does not start until `aidcrew mcp trust <server>` says it may.

### Guards

- A never-write list — `.git`, `.env`, `.ssh`, `.aws`, private keys, the
  session database — and an always-ask list of commands that cannot be taken
  back, in every spelling the guard knows: `rm -rf` and `rm --recursive
  --force`, `find -delete`, `git push --force` and `git push +main`, `git
  reset --hard`, `git restore .`, `dd`, `curl … | sh`, `kill -KILL`. Asked
  about even for an agent told to act without asking; approving one never
  approves the next. Headless, with nobody to ask, a question is a refusal.
- A snapshot of every file before it changes, kept with the repository.
- Cloning is not consent: a project's plugins, MCP servers and the parts of
  its config that let an agent act unasked are inert until a command trusts
  them. Config paths cannot reach outside the project, `env` and any `$` in a
  command ask first, and a config file names the variable holding a key —
  never the key.

### Providers

- Anthropic, Gemini, and anything that speaks the OpenAI dialect — Zen,
  OpenRouter, DeepSeek, OpenAI, Ollama, vLLM, or any endpoint by URL — in both
  the chat and the responses shape, chosen by trying. A model without native
  tool calling gets its tools in the prompt and its calls read back from the
  text.
- Two agents hold two credentials on two services in one session; that is
  the base case. Keys are saved from stdin into a store with mode `0600`,
  never logged, never echoed in an error.
- A service that stops talking is given up on — one clock for the first
  byte, one for the silence between chunks — and tried again; a 429 that
  says `Retry-After` is waited out. A gateway that answers 200 with a refusal
  in the body, or ignores `stream: true`, is reported as what it is.

### Cost

- Per agent and per session, from the service's own price list, from the
  project's stated prices, or from a bundled list checked against the lists
  the services publish — shown with a tilde so an estimate is never read as a
  bill. A service billed by subscription shows its allowance instead: every
  window, how far each has gone, and when the tightest comes back.
- A turn that ends in an error is still paid for. A cost that cannot be
  worked out honestly is shown as nothing, never as zero.

### The interface

- Every agent in its own pane, side by side on `^l`, or one at a time on
  `tab`; a question is answered only from the pane it was asked in. The
  screen is the alternate buffer, every frame exactly the window's height,
  each drawn over the last rather than after a wipe — so nothing scrolls,
  nothing blinks, and the shell comes back as it was.
- Nine palettes, each in two fills: solid, where a tab is a filled block in
  its agent's colour, and hairline, where the colour is on the name and the
  marks alone. The default is six hues chosen to stay six under the common
  forms of colour blindness and on a 256-colour terminal; both claims are
  tests.
- Images pasted into the prompt reach models that accept them; `@` attaches
  a file by name and `^t` finds one; dragging over what an agent said copies
  it. Every turn is written to disk, and a session resumes where it was left
  — transcript, history and checkouts included.

### Writing a plugin

- A TypeScript module in `~/.aidcrew/plugins` or `.aidcrew/plugins`: no
  build step, no publishing, no restart. It declares any of `providers`,
  `tools`, `loaders`, `hooks`, `prices` and `ui`, and may export `setup(host)`
  to ask the person a question before it registers. `aidcrew plugin check`
  says what the host will say about it before it ships.
