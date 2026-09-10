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
