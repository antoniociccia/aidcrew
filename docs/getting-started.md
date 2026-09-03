# Trying aidcrew

Three ways to see it work, from the one that needs nothing to the one that
shows what it is actually for.

Everything below assumes you are in the repository and have run `bun install`.

---

## 1. Without any API key

```sh
aidcrew demo
```

One command: it makes the throwaway project, runs the agent against it, and
shows you the file before and after. That is the whole of this section for
anybody who just wants to see it work.

The rest of it is the same thing taken apart, which is worth reading if you are
going to change the harness rather than use it.

**Terminal one** — the model that does not exist:

```sh
bun examples/fake-provider.ts
```

**Terminal two** — a project with a failing check:

```sh
mkdir -p /tmp/try-aidcrew && cd /tmp/try-aidcrew
echo 'export const add = (a, b) => a - b' > math.js
cat > check.sh <<'EOF'
#!/bin/bash
node -e "import('./math.js').then(m => process.exit(m.add(2, 2) === 4 ? 0 : 1))"
EOF
chmod +x check.sh
./check.sh; echo "check exits $?"   # 1 — the bug
```

Point aidcrew at the fake model and let it work:

```sh
cd -   # back to the aidcrew repository
AIDCREW_PROVIDER=openai-compat \
AIDCREW_BASE_URL=http://localhost:8787/v1 \
AIDCREW_API_KEY=not-a-real-key \
AIDCREW_MODEL=fake \
  bun packages/cli/src/main.ts -p "the check fails, fix it" -C /tmp/try-aidcrew
```

You should see it run the check, read the file, edit it and run the check
again. Then:

```sh
cd /tmp/try-aidcrew && ./check.sh; echo "check exits $?"   # 0 — fixed
```

---

## 2. With a real model

Keys are saved once, not exported every time:

```sh
bun packages/cli/src/main.ts config set-key provider:zen
# type or paste the key when asked — it is never echoed,
# never stored in your shell history, and never printed back

bun packages/cli/src/main.ts config set default.provider zen
bun packages/cli/src/main.ts config set default.model <a-model-id>

bun packages/cli/src/main.ts config     # what is configured, keys shown as ••••1234
```

Then, in any project:

```sh
bun packages/cli/src/main.ts -p "what does this project do?" -C ~/some/project
```

**Providers that work out of the box** — `zen`, `openrouter`, `deepseek`,
`openai`, `ollama`, `anthropic`, and `openai-compat` for anything else that
speaks the OpenAI dialect (set `AIDCREW_BASE_URL` or save a base URL).

**A locally served model**, no key and no account:

```sh
ollama serve &
ollama pull qwen3-coder      # or any model you already have
bun packages/cli/src/main.ts config set default.provider ollama
bun packages/cli/src/main.ts config set default.model qwen3-coder
echo "unused" | bun packages/cli/src/main.ts config set-key provider:ollama
```

If a model's tool calling is missing or unreliable — common on small local
models and behind some gateways — turn on prompted tool calling and it works
anyway:

```sh
bun packages/cli/src/main.ts config set provider.ollama.promptedTools 1
```

---

## 3. A team on several models

This is the part no other harness does. Each agent runs on its own model, with
its own key, and every job gets a git worktree of its own.

Agents come from the files you already have. If you use Claude Code, yours are
already in `.claude/agents/` and nothing needs converting. Otherwise:

```sh
mkdir -p .claude/agents
cat > .claude/agents/architect.md <<'EOF'
---
name: architect
description: Plans the work and hands it over.
---
You design the change and explain it. You do not write code.
EOF

cat > .claude/agents/reviewer.md <<'EOF'
---
name: reviewer
description: Reviews changes.
---
You review code and report problems. You never edit.
EOF
```

Then say who is on the team, and on what:

```toml
# .aidcrew/config.toml — commit this; it holds no secrets
[agents.architect]
provider = "anthropic"
model = "claude-opus-5"

[agents.coder]
provider = "deepseek"
model = "deepseek-chat"

[agents.reviewer]
provider = "zen"
model = "free-tier"
tools = ["read", "bash"]     # reviews, cannot write
```

A key per service, or per agent when two share a service on different plans:

```sh
bun packages/cli/src/main.ts config set-key provider:anthropic
bun packages/cli/src/main.ts config set-key agent:architect   # its own plan
```

Run the team:

```sh
bun packages/cli/src/main.ts team -p "add VAT to the pricing function"
```

Each agent works in `.aidcrew/wt/<agent>`, so they cannot overwrite each
other. At the end you get one line per agent saying what it touched, and your
working tree is untouched until you take the changes you want.

---

## Where things live

| What | Where | Committed? |
|---|---|---|
| Keys and personal defaults | `~/.aidcrew/aidcrew.db` | never |
| Who is on the team, on what model | `.aidcrew/config.toml` | yes |
| Agents, skills, instructions | `.claude/agents`, `.claude/skills`, `CLAUDE.md` | yes |
| Agent worktrees, kept while there is work in them | `.aidcrew/wt/` | no — gitignored |

Environment variables still work and win over saved settings, for CI and
one-off runs: `AIDCREW_MODEL`, `AIDCREW_API_KEY`,
`AIDCREW_API_KEY_<PROVIDER>`, `AIDCREW_BASE_URL`.
