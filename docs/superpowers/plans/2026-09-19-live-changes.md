# Live Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show every file change as it is made, let a person revert one hunk of
it without stopping the agent, and warn when two agents are about to edit the
same lines in different worktrees.

**Architecture:** The core gains one generic field on `ToolOutput` — `shown`,
which the interface reads and the model never does. `tool-fs` computes a diff
for `write` and `edit` and puts it there. The TUI paints rows whose first
character is the marker (`+ - ~ …`). `hooks-guard`, which already snapshots
the previous bytes of every change, gains a revert that puts one hunk back and
an in-memory index of open line ranges that spots collisions.

**Tech Stack:** Bun 1.3, TypeScript strict, Ink for the TUI, `bun test`,
zero new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-19-live-changes-design.md`

## Global Constraints

- Code, comments, JSDoc, test names and commit messages in English. User-facing
  strings are English too: that is this product's language.
- No `any`. `strict: true` holds. No new dependency in any package.
- `packages/core` must not name a tool, a provider or a service: the field
  added there is `shown: { kind: string; text: string; id?: string }`, never
  `'diff'`.
- TDD: the failing test first, then the smallest code that passes it.
- Conventional Commits. No `Co-Authored-By`, no AI attribution, ever.
- `bun test`, `bun run typecheck` and `bun run lint` must pass before each commit.

---

### Task 1: The diff engine

**Files:**
- Create: `plugins/tool-fs/src/diff.ts`
- Test: `plugins/tool-fs/src/diff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
```ts
export type Hunk = {
  oldStart: number      // 1-based, 0 when the hunk only adds
  oldLines: string[]
  newStart: number      // 1-based, 0 when the hunk only removes
  newLines: string[]
}
export type FileChange = {
  path: string
  added: number
  removed: number
  hunks: Hunk[]
  /** Lines the caps left out. */
  elided: number
  created: boolean
}
export function changeOf(path: string, before: string, after: string): FileChange | undefined
export function render(change: FileChange): string
export function rangesOf(change: FileChange): [number, number][]
```
`changeOf` returns `undefined` when nothing changed. `render` produces the
text for `shown.text`: one row per line, the first character a marker —
`~` header, `+` addition, `-` removal, ` ` context, `…` elision.

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, test } from 'bun:test'
import { changeOf, rangesOf, render } from './diff.ts'

describe('changeOf', () => {
  test('says nothing changed when nothing did', () => {
    expect(changeOf('a.ts', 'one\n', 'one\n')).toBeUndefined()
  })

  test('counts what a replacement added and removed', () => {
    const change = changeOf('a.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')
    expect(change?.added).toBe(1)
    expect(change?.removed).toBe(1)
    expect(change?.hunks).toHaveLength(1)
    expect(change?.hunks[0]?.newStart).toBe(2)
  })

  test('keeps two lines of context around a change', () => {
    const before = Array.from({ length: 20 }, (_, i) => `L${i + 1}`).join('\n')
    const after = before.replace('L10', 'CHANGED')
    const hunk = changeOf('a.ts', before, after)?.hunks[0]
    expect(hunk?.newStart).toBe(8)
    expect(hunk?.newLines).toEqual(['L8', 'L9', 'CHANGED', 'L11', 'L12'])
  })

  test('a file that did not exist is all additions', () => {
    const change = changeOf('new.ts', '', 'hello\n')
    expect(change?.created).toBe(true)
    expect(change?.removed).toBe(0)
    expect(change?.added).toBe(1)
  })

  test('a trailing newline does not become a phantom line', () => {
    expect(changeOf('a.ts', 'one', 'one\n')?.added).toBe(0)
  })

  test('carriage returns are not a change of every line', () => {
    expect(changeOf('a.ts', 'one\r\ntwo\r\n', 'one\r\nTWO\r\n')?.added).toBe(1)
  })
})

describe('render', () => {
  test('marks every row so the painter needs no column arithmetic', () => {
    const change = changeOf('a.ts', 'one\ntwo\n', 'one\nTWO\n')
    const rows = render(change as never).split('\n')
    expect(rows[0]).toBe('~ a.ts +1 -1')
    expect(rows.some((row) => row.startsWith('- '))).toBe(true)
    expect(rows.some((row) => row.startsWith('+ '))).toBe(true)
    expect(rows.every((row) => '~+- …'.includes(row[0] as string))).toBe(true)
  })

  test('caps a large change and says how much it left out', () => {
    const before = ''
    const after = Array.from({ length: 200 }, (_, i) => `L${i + 1}`).join('\n')
    const rendered = render(changeOf('big.ts', before, after) as never)
    expect(rendered.split('\n').length).toBeLessThanOrEqual(14)
    expect(rendered).toContain('more lines')
  })
})

describe('rangesOf', () => {
  test('gives the lines of the new file a hunk covers', () => {
    const change = changeOf('a.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')
    expect(rangesOf(change as never)).toEqual([[1, 3]])
  })
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test plugins/tool-fs/src/diff.test.ts`
Expected: FAIL, `Cannot find module './diff.ts'`.

- [ ] **Step 3: Write the engine**

A line-level LCS over the two files, hunks grown with `CONTEXT = 2`, capped at
`MAX_HUNKS = 3` and `MAX_ROWS_PER_HUNK = 12`, `render` emitting the marker
rows, `rangesOf` reading `newStart` and `newLines.length`.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test plugins/tool-fs/src/diff.test.ts`

- [ ] **Step 5: Commit**

```bash
git add plugins/tool-fs/src/diff.ts plugins/tool-fs/src/diff.test.ts
git commit -m "feat(fs): work out what a change did, line by line"
```

---

### Task 2: The channel the model does not read

**Files:**
- Modify: `packages/core/src/loop.ts` (the `ToolOutput` type; `resultOf`)
- Test: `packages/core/src/loop.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ToolOutput.shown?: { kind: string; text: string; id?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
test('what a tool shows a person never reaches the model', async () => {
  const tool = {
    name: 'paint',
    description: 'paints',
    inputSchema: { type: 'object' },
    async execute() {
      return { content: 'done', shown: { kind: 'diff', text: '~ a.ts +1 -0' } }
    },
  }
  const events = await collect(run({ ...base, tools: [tool] }))
  const result = messagesOf(events).flatMap((message) => message.content)
    .find((block) => block.type === 'tool_result')
  expect(result?.content).toBe('done')
  expect(JSON.stringify(result)).not.toContain('a.ts')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/core/src/loop.test.ts -t "never reaches the model"`
Expected: FAIL — the property does not typecheck.

- [ ] **Step 3: Add the field**

```ts
export type ToolOutput = {
  stalled?: string
  content: string
  isError?: boolean
  /**
   * What a person should see of this result, which the model never reads.
   *
   * A write reports "wrote a.ts (412 bytes)" because that is all the model
   * needs; what the person wants is the change itself, and putting it in
   * `content` would spend tokens on every write. `kind` is an open string:
   * the core carries this, it does not interpret it.
   */
  shown?: { kind: string; text: string; id?: string }
}
```
`resultOf` is not touched — that is the point of the test.

- [ ] **Step 4: Run the core suite**

Run: `bun test packages/core`

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/loop.ts packages/core/src/loop.test.ts
git commit -m "feat(core): a tool result may carry something for the person"
```

---

### Task 3: write and edit attach the change

**Files:**
- Modify: `plugins/tool-fs/src/tools.ts`, `plugins/tool-fs/src/index.ts`
- Test: `plugins/tool-fs/src/tools.test.ts`

**Interfaces:**
- Consumes: `changeOf`, `render` from Task 1; `ToolOutput.shown` from Task 2.
- Produces: `write` and `edit` outputs carrying `shown.kind === 'diff'` and
  `shown.id` — `${path}@${Date.now()}`, the handle the veto later names.

- [ ] **Step 1: Write the failing tests**

```ts
test('an edit shows the person what it changed', async () => {
  writeFileSync(join(root, 'a.ts'), 'one\ntwo\n')
  const output = await editTool.execute({ path: 'a.ts', oldString: 'two', newString: 'TWO' }, context)
  expect(output.content).toBe('edited a.ts (1 replacement)')
  expect(output.shown?.kind).toBe('diff')
  expect(output.shown?.text).toContain('- 2 two')
  expect(output.shown?.text).toContain('+ 2 TWO')
})

test('a write of a new file shows it as an addition', async () => {
  const output = await writeTool.execute({ path: 'new.ts', content: 'hello\n' }, context)
  expect(output.shown?.text.split('\n')[0]).toContain('new.ts')
  expect(output.shown?.text).toContain('+ 1 hello')
})

test('a write that changes nothing shows nothing', async () => {
  writeFileSync(join(root, 'a.ts'), 'same\n')
  const output = await writeTool.execute({ path: 'a.ts', content: 'same\n' }, context)
  expect(output.shown).toBeUndefined()
})

test('a binary file is written without a diff rather than with a broken one', async () => {
  writeFileSync(join(root, 'b.bin'), Buffer.from([0, 1, 2]))
  const output = await writeTool.execute({ path: 'b.bin', content: 'text\n' }, context)
  expect(output.isError).toBeFalsy()
  expect(output.shown).toBeUndefined()
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test plugins/tool-fs/src/tools.test.ts`

- [ ] **Step 3: Read before writing, and attach**

`write` reads the previous contents first (missing file, or one holding a NUL
byte, means no diff). `edit` already holds `text` and builds `updated`, so it
has both sides. Both call `changeOf` and attach `render(change)`.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test plugins/tool-fs`

- [ ] **Step 5: Commit**

```bash
git add plugins/tool-fs/src
git commit -m "feat(fs): write and edit show the change they made"
```

---

### Task 4: The change on screen

**Files:**
- Modify: `packages/tui/src/transcript.ts` (`Kind`, `rowsOf`)
- Modify: `packages/tui/src/runtime.ts` (`toLines`, the `tool_end` case)
- Modify: `packages/tui/src/screens/session.tsx` (`Line`, `transcriptRow`)
- Test: `packages/tui/src/runtime.test.ts`, `packages/tui/src/transcript.test.ts`,
  `packages/tui/src/screens/session.test.tsx`

**Interfaces:**
- Consumes: `tool_end` events whose `output.shown.kind === 'diff'`.
- Produces: `Line.kind` includes `'diff'`; one `Line` per rendered row.

- [ ] **Step 1: Write the failing tests**

```ts
// runtime.test.ts
test('a change an agent made becomes rows a person can read', () => {
  const lines = toLines({
    type: 'agent_event',
    id: 'coder',
    event: {
      type: 'tool_end',
      id: '1',
      name: 'edit',
      durationMs: 1,
      output: { content: 'edited a.ts', shown: { kind: 'diff', text: '~ a.ts +1 -1\n- 2 two\n+ 2 TWO' } },
    },
  } as never)
  expect(lines.map((line) => line.kind)).toEqual(['diff', 'diff', 'diff'])
  expect(lines[1]?.text).toBe('- 2 two')
})

test('a result with nothing to show adds no rows', () => {
  const lines = toLines({
    type: 'agent_event', id: 'coder',
    event: { type: 'tool_end', id: '1', name: 'read', durationMs: 1, output: { content: 'ok' } },
  } as never)
  expect(lines).toEqual([])
})

// transcript.test.ts
test('a long line of code is cut rather than wrapped', () => {
  const rows = toRows([{ kind: 'diff', text: `+ 1 ${'x'.repeat(200)}` }], 20, 5)
  expect(rows).toHaveLength(1)
  expect(widthOf(rows[0]?.text as string)).toBeLessThanOrEqual(18)
})

// session.test.tsx
test('additions and removals are told apart by colour', () => {
  const added = transcriptRow({ kind: 'diff', text: '+ 2 TWO', first: true }, '#fff', theme, undefined, false)
  const removed = transcriptRow({ kind: 'diff', text: '- 2 two', first: true }, '#fff', theme, undefined, false)
  expect(added.segments.at(-1)?.color).toBe(theme.ok)
  expect(removed.segments.at(-1)?.color).toBe(theme.bad)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/tui`

- [ ] **Step 3: Carry the rows through**

`Kind` and `Line['kind']` gain `'diff'`. `toLines` splits `shown.text` on
newlines when `shown.kind === 'diff'`, one `Line` each. `rowsOf` cuts a diff
entry to the width instead of folding it — a wrapped line of code in a
25-column pane is noise, and a continuation row has no marker to colour by.
`transcriptRow` reads `text[0]`: `+` is `theme.ok`, `-` is `theme.bad`, `~` is
the agent's own colour and bold, `…` and ` ` are `theme.faint`.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test packages/tui`

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src
git commit -m "feat(tui): show a change as it is made, in the pane that made it"
```

---

### Task 5: Putting one hunk back

**Files:**
- Create: `plugins/hooks-guard/src/revert.ts`
- Test: `plugins/hooks-guard/src/revert.test.ts`
- Modify: `plugins/hooks-guard/src/index.ts`

**Interfaces:**
- Consumes: `changes`, `undoRoot`, `UNDO_DIR` from `./undo.ts`; `changeOf` from
  `@aidcrew/tool-fs`.
- Produces:
```ts
export type Revertable = {
  /** Index into `changes(workspace)`, oldest first. */
  at: number
  path: string
  agentId: string
  when: number
  hunks: Hunk[]
}
export function revertable(workspace: string): Revertable[]
export function revertHunk(
  workspace: string, at: number, hunk: number,
): { ok: true; path: string; lines: [number, number] }
 | { ok: false; because: 'moved' | 'gone' | 'outside' }
```

- [ ] **Step 1: Write the failing tests**

```ts
test('putting a hunk back restores exactly the bytes that were there', () => {
  writeFileSync(file, 'one\ntwo\nthree\n')
  keep(root, 'a.ts', 'coder', 1)              // the guard's snapshot
  writeFileSync(file, 'one\nTWO\nthree\n')
  const [change] = revertable(root)
  expect(revertHunk(root, change!.at, 0)).toMatchObject({ ok: true, path: 'a.ts' })
  expect(readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n')
})

test('refuses rather than guessing when the agent has moved the lines since', () => {
  writeFileSync(file, 'one\ntwo\n')
  keep(root, 'a.ts', 'coder', 1)
  writeFileSync(file, 'one\nTWO\n')
  writeFileSync(file, 'one\nSOMETHING ELSE\n')
  const [change] = revertable(root)
  expect(revertHunk(root, change!.at, 0)).toEqual({ ok: false, because: 'moved' })
})

test('leaves the other hunks of the same change alone', () => {
  writeFileSync(file, ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n'))
  keep(root, 'a.ts', 'coder', 1)
  writeFileSync(file, ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'L'].join('\n'))
  const [change] = revertable(root)
  revertHunk(root, change!.at, 0)
  const text = readFileSync(file, 'utf8')
  expect(text.startsWith('a\n')).toBe(true)
  expect(text.endsWith('L')).toBe(true)
})

test('a journal line naming somewhere outside the workspace is dropped, not obeyed', () => {
  appendFileSync(journal, `${JSON.stringify({ path: '../../.zshrc', at: 2, agentId: 'coder' })}\n`)
  expect(revertable(root).some((one) => one.path.includes('.zshrc'))).toBe(false)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test plugins/hooks-guard/src/revert.test.ts`

- [ ] **Step 3: Write the revert**

`revertable` reads the journal, drops entries failing the same containment
check `undo()` uses, and recomputes hunks from the kept bytes against the file
as it stands. `revertHunk` checks the hunk's new lines are still where it left
them (`moved` otherwise), splices the old lines back, and writes. The journal
entry stays: reverting is a change like any other, and undoing a revert is a
thing people want.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test plugins/hooks-guard`

- [ ] **Step 5: Commit**

```bash
git add plugins/hooks-guard/src
git commit -m "feat(guard): take back one hunk of a change, or say why not"
```

---

### Task 6: The changes screen, and the veto

**Files:**
- Create: `packages/tui/src/screens/changes.tsx`
- Modify: `packages/tui/src/app.tsx` (the `Screen` union, `^v`, mounting)
- Modify: `packages/tui/src/screens/session.tsx` (the shortcut row)
- Modify: `packages/tui/src/runtime.ts` (`revert(agentId, path, lines, reason)`)
- Test: `packages/tui/src/screens/changes.test.tsx`, `packages/tui/src/runtime.test.ts`

**Interfaces:**
- Consumes: `revertable`, `revertHunk` from Task 5; `host.deliver` through the
  runtime's existing `tell`.
- Produces: `Runtime.revert(at: number, hunk: number, reason: string): Promise<string>`,
  returning what to say on screen.

- [ ] **Step 1: Write the failing tests**

```ts
test('reverting tells the agent, inside the turn it is taking', async () => {
  const told: { id: string; text: string }[] = []
  const runtime = makeRuntime({ tell: async (id, text) => { told.push({ id, text }) } })
  await runtime.revert(0, 0, 'the default is missing')
  expect(told[0]?.id).toBe('coder')
  expect(told[0]?.text).toContain('reverted your edit to a.ts')
  expect(told[0]?.text).toContain('the default is missing')
})

test('with no reason given it still says not to make it again unchanged', async () => {
  await runtime.revert(0, 0, '')
  expect(told[0]?.text).toContain('do not make it again unchanged')
})

test('a refusal is reported and the agent is not told anything', async () => {
  const said = await runtime.revert(99, 0, '')
  expect(said).toContain('has moved')
  expect(told).toHaveLength(0)
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test packages/tui/src/runtime.test.ts -t revert`

- [ ] **Step 3: Write the screen and the wiring**

`changes.tsx` follows `workspaces.tsx`: a list, `↑↓`/`jk` to move, `x` to
revert the hunk under the cursor, a one-line reason field, `esc` to close.
`app.tsx` gets `{ at: 'changes'; cwd: string }` and opens it on `^v`. The
session's shortcut row gains `['^v', 'changes']`.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test packages/tui`

- [ ] **Step 5: Commit**

```bash
git add packages/tui/src
git commit -m "feat(tui): take back a change while the agent keeps working"
```

---

### Task 7: The collision radar

**Files:**
- Create: `plugins/hooks-guard/src/collide.ts`
- Test: `plugins/hooks-guard/src/collide.test.ts`
- Modify: `plugins/hooks-guard/src/plugin.ts` (`GuardOptions.onCollision`, `postToolCall`)
- Modify: `packages/tui/src/runtime.ts` (the notice, and telling the other agent)

**Interfaces:**
- Consumes: `rangesOf` from `@aidcrew/tool-fs`.
- Produces:
```ts
export type Open = { agentId: string; file: string; ranges: [number, number][]; at: number }
export type Collision = { file: string; mine: string; theirs: string; lines: [number, number]; since: number }
export function fileOf(path: string): string        // strips .aidcrew/wt/<task>/
export function createRadar(slack?: number): {
  saw(open: Open): Collision[]
  finished(agentId: string): void
}
```

- [ ] **Step 1: Write the failing tests**

```ts
test('two agents on the same lines of the same file, in two worktrees', () => {
  const radar = createRadar()
  radar.saw({ agentId: 'architect', file: '.aidcrew/wt/plan/src/rates.ts', ranges: [[8, 14]], at: 1 })
  const hit = radar.saw({ agentId: 'coder', file: '.aidcrew/wt/rates/src/rates.ts', ranges: [[10, 12]], at: 2 })
  expect(hit).toEqual([{ file: 'src/rates.ts', mine: 'coder', theirs: 'architect', lines: [10, 12], since: 1 }])
})

test('the same agent twice is not a collision', () => {
  const radar = createRadar()
  radar.saw({ agentId: 'coder', file: 'a.ts', ranges: [[1, 3]], at: 1 })
  expect(radar.saw({ agentId: 'coder', file: 'a.ts', ranges: [[1, 3]], at: 2 })).toEqual([])
})

test('lines that never meet are not a collision', () => {
  const radar = createRadar()
  radar.saw({ agentId: 'a', file: 'x.ts', ranges: [[1, 3]], at: 1 })
  expect(radar.saw({ agentId: 'b', file: 'x.ts', ranges: [[40, 42]], at: 2 })).toEqual([])
})

test('lines that nearly meet are, because a merge does not split hairs', () => {
  const radar = createRadar()
  radar.saw({ agentId: 'a', file: 'x.ts', ranges: [[1, 3]], at: 1 })
  expect(radar.saw({ agentId: 'b', file: 'x.ts', ranges: [[5, 6]], at: 2 })).toHaveLength(1)
})

test('a job that has come home stops colliding with anybody', () => {
  const radar = createRadar()
  radar.saw({ agentId: 'a', file: 'x.ts', ranges: [[1, 3]], at: 1 })
  radar.finished('a')
  expect(radar.saw({ agentId: 'b', file: 'x.ts', ranges: [[1, 3]], at: 2 })).toEqual([])
})
```

- [ ] **Step 2: Run them and watch them fail**

Run: `bun test plugins/hooks-guard/src/collide.test.ts`

- [ ] **Step 3: Write the radar and hook it up**

`createRadar` keeps the open ranges per agent, `slack = 3`. In `postToolCall`,
after a successful write or edit, the guard feeds it `rangesOf` and, on a hit,
appends one sentence to `output.content` — which is the acting agent's copy —
and calls `options.onCollision`. The runtime turns that into a notice and a
`tell` to the other agent. `finished` is called when a job comes home.

- [ ] **Step 4: Run them and watch them pass**

Run: `bun test plugins/hooks-guard packages/tui`

- [ ] **Step 5: Commit**

```bash
git add plugins/hooks-guard/src packages/tui/src
git commit -m "feat(guard): see two agents about to collide, before git does"
```

---

### Task 8: The browser, and the record

**Files:**
- Modify: `plugins/web-ui/src/` (the client's line painter)
- Modify: `README.md`, `CHANGELOG.md`
- Test: whichever web-ui test covers rendering lines

**Interfaces:**
- Consumes: `lines[].kind === 'diff'` — already carried by `WebState`.
- Produces: nothing other code depends on.

- [ ] **Step 1: Write the failing test**

```ts
test('a change is coloured in the browser as it is in the terminal', () => {
  expect(classOf({ agentId: 'coder', kind: 'diff', text: '+ 2 TWO' })).toBe('line diff add')
  expect(classOf({ agentId: 'coder', kind: 'diff', text: '- 2 two' })).toBe('line diff del')
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test plugins/web-ui`

- [ ] **Step 3: Paint it, then write it down**

The same marker rule as the TUI, and the same caps. `README.md` gains the
three rows in "What is here"; `CHANGELOG.md` gains the entry.

- [ ] **Step 4: Run everything**

Run: `bun test && bun run typecheck && bun run lint`

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(web-ui): the same change, the same colours, in the browser"
```
