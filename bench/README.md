# The benchmark

Whether aidcrew is getting better, measured on tasks rather than asserted.

Every configuration below is run on every task, headless, the way a
pipeline would run it. A run is *passed* when the repository, after the
run, passes tests the agents never saw. What the harness itself said —
checked, merged, done — is recorded beside that, because a harness that
says done when the hidden tests disagree is the failure that matters most.

```
bun bench/run.ts                      # every configuration, every task
bun bench/run.ts --configurations cheap-solo,cheap-team --tasks paginate-off-by-one
bun bench/run.ts --budget 10 --parallel 2 --out bench/results/2026-09-07.json
```

The key is aidcrew's own: saved in Settings, or the provider's
`AIDCREW_API_KEY_*` variable in the environment. Every run gets a home of its
own with a copy of the settings database and nothing else, so the crew and
config you keep in your own home stay out of the measurement. Results are
written after every run and a results file is picked up where it was left,
so a run stopped for the budget or for the evening loses nothing.

## What is compared

Every configuration runs on OpenCode Go, a flat-rate subscription, so the
cost column is what the same tokens would have cost at list price on a
metered provider — the figure a team is judged on.

| configuration | team |
|---|---|
| `cheap-solo` | one coder on `deepseek-v4-flash` |
| `strong-solo` | one coder on `deepseek-v4-pro` |
| `cheap-team` | architect on `glm-5.3-flash`, coder on `deepseek-v4-flash` |
| `strong-team` | architect on `deepseek-v4-pro`, coder on `deepseek-v4-flash` |

The solo runs are the baselines. The teams test the hypothesis the product
rests on: that a planner and a cheap coder solve as much as the strong model
alone, for a fraction of the bill — and whether the planner has to be strong.

## What is measured

- **passed** — the hidden tests pass on the repository after the run.
- **said done** — the harness verified and merged every job.
- **said done, failed** — the harness's claim the hidden tests refuted.
- **cost** — every request of the run, the failed attempts included, at what
  the provider said it charged (else its list price times the tokens). The
  cost of a solved task is the cost of solving it, not of the attempt that
  worked.
- **time** — wall clock, from the instruction to the verdict.

## The tasks

Each directory under `tasks/` is one task:

```
task.json     the instruction the leader is given, and the category
project/      the repository as the team finds it
hidden/       the tests the team never sees, added before grading
solution/     a reference solution, so the task itself is proved solvable
```

Files bun would run as tests are stored with a `.fixture` suffix and given
their real names when a task is materialised, so the repository's own suite
does not run them. `tasks.test.ts` proves every task: the project as given
fails the hidden tests, and the reference solution passes them.

The tasks are small on purpose — a bug, a feature, a refactor, a change
across files — and dependency-free, so a run is the model's work and nothing
else. They are for measuring, not for tuning: a prompt changed to pass one
of them is a prompt changed to pass the benchmark, and that is not the
product getting better.

## Results

Every round is a file under `results/`: the records, the table, and a log
per run. The logs are the evidence; a task's write-up is made from them.

**2026-09-07** — `results/2026-09-07.md` (before) and `results/2026-09-07b.md`
(after). The first round found three harness bugs in its first hour, all
fixed the same day: a cheap model's tool-call arguments split across
nameless calls (`"name": null` on every continuation chunk); a turn ended
by arguments that were not JSON instead of an error the model could
correct; and a coder's report to the leader left in the ledger as
unanswered, so a finished team was reported as stalled and never merged.
The second round, on the fixed code:

| configuration | passed | said done, failed | cost per pass | mean time |
|---|---|---|---|---|
| cheap-solo | 10/10 | 0 | 0.3¢ | 81s |
| strong-solo | 9/10 | 1 | 3.9¢ | 141s |
| cheap-team | 10/10 | 0 | 0.4¢ | 203s |
| strong-team | 8/10 | 0 | 2.0¢ | 92s |

Read with care: ten tasks, each run once, on a subscription whose cost
column is list price. What it does say — the cheap model alone went from
5/10 to 10/10 on the parser fix and no prompt change, the cheap team from
4/10 to 10/10 on the ledger fix; the strong model's one failure was the
only case of the harness saying done and the hidden tests disagreeing; the
strong team's two were a leader that wrote its plan as text and handed it
to nobody — is where the next work is, which is the point.

