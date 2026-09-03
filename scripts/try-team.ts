/**
 * A throwaway project with a real bug, for watching a team work by itself.
 *
 * This is the check that `ORCHESTRATE.md` and the team briefing do anything:
 * the instruction goes to ONE agent and names nobody else. If the run ends
 * with the test passing, the architect decided on its own to hand the work to
 * the coder and the coder decided on its own to hand it to the tester — which
 * is the whole claim, and which nothing before this asked anybody to do.
 *
 *   bun scripts/try-team.ts              set it up, run it, say what happened
 *   bun scripts/try-team.ts --keep       leave the directory behind to poke at
 *   bun scripts/try-team.ts --setup-only just build it and print the path
 *
 * It builds in a temporary directory and never touches this repository's own
 * config or checkout.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const keep = process.argv.includes('--keep')
const setupOnly = process.argv.includes('--setup-only')

/**
 * Models that answered when this was written.
 *
 * `aidcrew models check` is the way to find out for yourself — but read its
 * answer as a snapshot rather than a verdict: it reported `Internal server
 * error` for a model that answered perfectly well a minute later, and a team
 * pointed at a model having a bad minute looks exactly like a team that will
 * not co-operate. Set TRY_PLANNER and TRY_WORKER to try others.
 */
const PLANNER = process.env.TRY_PLANNER ?? 'glm-5.3'
const WORKER = process.env.TRY_WORKER ?? 'kimi-k2.7-code'
const PROVIDER = process.env.TRY_PROVIDER ?? 'opencode-go'

const root = mkdtempSync(join(tmpdir(), 'aidcrew-try-'))

mkdirSync(join(root, '.aidcrew', 'agents'), { recursive: true })
mkdirSync(join(root, 'src'), { recursive: true })

// The bug: the cap is applied after the discount instead of before, so a
// large order slips under the cap once the discount has shrunk it and is
// charged too much. One test fails and one passes, which is the shape a real
// regression has — and it is one edit to fix, so a slow model can still finish.
//
// Checked by running it, not by reading it: the first version of this fixture
// was already correct, and the whole team spent a turn each proving that a
// test which passes proves nothing.
writeFileSync(
  join(root, 'src', 'total.ts'),
  `export function total(items: number[], discount: number): number {
  const sum = items.reduce((a, b) => a + b, 0)
  return Math.min(sum * (1 - discount), 100)
}
`,
)

writeFileSync(
  join(root, 'src', 'total.test.ts'),
  `import { expect, test } from 'bun:test'
import { total } from './total.ts'

test('caps the order before the discount is taken off', () => {
  expect(total([60, 60], 0.5)).toBe(50)
})

test('leaves an order under the cap alone', () => {
  expect(total([20, 20], 0.5)).toBe(20)
})
`,
)

writeFileSync(
  join(root, 'package.json'),
  `${JSON.stringify({ name: 'try-team', private: true, type: 'module' }, null, 2)}\n`,
)

// Three agents whose descriptions differ enough that "who should this go to"
// has an answer. The descriptions are what the roster line carries, so they
// are the only thing telling one agent from another at handoff time.
const agents: [string, string, string][] = [
  [
    'architect',
    'Plans a change and hands it over. Does not edit files.',
    'You plan changes. You read the code, decide what should happen, and explain it precisely\n' +
      'enough for somebody else to carry out. You do not edit files.',
  ],
  [
    'coder',
    'Writes the code. Does not decide what to write.',
    'You carry out a plan. You edit the files it names and nothing else.',
  ],
  [
    'tester',
    'Runs the checks and says plainly whether they passed.',
    'You prove work is done. You run the tests and report exactly what happened, including\n' +
      'the output when something failed. You do not fix things yourself.',
  ],
]

for (const [id, description, body] of agents) {
  writeFileSync(
    join(root, '.aidcrew', 'agents', `${id}.md`),
    `---\nname: ${id}\ndescription: ${description}\n---\n\n${body}\n`,
  )
}

writeFileSync(
  join(root, '.aidcrew', 'config.toml'),
  `[defaults]\nprovider = "${PROVIDER}"\nmodel = "${WORKER}"\nsharedMemory = true\n` +
    `leader = "architect"\n\n` +
    `[agents.architect]\nprovider = "${PROVIDER}"\nmodel = "${PLANNER}"\n\n` +
    `[agents.coder]\nprovider = "${PROVIDER}"\nmodel = "${WORKER}"\n\n` +
    `[agents.tester]\nprovider = "${PROVIDER}"\nmodel = "${WORKER}"\n`,
)

// A copy of this repository's own ORCHESTRATE.md, minus the checks a fixture
// project does not have — there is no tsconfig here to typecheck. It is a copy
// and copies drift: the third run of this script tested wording that had
// already been fixed in the real file, and reported a failure that was mine.
// If you change the git discipline in one, change it in both.
writeFileSync(
  join(root, 'ORCHESTRATE.md'),
  `# How this team works

Everything above the rule is a note to whoever edits this file. The agents
never see it — which is the thing to change first if you want to prove this
file is being read at all.

---

Nobody is watching this run. Whoever started it has gone, so a turn that ends
by asking permission ends the work. When the next step is clear, take it. When
it clearly belongs to somebody else, send it to them with \`agent_send\` and say
what you expect back.

A handoff is not a summary. Say what you did, what is left, and how they will
know it is right: the check to run, the thing that should now be true.

You each work in your own checkout, so the others cannot see your files. What
you changed travels with your message as a diff.

Finished means checked, not written. \`bun test\` passes before you hand
anything on or call it done.

## Making your work survive

Your checkout is a worktree on a detached HEAD. When the session ends it is
removed with \`--force\`, and anything not reachable from a branch goes with it —
committed or not. A commit on a detached HEAD is unreachable, so committing is
not enough on its own.

Before you change anything:

    git switch -c work/total-cap 2>/dev/null || git switch work/total-cap

The fallback is not decoration: you share one checkout with everybody else on
this task, so whoever gets there second finds the branch already made.

Then commit.

Bringing it home is the team leader's job. Every job reports back to them, so
they do not have to be told. The leader merges when the report says it passes,
not when it thinks everyone has finished:

    git -C "$(git rev-parse --git-common-dir)/.." merge --no-ff --no-edit work/total-cap

If you are the leader and you are about to end your turn, ask yourself whether
you have merged. A branch nobody merged is work nobody gets, and it is the step
that goes missing — not the commit.

Never \`git reset --hard\`, never \`git push --force\`.
`,
)

// A repository with a commit in it, because a worktree is a checkout and an
// empty repository has nothing to check out. Without this the agents share
// one directory and the half of the briefing about separate checkouts — and
// the diff a handoff carries — is never exercised at all.
for (const argv of [
  ['init', '-q'],
  ['add', '-A'],
  ['-c', 'user.email=try@aidcrew', '-c', 'user.name=try', 'commit', '-qm', 'the bug'],
]) {
  Bun.spawnSync(['git', ...argv], { cwd: root })
}

// Proved to fail before anybody is asked to fix it. The first version of this
// fixture was already correct, and three agents spent a turn each discovering
// that a test which passes asks nothing of them.
const before = Bun.spawnSync([process.execPath, 'test'], { cwd: root })
const firstRun = new TextDecoder().decode(before.stderr) + new TextDecoder().decode(before.stdout)
if (!/1 fail/.test(firstRun)) {
  console.error('the fixture does not fail, so the run would prove nothing:')
  console.error(firstRun)
  process.exit(1)
}

console.log(`built ${root}`)
console.log('  1 of 2 tests fails, as it should before anybody is asked')
console.log(`  planner ${PLANNER}, worker ${WORKER}, on ${PROVIDER}`)

if (setupOnly) {
  console.log(`\n  cd ${root}`)
  console.log('  aidcrew team -p "make the failing test pass" --to architect')
  process.exit(0)
}

// The instruction names one agent and no others. Nothing in it says to hand
// anything over, which is the point: if the work reaches the coder, it is
// because the briefing told the architect that there was one.
const run = Bun.spawn(
  [
    process.execPath,
    join(import.meta.dir, '..', 'packages', 'cli', 'src', 'main.ts'),
    'team',
    '-p',
    'The test in src/total.test.ts fails. Get it passing.',
    '--to',
    'architect',
    '-C',
    root,
  ],
  { cwd: root, stdout: 'pipe', stderr: 'pipe', env: { ...process.env } },
)

const [out, err] = await Promise.all([
  new Response(run.stdout).text(),
  new Response(run.stderr).text(),
])
const transcript = out + err
const code = await run.exited
process.stdout.write(transcript)

// Read off the run rather than off the checkout. `aidcrew team` removes every
// worktree when it stops — `git worktree remove --force`, uncommitted work
// included, deliberately: headless, the diff in the summary is the output and
// the checkout you started in is never written to. So looking at src/total.ts
// afterwards tells you nothing, which is what the first version of this
// script did and why it reported failure over a run that had worked.
const handedOver = /agent_send\(|→ \w+/.test(transcript)
const edited = /· (edit|write)\(/.test(transcript)

// The one that cannot be faked by a transcript: is the fix in the checkout
// you started in? It is there only if somebody branched, committed and
// merged, because the worktree that held it has been removed by now.
//
// Asked as "nothing fails and the branch moved" rather than by counting
// passes. Counting them said a run had failed when the team had landed the
// fix and added a test of their own along the way — the count was the
// assertion's business and never the run's.
const after = Bun.spawnSync([process.execPath, 'test'], { cwd: root })
const result = new TextDecoder().decode(after.stderr) + new TextDecoder().decode(after.stdout)
const green = /\b0 fail\b/.test(result) && /\b[1-9]\d* pass\b/.test(result)
const merged =
  new TextDecoder()
    .decode(Bun.spawnSync(['git', 'rev-list', '--count', 'HEAD'], { cwd: root }).stdout)
    .trim() !== '1'

// Reported apart, because they fail apart. Committing on a branch is what
// makes the work survive the worktree; merging is what makes anybody get it,
// and it is the step that goes missing — it used to be left to "whoever
// finishes last", and nobody ever knows they are last.
const branched = new TextDecoder()
  .decode(Bun.spawnSync(['git', 'branch', '--list', 'work/*'], { cwd: root }).stdout)
  .trim()
const survived = branched !== ''
const worked = handedOver && edited && survived && merged && green

console.log('\n--- what this proves ---')
console.log(
  handedOver
    ? '  yes  somebody handed the work on, and nothing in the instruction said to'
    : '  NO   nobody handed anything on — the briefing did not land',
)
console.log(
  edited ? '  yes  somebody edited the code' : '  NO   nothing was edited; read the turns above',
)
console.log(
  '\nThe instruction went to architect alone and named no one else. Every handoff\n' +
    'above was decided by an agent, from the roster and ORCHESTRATE.md in its prompt.',
)
console.log(
  survived
    ? `  yes  the work survived the worktree, on ${branched.trim()}`
    : '  NO   nothing was committed to a branch — it died with the worktree',
)
console.log(
  merged && green
    ? '  yes  it was merged home: the checkout you started in now passes'
    : '  NO   nothing was merged — the branch is there, but nobody gets it',
)
console.log(
  '\nThose two fail apart. A worktree is detached, so a commit in one is on no\n' +
    'branch and dies with it; a branch survives but reaches nobody until somebody\n' +
    'merges, and merging is the step that gets dropped.',
)
const log = Bun.spawnSync(['git', 'log', '--oneline', '-5'], { cwd: root })
console.log(`\n${new TextDecoder().decode(log.stdout).trim()}`)

if (keep) console.log(`\nleft at ${root}`)
else rmSync(root, { recursive: true, force: true })

process.exit(worked ? 0 : (code ?? 1) || 1)
