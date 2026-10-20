# Native Claude Code team member

The bundled `agent-native` plugin runs the installed, unmodified Claude Code CLI
as an AIDCrew agent. It retains an interactive Claude session in the agent's task
checkout. The agent receives its role, team roster, orchestration instructions
and current task context; its replies complete the normal AIDCrew handoff.

## Configure

Install Claude Code separately and sign in through its own terminal flow:

```sh
claude
```

Claude Code 2.1.295 or newer must be on `PATH` for HTTP hook failure blocking.
Native team sessions currently require macOS or
Linux and a runtime with Bun 1.3.5 or newer PTY support. AIDCrew does not import
Claude credentials or accept an Anthropic API key for this provider. Sign in
with your Claude subscription using `claude auth login`. The provider checks
Claude's authentication status before launching and before new prompts: only a
first-party `claude.ai` login with a recognized subscription is accepted.
Missing, API-key, cloud-provider or unknown authentication stops the turn; there
is no API fallback. The check does not send a model request or log account data.

API keys, bearer tokens, OAuth-token overrides, provider selectors and Anthropic
profile overrides are removed from the child environment. Session settings also
clear API-key helpers and known credential variables. Your shell, saved login
and other agents' credentials are unchanged. Native Claude still owns account
limits and any extra-usage billing settings; this is authentication enforcement,
not a replacement for Claude's usage controls.

Use an existing role from your project's agent definitions, for example `coder`,
in `.aidcrew/config.toml`:

```toml
[agents.coder]
provider = "claude-code"
model = "native"
```

`native` leaves model selection to Claude Code. A concrete model or alias, such
as `sonnet`, selects the initial native model. Once the native session exists,
change its model with Claude's `/model`. Changing the model or provider through
AIDCrew while idle closes the old native session; the next instruction starts a
fresh session with the selected model. Stop an active turn before changing it.
The AIDCrew model label does not track later native `/model` changes.

Other team members can keep using their existing providers and models.

## Work with the same agent from either interface

Send the agent an instruction through AIDCrew first. This creates its native
session with the correct task and role context. Select that agent and use
`/native` in the terminal UI, or open its **Native terminal** tab in the Web UI.
Both attach to the existing process; neither starts an unrelated Claude session.

The native terminal passes input directly to Claude Code. Its slash commands,
interactive pickers, login and permission dialogs remain native. Available
commands depend on your installed Claude version, account and platform. AIDCrew
does not substitute its own slash-command implementation in this terminal.

Press **Ctrl+]** to return from the terminal attachment to AIDCrew. In the
browser, **Detach** disconnects the display without stopping the agent; reconnect
reattaches and replays a bounded window of terminal output. A terminal allows one
browser attachment at a time.

Plain prompts entered in the native terminal are adopted into the AIDCrew agent's
turn lifecycle. A second prompt during an active AIDCrew turn is blocked; send
follow-up instructions through the AIDCrew composer to queue them. Local Claude
commands continue to follow Claude's own command handling.

## Team communication and permissions

An authenticated local MCP bridge exposes the tools assigned to the AIDCrew
agent, including team communication and shared-note tools when available. Claude
can use those tools to hand work to teammates and contribute to shared memory.
Bridged calls pass through AIDCrew's tool hooks and guards. Prompt hooks supply
updated harness context; completion hooks return the final reply to the host.

Claude Code also keeps its own native tools. Its native Bash, file editing and
other tools use **Claude Code's permission system**, not AIDCrew's MCP tool
guards. Explicitly setting an agent's `yolo = true` launches Claude Code with
`--dangerously-skip-permissions`; the default keeps native permission prompts.
Changing this setting requires an idle agent and closes its retained native
process before the next turn. Harness history is preserved. A role's tool
allowlist does not restrict native tools: do not treat an AIDCrew read-only role
as a sandbox for this provider.

## Current limits

- Harness-delivered instructions support text only. Terminal control characters
  in those instructions are rejected before they reach the PTY.
- Token counts and subscription cost are unavailable to AIDCrew. An unavailable
  cost is not a claim that the run is free. Use Claude's `/usage` for its account
  and plan information.
- The harness transcript contains the final reply, bridged tool activity, and
  native tool progress labeled `native:Read`, `native:Bash`, and similar names.
  Native progress includes generic completion or failure and duration, never
  native inputs, outputs or error payloads. The native terminal shows Claude's
  full interactive output and permission dialogs; use `/native` to inspect them.
- Custom Claude `Stop` hooks that block completion and make Claude continue are
  not supported by the completion bridge. AIDCrew may observe its own `Stop`
  notification before another hook rejects completion and mark the turn finished
  too early. Do not use that hook combination with a native team member.
- Cancelling an active native turn closes its native process. Browser detachment
  alone leaves it running. Process persistence is within the running harness;
  this integration does not restore the same PTY after a harness restart.
- Resetting an idle agent's conversation closes its native session too, so the
  next instruction cannot reuse the cleared native conversation.
- Ctrl+C or standalone Escape during an accepted turn aborts and closes the
  native session, including Escape inside a native menu. Claude does not emit a
  completion hook on interruption; closing prevents a permanently busy harness
  agent. Idle menus and arrow-key sequences retain their native behavior.

`aidcrew claude [args...]` is also available as a direct launcher for the installed
CLI. That standalone launcher does not join the AIDCrew team; use the provider
configuration above for shared context and team communication.

See Claude Code's [authentication documentation](https://code.claude.com/docs/en/iam),
[native commands](https://code.claude.com/docs/en/commands) and
[integration and credential conditions](https://code.claude.com/docs/en/legal-and-compliance).
