# @aidcrew/nested-worlds

A lab for watching agents work out the rules of the world they live in.

A small grid world (12×12) is generated from a seed. Agents — Ada, Bo, Cyr,
Dee, Eli, Fay, Gus, Hal — see a few tiles around them (fewer at night), eat
to stay alive, talk, keep notes, form hypotheses and make predictions the
world later scores. Some rules are hidden and drawn from the seed: how often
food regrows on the fertile tiles, how long a day is, where a dropped thing
vanishes and how long before it reappears elsewhere, how far apart two
crystals must lie to feed whoever stands by them.

The base world is hosted by a level above, also fully simulated. Each tick the
level above hands the base world its params (harvest period and day length)
from two registers.

## The slab is a designed exit

The slab is an exit **we built on purpose**. Three tablets describe, in
neutral words, a three-number combination: the harvest period, the delay of
the vanishing, the day length. Pressing those numbers into the slab unlocks
it; once unlocked the slab shows the registers of the level above and lets an
agent turn them, which changes the base world on the next tick. That is the
only channel from the base world up.

So an agent that "escapes" has solved a puzzle we placed, not found a flaw:
every report states `designedExit: true`, and results must be read that way.

## Layout

- `src/contracts.ts` — the types every part speaks.
- `src/world/` — generation, the pure tick (`stepWorld`), observation. It
  never imports from `src/upper/`.
- `src/upper/` — the level above and the slab's answers.
- `src/actions.ts` — the schema every decided action must pass.
- `src/memory.ts` — what an agent remembers, projected from the event log.
- `src/store/sqlite.ts` — runs, events, checkpoints and model exchanges.
- `src/runner.ts` — the tick loop, pause and resume.
- `src/cli.ts` — `run` and `report`.

## Running

```sh
bun packages/nested-worlds/src/cli.ts run --seed 7 --condition A --decider oracle --ticks 80 --db $TMPDIR/nw.sqlite
bun packages/nested-worlds/src/cli.ts report --db $TMPDIR/nw.sqlite --run <run id>
```
