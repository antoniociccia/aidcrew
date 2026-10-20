# Decision Lab

Decision Lab helps a crew choose between different approaches before spending turns
implementing one. It lives in [the bundled skill catalog](../plugins/tool-skills/skills/decision-lab/SKILL.md)
and uses the existing loader and `skill` tool. No new agent runtime or dependency is
required. Only its name and description enter the skill index; the body loads on demand.

The default is a bounded exploration in one context. Team mode adds up to three
contributor requests and one challenge when delegation is authorized and useful.
The output is a recommendation, its critical assumption and a concrete verification
step. These are model instructions, not enforced accounting or scheduling limits.
No improvement in cost or task success has been measured yet.

## Availability

Decision Lab ships inside the `tool-skills` plugin and compiled executables. It is
available without project skill directories, including when `[sources] skills = []`.
That setting controls external skill discovery; it does not remove bundled skills.
Every AIDCrew agent receives the read-only `skill` tool as a host-wide capability,
even when its agent file lists only a subset of tools.
The shared instruction hook serves CLI, TUI and Web UI sessions; the skill body
is never injected automatically. Agent tool lists continue to restrict other capabilities such as shell and file writes.

A local skill with the same name overrides the bundled definition, using the existing
loader precedence. Put overrides in a configured skills directory and restart the
session. No installation command, network download or new core dependency is needed.
The change ships with the next build/release; an already installed binary or running
session does not update itself.

An example request:

> Use decision-lab to compare synchronization approaches for our collaborative
> board. Keep the existing stack and budget. Recommend the smallest experiment
> that distinguishes the leading alternatives.

## Design provenance

The idea of contrasting perspectives before selecting an approach was inspired by
[ADHD by UditAkhourii](https://github.com/UditAkhourii/adhd/blob/main/skills/adhd/SKILL.md),
published under MIT. Decision Lab is independently written for AIDCrew; it does not
bundle the upstream prompts, frame table, CLI or implementation. It prioritizes a
cheap default, an explicit baseline, evidence over novelty scores, honest context
sharing, bounded handoffs and a return to execution.

## Validation

The catalog integration test verifies retrieval without project files, description-only
instructions and local overrides and retrieval. Runtime tests verify access for restricted agents,
late-spawned agents and discovered project skills in shared UI sessions. This establishes integration,
not behavioral effectiveness. Evaluate the latter on matched tasks with fixed criteria,
tracking extra calls, total spend, interventions and whether the selected approach
passes its stated verification. Include simple tasks where the skill should be skipped
and conflicting constraints where it must decline to invent a viable option.
