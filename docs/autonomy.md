# Reliable work within a budget

## Current behavior

In YOLO mode, an explicit tool stall ends the current attempt. The harness gives
that instruction one recovery turn directing the agent to inspect existing
failure evidence, change approach and verify the original acceptance criteria.
A second stall is reported to the delegating owner with a bounded excerpt of the
last explanation. A direct user instruction leaves the blocker visible in the UI.
Ask mode stops and reports the blocker without automatic recovery.

Stop, a stopped agent, or queued instructions prevent recovery from being added.
Recovery is agent-initiated for turn-budget purposes even when the original task
came from the user. Existing token budgets, permissions and tool guards remain in
force. This cannot guarantee that a model chooses a useful alternative.

The generic tool guard recognizes identical calls/results. The Chromium plugin
also recognizes explicit repeated page-reported rejection outcomes. Neither is
visual understanding or proof that an arbitrary application is progressing.

Shared notes are deduplicated for the same author. Older accumulated summaries
are capped at 2,400 characters with an explicit omission marker; recent notes are
preserved. Older context beyond that bound is omitted explicitly; keep durable
project decisions in repository documentation. Concurrent compaction
requests share one operation and do not erase newer notes.

Default team instructions request one outstanding assignment per milestone,
observable acceptance checks, and named commits for review. This is guidance;
it does not lock a shared checkout while a reviewer works.

## Next measured milestones

1. Run the same bugfix, feature and new-project briefs with fixed acceptance
   checks, recording completion, agent API cost, active time and interventions.
2. Compare baseline and recovery behavior across repeated runs, including failed
   runs in cost-per-completed-task calculations. Do not infer a savings percentage
   from context-size tests alone.
3. Add opt-in model escalation with an explicit per-role fallback, spend ceiling,
   visible routing and accounting. Keep automatic escalation disabled until the
   routing experiment shows its cost and completion trade-off.
4. Add immutable review snapshots and structured milestone verdicts, so a review
   cannot silently apply to a different commit.
5. Expand the phone companion from the private bridge to device pairing and
   revocation if a hosted service is needed. The current bridge uses Tailscale
   identity and transport; AIDCrew operates no public relay.

Remote setup: [Web UI](../plugins/web-ui/README.md#private-bridge-and-phone-companion).
