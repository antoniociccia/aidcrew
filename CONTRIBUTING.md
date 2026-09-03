# Contributing

The short version: write the failing test first, make the comments explain
why, and run the three checks before you say it is done.

```sh
bun install          # Bun 1.3 or later
bun test
bun run typecheck
bun run lint
```

`bun run build` makes a binary for this machine in `dist/`. `aidcrew demo`
exercises the whole loop with no key, which is the fastest way to see whether
you have broken something a test does not cover.

## The one rule with teeth

**A test that would pass against the code before your change proves nothing.**
Write it, run it, watch it fail, read the failure and make sure it fails for
the reason you meant. Then write the code.

This is not a style preference. A test written after the fix can pass at once
while checking a code path the fix never touched. When you are unsure, revert
the source and watch the test go red; if it stays green, it is not testing the
change.

A bug gets a test that reproduces it before it gets a fix.

## Comments

They explain **why**, never what. The code says what it does; a comment that
repeats it is deleted rather than written. What is worth a comment is the
reason a thing is the way it is, and especially the alternative that was tried
and did not work:

```ts
// Sequential on purpose: two calls in the same turn may touch the same file,
// and running them concurrently would make the outcome depend on whichever
// happens to finish first.
```

A constant with no comment is a constant nobody chose. Every limit, timeout
and default in this repository has the reason for its value written beside
it; a new one should too.

## Naming

Tests describe behaviour, not methods: `does not let it unleash an agent`, not
`testYolo`. The prose in `describe`/`test` is prose — write it as such.

Everything in the repository is in English: identifiers, comments, test names,
commit messages, fixtures, documents.

Commit subjects are lowercase sentences about behaviour — `a plugin can be told
things before it works`, not `Add setup hook`. The body explains what was wrong
and why this is the fix; assume the reader has the diff and needs the argument.

Never sign a commit with a co-author trailer or a generated-by line.

## The shape of the thing

- `packages/core` knows nothing about providers, tools or interfaces, and
  `packages/core/src/architecture.test.ts` fails the build if it learns. It has
  no runtime dependencies at all. If your change needs the core to know the
  name of a service, the change is in the wrong place — it belongs in a plugin.
- Everything that ships in `plugins/` loads through the same registry a
  stranger's plugin does. If the contract is not enough to express something,
  that is a problem with the contract.
- `packages/tui` is the interface and nothing else touches a screen.

## Security

Read [SECURITY.md](SECURITY.md) before touching anything that loads a file
somebody else wrote. The short version: what arrives with a clone is inert
until somebody types a command, and the answer is remembered in the user's own
store rather than in the project — a record kept in the project would let a
repository ship its own approval.

Never log a key, never echo one in an error, and never put one in a file that
gets committed. A config file names the environment variable; it does not hold
the value.

## Money

The cost meter must never be wrong in the flattering direction. A number that
is quietly a tenth of the truth is worse than no number: it is the one failure
this project could not recover from, because the bill is the thing it asks
people to trust it about. When a cost cannot be worked out honestly, the answer
is nothing — which reads as a question somebody asks — and never zero, which
reads as an answer they believe.

## Where help is welcome

Providers and plugins for services not yet covered; reports from real use on
Windows; corrections to the bundled price list and the model ranking, with a
link to the source; agent files and briefings that work well for a language or
a kind of project; palettes. Open a discussion first for anything that changes
the plugin contract or the core — those are the two places where a design
conversation saves a rewrite.

## Before you open a pull request

1. The three checks pass.
2. Every commit passes them on its own, so `git bisect` works.
3. The README says nothing your change made untrue.
