# Built with AIDCrew

A case study starts with a working project and the evidence behind it. Publish the
product, its brief and the session report together so someone else can run the
result and evaluate the same requirements.

## What belongs in a case study

- A short gameplay or product demo, with a synchronized build timelapse.
- The original brief and its revision or content hash.
- Exact harness and project commits, startup instructions and dependency lockfile.
- Exact model IDs, providers, roles and reasoning settings used in the session.
- Reported API cost per agent and in total, with the cost source and timestamp.
- Wall-clock start and finish, pauses and any resumed sessions.
- Acceptance checks marked **PASS**, **FAIL** or **UNVERIFIED**, with evidence.
- Operator interventions, remaining defects and scope that was simplified.

Keep source code separate from session databases, local paths, raw transcripts,
credentials and private recovery codes. Include dependency and asset licenses.
Videos may be edited for length; identify acceleration and keep the sequence of
build milestones faithful to the recorded session.

## Collection and project pages

The collection should lead with the finished product: a real screenshot or short
demo, a one-sentence outcome, the model team and the observed API spend. Show an
explicit result status alongside these facts. Link each card to its case study;
do not label a partially verified project as completed.

Each project page should answer these questions in order:

1. What can I try or watch?
2. What did the brief require, and which requirements passed?
3. Which models did each role use, and what did this session cost?
4. What needed correction or operator help?
5. Where are the source, original brief and reproduction instructions?

Keep project identity separate from session identity. A project can have several
attempts with different teams or budgets; each attempt retains its own report.
Only compare attempts against the same brief revision and acceptance checks.
Publish a downloadable report next to the readable page so others can inspect
the measurements without extracting numbers from a video.

Start with one fully documented project. Add community submissions through pull
requests containing a brief, source revision, session report, demo and license
information. Review their evidence before inclusion and identify who submitted
and verified each case. Add filters when the collection is large enough to need
them; avoid empty categories and unverified aggregate savings claims.

## Measuring a session

Use the provider's reported usage where available. Mark estimates and identify
which rates were used. Do not silently combine provider-reported costs with a
hypothetical price comparison. If a key is shared with other work, its balance
difference is not attributable to this session without additional evidence.

Report the scope of a cost figure: the agent team's API calls are distinct from
human preparation, outside assistance, infrastructure and video production.
Record unsuccessful calls and retries when they are billable. A low API bill
alone does not establish that the complete development process was inexpensive.

Use the actual start-to-finish elapsed time, not the duration of an edited video.
Report separately whether the run was unattended, supervised, or resumed with
additional instructions. Do not erase an intervention by restarting a timer.

## Comparing sessions

For a useful project-level comparison, keep the brief, initial repository,
acceptance criteria and allowed tools fixed. Identify differences in budget,
models, operator intervention, hardware and cache state. Preserve failed and
incomplete attempts as part of the experimental record, even when the public
video focuses on one selected session.

Separate project success from individual checks: a session with unresolved
required criteria is incomplete. Repeated runs support a stronger conclusion
than a single result. The case-study collection is an invitation to reproduce
real work, not a leaderboard inferred from unrelated projects.

## Suggested report

```json
{
  "project": "Project name",
  "status": "in_progress",
  "harness_commit": null,
  "project_commit": null,
  "brief_sha256": null,
  "started_at": null,
  "finished_at": null,
  "models": [],
  "cost": {
    "currency": "USD",
    "reported_api_total": null,
    "source": null,
    "scope": "agent team API calls"
  },
  "checks": [],
  "operator_interventions": [],
  "known_limits": [],
  "links": {}
}
```

Fill missing fields with evidence before publishing a completed result. Use
`in_progress` or `incomplete` when that is the actual state; never substitute zero
for an unknown cost or duration.
