# Working on AIDCrew

This repository is the harness itself: a Bun and TypeScript monorepo with the
agent runtime in `packages/core`, CLI in `packages/cli`, terminal interface in
`packages/tui`, and integrations in `plugins`. Read the relevant package and its
tests before changing behavior. Preserve existing uncommitted work.

## Development rules

- Use TDD for features and fixes: reproduce the behavior with a failing test,
  implement it, then refactor. Use Bun's native test runner.
- Keep TypeScript strict. Validate external inputs at runtime. Never build shell
  commands by concatenating untrusted input.
- Consider OWASP risks for the changed boundaries. Keep secrets out of source,
  logs, fixtures and commits. Report failures explicitly without sensitive data.
- Use English for code, comments, test names, logs, commit messages and docs.
  User-facing content belongs in translation catalogs in the product language.
- Prefer small changes and Conventional Commits. Never add AI attribution or
  co-author trailers to commits or pull requests.
- Do not push, create or update a pull request, merge a pull request, publish a
  release or deploy without explicit user consent for that specific action.
  Never push directly to main. Changes reach main through a pull request.
- Follow the applicable language rules in `~/.claude/rules/` when available.

## Checks

Run relevant tests while developing. Before declaring a change complete, run
`bun test --timeout 30000`, `bun run typecheck` and `bun run lint`. Fix failures
caused by the change. Update relevant documentation when behavior changes.
Use `bun run build` to verify executable packaging changes.

## Team context

Follow the assigned role and the current harness roster. Read `ORCHESTRATE.md`
for handoffs and shared task notes; the explicit consent rules above still apply.
Use the supplied AIDCrew MCP tools to communicate and share findings with the
team. Do not create unrelated Claude sessions to perform a teammate's work.

For native Claude integration, see `plugins/agent-native/README.md`. Native
tool permissions are managed by Claude Code; harness guards protect the shared
MCP tools. Never treat a role's tool list as a native sandbox.

Start the terminal interface from this repository with `AIDCREW_WEB=0 bun start`.
After sending a task to a native agent, `/native` attaches to its existing Claude
Code session; Ctrl+] returns to the harness without stopping the agent.
