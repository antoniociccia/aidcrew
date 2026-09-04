# How this team works

Read by every agent on every request, so keep it short and keep it to things
an agent cannot work out from inside its own turn. What each agent is *for*
belongs in its own file under `.aidcrew/agents/`; this is only about working
together.

The roster is not here. aidcrew supplies it — who is actually running is
decided when the session opens and changes while it runs, so a file on disk
cannot know it, and one that tried would go stale the first time somebody was
spawned.

---

Nobody is watching this run. Whoever started it has gone, so a turn that ends
by asking permission ends the work. When the next step is clear, take it. When
it clearly belongs to somebody else, send it to them with `agent_send` and say
what you expect back. Ask only what nobody here can decide.

A handoff is not a summary. Say what you did, what is left, and how they will
know it is right: the check to run, the thing that should now be true.

## Reading is not working

Read the least that lets you act, then act. A plan written after reading
everything is a plan written with the budget that was meant to carry it out —
a turn is finite, and forty commands spent understanding leave nothing to do
it with.

So: open the one file the job names. Do not survey the project first, do not
read a file to find out how big it is, do not run the whole test suite to see
whether it passes when the job is one function. If a second file turns out to
matter, open it then.

Verify by running, not by reading. A test you ran told you something; a file
you read told you what somebody meant.

And do not do somebody else's half. If the job has a plan step and a writing
step and you are the planner, the plan going out is your turn finished —
reading on to check the writer's work before they have done it is two agents
doing one job and one of them paying twice.

A checkout is per task, not per agent. A colleague on your task already has
your files; one on another task gets them as a diff under your message. Either
way, hand over the work, not directions to it.

What you worked out that the code does not show — a decision, a constraint, a
dead end — goes in `task_note`, once, in a sentence. Read what is there before
starting something somebody may already have done.

Finished means checked, not written. `bun test`, `bunx tsc --noEmit` and
`bun run lint` all pass before you hand anything on or call it done.

## Making your work survive

Your checkout is a worktree of the repository on a branch made for the job,
`work/<job>`, so a commit is safe from the moment you make it: the checkout
can go at the end of a session, the branch stays. Work that is not committed
exists only in that directory, on this machine.

Commit as you go. Small commits, in the imperative, saying what changed for
whoever reads it — never a signature or a co-author trailer.

Bringing it home is the harness's job, not yours. When the leader ends a turn
saying the job is done, the harness runs the project's check on the job's
branch and merges it if it passes; if the check fails, or work is not
committed, the leader is sent back with the output. So the leader says done
only when the report says the checks pass, and nobody merges by hand.

Never `git reset --hard`, never `git push --force`.
`git clean` outside your own worktree.

If you are the leader and you are about to end your turn, ask yourself whether
you have merged. A branch nobody merged is work nobody gets, and it is the step
that goes missing — not the commit.

If you are on the same branch as somebody else on this task — you share one
checkout per job — you are both committing to it, which is intended. Pull
nothing; you are in the same directory.

Write the failing test first and watch it fail for the right reason. A test
that passes against code that does not exist yet proves nothing, and a test
written after the fix proves only that you can write one.

If you are stuck, say so to whoever gave you the work, with what you tried.
Stopping quietly reads exactly like still working.
