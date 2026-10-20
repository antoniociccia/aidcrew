---
name: decision-lab
description: Explore and select materially different approaches for open product, architecture or unresolved debugging decisions. Use when alternatives could change the outcome; skip routine implementation, factual lookups and bugs with an established cause.
license: MIT
---
# Decision Lab

Produce a decision worth testing, not a larger list of ideas. Preserve the user's
requirements, chosen stack, spend limits and authorization boundaries. An explicit
request for exploration activates this workflow; it does not authorize spending,
new agents, repository mutations or external actions beyond the existing scope.

## Frame the decision

Write a compact decision card: desired outcome, hard constraints, evidence already
available, the simplest viable baseline, and the uncertainty that could change the
choice. Reuse the brief and shared decisions instead of asking for them again.
Ask only for missing information that blocks a meaningful comparison; otherwise
label a reversible assumption. For a known fix, perform it without this ceremony.

## Choose the effort

**Lean is the default.** In the current turn, examine up to three distinct lenses
and produce at most six candidates. This is a single-context exploration, not
independent research. Keep familiar solutions eligible: simplicity can win.

**Team exploration** is useful when independent evidence could alter a consequential
choice and delegation is already authorized. Use at most three available, suitable
contributors, one bounded request each, and at most one subsequent challenge of the
leading option. These are limits per decision, not per retry. Keep within the user's
remaining budget; do not automatically switch models, spawn a crew, or repeat failed
branches. If spend cannot be measured, disclose that a call limit is not a dollar cap.

Send the same decision card with a different question to each contributor. Request
at most two candidates, each with mechanism, expected benefit, key assumption and a
cheap disconfirming test; keep each response around 200 words. Use parallel calls
only when the runtime supports them. An AIDCrew `agent_send` handoff can reuse existing
history and shared memory: do not claim fresh-context isolation. For actual independent
first passes, withhold peer proposals until the collection barrier and use isolated
contexts only if available. Otherwise describe the work as cross-checking. Never wait
by polling an agent; end the turn and resume on its response.

## Seek different mechanisms

Select questions that expose the decision's uncertainty, for example:

- What could disappear if one responsibility moved to the client, server or user?
- Which approach still works at one tenth of the operating budget?
- What happens during disconnection, a partial write or a contradictory update?
- Which existing component makes a custom subsystem unnecessary?
- What would make the user's first successful action substantially easier?
- Which assumption would reverse the recommendation if disproved?

Generate before judging. Candidates must differ in how they solve the problem;
rename-only variants do not earn slots. Combine duplicates and stop when another
lens adds no new mechanism. Do not invent novelty to fill the allowance.

## Select with evidence

Reject violations of hard constraints first. Compare the remaining candidates with
the baseline on user value, implementation effort, operating cost, reversibility
and the strength of supporting evidence. Use qualitative judgments with a concrete
reason; estimates are not measurements and subjective scores are not benchmarks.

Challenge the best alternative with its likeliest failure and hidden maintenance
cost. Prefer a reversible experiment when uncertainty dominates. If every candidate
fails, identify the blocking constraint rather than choosing a cosmetically highest
score. A second exploration needs new evidence or a changed requirement.

## Return to execution

Recommend one option, retain at most two meaningful alternatives, and state:

- why the recommendation beats the baseline under the current constraints;
- the assumption most likely to invalidate it;
- the smallest verification step and its observable pass/fail condition;
- the owner and next action within the already authorized task.

For debugging, recommend a discriminating test before a speculative rewrite. For
implementation already requested, continue with the selected reversible step; for
an ideas-only request, stop at the recommendation. Do not launch a separate planning
cycle for every file or polish change.

In AIDCrew shared memory, retain only the decision, supporting evidence, rejected
tradeoff and condition for revisiting it. Keep raw candidate pools out of recurring
handoffs. Report actual extra calls and cost when available; otherwise mark cost
unknown. Do not claim this skill enforces runtime budgets, isolation or better results.
