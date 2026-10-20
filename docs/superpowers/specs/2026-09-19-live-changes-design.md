# Live changes: seeing them, vetoing them, and not colliding

Status: approved, not yet implemented.
Date: 2026-09-19.

## The problem

An agent that writes a file reports `wrote src/rates.ts (412 bytes)`. That is
the whole of what a person is shown about the only part of the run that
changes anything. The work is invisible while it happens and legible only
afterwards, by reading the checkout.

Three consequences, and they get worse the more agents are running:

- You cannot tell a good change from a bad one until it has been made, merged
  or read by hand.
- A change you disagree with can only be stopped by stopping the agent, which
  throws away the rest of its turn.
- Two agents editing the same lines in two worktrees find out at merge time,
  which is the most expensive moment to find out.

## What is being built

Three pieces, one story: see every change as it is made, take one back with a
keystroke without stopping the team, and be told when two agents are about to
collide.

### 1. A channel the model does not read (core)

`ToolOutput` gains one optional field:

```ts
export type ToolOutput = {
  content: string
  isError?: boolean
  stalled?: string
  /** What a person should see of this result. Never sent to the model. */
  shown?: { kind: string; text: string; id?: string }
}
```

`kind` is an open string rather than a `'diff'` literal. `architecture.test.ts`
forbids the core from knowing what a tool is, and that has to keep holding:
the core carries this field, it does not interpret it. `tool-fs` sets
`kind: 'diff'`; a stranger's plugin can set `kind: 'table'` and get the plain
painter rather than the coloured one.

`resultOf()` does not change: what reaches the model is `content` and nothing
else. A test asserts it, so the field cannot later grow into the prompt by
accident.

`LoopEvent.tool_end` already carries `output`, so the diff reaches the
interface without a new event. `WebState.lines` is already
`{ agentId, kind: string, text }`, so a new kind reaches the browser without a
protocol change.

### 2. The diff is computed by whatever made the change (tool-fs)

`plugins/tool-fs/src/diff.ts`, no dependencies: a line-level LCS, two lines of
context, hunks with their line ranges.

`write` and `edit` compute it, not the guard. The edit knows exactly what it
changed; the guard's snapshot is an implementation detail of undo; and someone
who turns the guards off still wants to see the work. `write` reads the
previous contents before overwriting — it is about to write the file anyway —
and a file that did not exist is a diff of additions.

Caps, because three panes side by side are about 25 columns each: at most 12
lines per hunk and 3 hunks per change, then `+18 more lines`. A created file
shows its first 8 lines and the count. The full text stays on disk.

### 3. On screen (tui, web-ui)

`Line.kind` gains `'diff'`. In a pane: a header — `✎ src/rates.ts +2 −1` —
then the lines, `theme.ok` for additions and `theme.bad` for removals over the
agent's own tint, line numbers in `theme.faint`. Wrapping happens at the row
edge as it already does, without breaking the sign column.

Above that, a changes screen on `^v` — the one chord this interface still has
free: every change of the session in order, who made it, in which worktree,
scrollable hunk by hunk. That is where the veto lives. `x` reverts the hunk
under the cursor and the reason is typed there, the way `d` deletes on the
settings and workspaces screens.

Not a bare key in a pane. A pane is the field you type instructions into, and
`x` there is the letter x. The pane stays readable for the same reason: it
shows the work, it does not become a review interface.

The web UI receives the new kind as text and needs only to colour it.

### 4. The veto (hooks-guard, tui)

The unit is the hunk. That is safe because we generated the diff ourselves:
reverting a hunk means putting its old lines back where its new lines are in
the file *as it stands now*, and before writing, that the new lines are still
there is checked. If the agent has since rewritten that region, nothing is
guessed: the screen says so and offers to take the file back to its state
before that change, naming how many later changes that would discard.

The old bytes are not hunted for. `hooks-guard` already keeps them, before
every `write` and `edit`, under `.aidcrew/undo/`. The revert module lives
beside `undo.ts` and imports the diff from `@aidcrew/tool-fs`, a dependency
that plugin already has.

The agent learns of it through a channel that exists. `deliver()` splices a
message from a person into the turn in flight, at the next step of the loop,
so the coder reads

> a person reverted your edit to src/rates.ts:10-14. Reason: the default is missing

while it is still working, rather than a turn later. With no reason given the
sentence is still explicit: reverted, do not make it again unchanged, ask.

### 5. The radar (hooks-guard, tui)

Detection is nearly free. Every agent's worktree is under `.aidcrew/wt/<task>`
and `undoRoot()` resolves to the repository, so every agent's changes already
land in one journal, carrying the worktree in the path. With that prefix
stripped, "the same file" is a string comparison, and "the same lines" comes
from the ranges the diff has just computed, with three lines of slack at the
edges.

The index of open ranges is in memory, per agent, and is emptied when a job
comes home. No new on-disk format, and no `git status` per write.

On an overlap: a sentence appended to the tool result of whoever just wrote
(`postToolCall` may already do that), a `tell` to the other agent, and a notice
on screen through an `onCollision` callback passed to the guard the way `ask`
already is. Nobody is blocked — this repository says that a guard which blocks
the task gets turned off within the hour.

## Data flow

```
edit/write ──shown{kind:'diff'}──▶ ToolOutput ──▶ tool_end ──▶ agent_event
                                                                   │
                                                    ┌──────────────┴───────────┐
                                                    ▼                          ▼
                                            tui: Line{kind:'diff'}      web: lines[]
                                                    │
                                              ^g changes screen ──x──▶ revert(hunk)
                                                                           │
                                                          host.deliver(user message)
guard.postToolCall ──ranges──▶ open-range index ──overlap?──▶ onCollision ──▶ notice
                                                          └──▶ note in tool result
                                                          └──▶ tell(other agent)
```

## Error handling

- A diff that cannot be computed (binary, unreadable) is simply not attached.
  Seeing the change is a courtesy; the write already happened.
- A revert whose anchor has moved refuses and explains, rather than writing at
  a guessed offset.
- A revert writes through the same containment check `undo()` uses: a journal
  line naming somewhere outside the workspace is dropped, not obeyed.
- `onCollision` and `ask` are optional. Headless runs have neither and behave
  exactly as they do today.

## Security

File contents now travel to the browser, and the web UI is reachable remotely
through a tunnel. The bridge is already authenticated, so this is new exposure
rather than a new hole. Therefore: the caps apply there too, and the existing
setting that hides absolute paths hides diffs as well.

The revert path writes files on a person's word, from a journal an agent can
write. It reuses `within()`, which is why that function exists.

## Testing

Test first, in three deliverable stages — diff, veto, radar — each green
before the next.

- diff: table-driven — insertion, deletion, replacement, created file, no
  trailing newline, CRLF, wide characters, the caps.
- veto: apply-then-revert returns the original bytes; a moved anchor refuses;
  containment.
- radar: adjacent, contained and disjoint ranges; two worktrees of one
  repository; the same agent twice is not a collision.
- tui: painted rows, which is how this project already tests the screen.
- e2e: a fake provider that calls `edit`, asserting the diff reaches the pane.

## Out of scope

Per-language syntax highlighting (a parser and a dependency), intra-line word
diffs, and a computed merge order.
