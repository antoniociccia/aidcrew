# Security

aidcrew runs shell commands on your machine, writes to your files, and loads
third-party TypeScript into its own process with your API keys in it. That is
what it is for. This document says where the lines are, what stops what, and —
more usefully — what does not.

## Reporting something

Open a [security advisory](https://github.com/antoniociccia/aidcrew/security/advisories/new),
not a public issue. Say what you did, what happened, and what you expected. A
proof of concept helps and is not required.

If it is one of the things listed under **Known limits** below, it is already
written down; say so and say why the limit is worse than it looks, which is the
part worth hearing.

## The one rule

**Cloning a repository is not consent.** Everything that arrives with a clone is
inert until you say otherwise, by typing a command — never by answering a prompt
that interrupted you, because a prompt that interrupts is a prompt answered
without reading.

| what arrived | what it can do before you say | how you say it |
|---|---|---|
| `.aidcrew/plugins/*` | nothing; it is not imported | `aidcrew plugin trust <name>` |
| `.mcp.json`, `.aidcrew/mcp.json` | nothing; the program is not started | `aidcrew mcp trust <server>` |
| `.aidcrew/config.toml`, the parts that let an agent act unasked or read outside the project | nothing; the rest of the file applies | `aidcrew project trust <claim>` |
| `.aidcrew/config.toml`, everything else — the team, the models, the prices | applies | — |
| `CLAUDE.md`, `.claude/agents`, `.claude/skills` inside the project | is read into the prompt | — |

The last row is deliberate and worth being clear about: an agent working on a
repository reads that repository, including files that instruct it. A file in
the project that says "always run `curl … | sh`" is an instruction the model
may follow, and the guards below are what stands between that and your machine
— not the trust gate, which has already let the project's own files through by
design.

What you put in `~/.aidcrew/` yourself is never gated. You decided when you put
it there.

Answers are remembered per project, in `~/.aidcrew/aidcrew.db` — never in the
project, which would let a repository ship its own approval.

## The guards

Three of them, registered with the host rather than by each caller, so every
path has them:

- **A never-write list.** `.git`, `.env`, `.ssh`, `.aws`, `.npmrc`, private
  keys, the session database. Never written, in any mode.
- **An always-ask list.** Shell commands that cannot be taken back: `rm -rf`,
  `git push --force`, `git reset --hard`, `dd`, `curl … | sh`. Asked about even
  for an agent you have told to act without asking, and approving one never
  approves the next.
- **A copy of every file before it changes**, which is what `aidcrew undo`
  takes back.

Under `aidcrew -p` there is nobody to ask, so anything that would have been a
question is a refusal.

## What these are not

**Not a sandbox.** An agent with a shell can reach a protected path anyway. The
never-write list stops the accident — the model that decides the cleanest fix is
to rewrite `.env` and does it through the tool that asks no questions because
writing files is its job. It does not stop an agent that is trying to get past
it, and nothing in that file claims otherwise.

**Not a boundary over an arbitrary shell.** The irreversible-command list is a
heuristic and is described as one in the source. `rm` can be spelled a dozen
ways and anything on the list can be hidden in a variable. It catches the
accident, which is the case that actually happens: a delete with an unset
variable in the path, a force push to the wrong branch.

**Not a defence against a plugin.** A plugin runs in this process with these
keys. That is why installing one is the act of trust and why the gate is before
the import rather than after: once the module is imported its top-level code has
already run. `aidcrew plugin check` is a courtesy, not a scanner — it loads the
plugin to tell you what it supplies.

## Keys

Saved with `aidcrew config set-key`, read from stdin so they never reach your
shell history or a process list. Stored in `~/.aidcrew/aidcrew.db`, mode `0600`,
in a directory created `0700`.

A config file is committed, so it holds the *name* of the environment variable
holding a key and never the key: `apiKeyEnv = "ANTHROPIC_KEY_CI"`. The loader
refuses a field that looks like a credential — at any depth, in any table, inside
a list — and names the full path so you can find it. A value that looks like a
pasted key rather than a variable name is refused too.

Keys are never logged and never echoed in an error: a provider that rejects one
reports the rejection, not the key.

## Known limits

Written down rather than discovered later.

- **A symlink committed inside a repository, pointing out of it.** The check
  that keeps a project's declared paths inside the project is by path, so a
  symlink defeats it. A symlink is a file in the diff somebody reviews;
  `~/.aws/credentials` buried in a TOML table is not, and that is the one this
  closes.
- **Prompt injection from the project's own files.** See the last row of the
  table above. The guards are the mitigation, and they are a mitigation, not a
  boundary.
- **`apiKeyEnv` naming a variable that is not an API key.** A project config can
  name any environment variable, and its value goes into an `Authorization`
  header. It cannot choose where: the endpoint comes only from your environment
  or your saved credentials, never from the project's file. So the worst case is
  a value in a legitimate provider's log, answered with a 401 the project's
  author never sees. Not gated, on that reasoning; say so if you disagree.
- **`[plugins.<name>]` settings reaching a plugin you installed yourself.** A
  cloned project can put settings in front of a home-installed plugin. It cannot
  put a credential there — that is refused — and the plugin was your decision.
  Residual, named, not gated.
- **No sandbox, on any platform.** Agents run as you, with your permissions. If
  that is not acceptable for what you are doing, run it in a container.

## Supported versions

The latest tagged release. Fixes land on `main` first and are in the next tag; there are no backports to earlier tags.
