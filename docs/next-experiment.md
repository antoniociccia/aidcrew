# Next experiment: a new application

Status: proposed application; no run started and no model budget allocated.

## Proposed brief

Build **AIDCrew Roam**, a responsive application for planning a trip with friends.
Use an original visual identity: warm colors, clear typography, destination cards
and a readable day-by-day itinerary. Make the main workflow usable on a phone.

A trip owner can create a trip, invite participants, propose activities, move
activities between days, and record shared expenses. Participants can vote on
activities and see itinerary changes without manually refreshing the page.
Show each participant's balance using integer minor currency units and a single
currency per trip. Divide expenses equally among selected participants, with
deterministic handling of rounding remainders. Settlement suggestions are
informational; do not integrate payments.

Persist trips, membership, activities, votes and expenses in SQLite. Use revocable
invitation links, exchange invitations for individual sessions, and enforce trip
membership on the server. Keep session and invitation secrets out of logs. The
owner must be able to revoke an invitation and remove a participant.

Include an explicitly labeled sample trip using fictional participants and local
assets. Seed it once without overwriting user changes. Do not require external
services, paid APIs, map credentials or an AI feature inside the application.
Any illustrative destination map must be clearly labeled as schematic.

Provide a documented launch command, an automated verification command, meaningful
tests, and a concise README. Deliver the core workflow before optional animations
or decorative features. Keep the preview available while developing.

## Acceptance scenarios

1. Create a trip in browser session A; join it through an invitation in independent
   session B. Session C without membership cannot read or modify the trip.
2. Add and move an activity in A. B sees the change within five seconds without a
   manual refresh. Moving it does not duplicate it.
3. B votes on an activity. Repeating the same request does not add another vote;
   a participant can change or withdraw their vote.
4. Record an expense of 10.00 split among three participants. Allocated shares sum
   to exactly 10.00 and all participant balances sum to zero, including after an
   expense edit or deletion.
5. Restart the server. Trips, membership, votes and expenses survive, and the
   sample trip does not overwrite edits.
6. Revoke an invitation: it no longer admits new participants. Remove B: its
   existing session can no longer access the trip, including any live updates.
7. Complete the core workflow at a 390-pixel viewport and with keyboard navigation.
   Primary controls remain visible without horizontal page scrolling.
8. Run the documented checks successfully against the final commit, then perform
   the two-session workflow in the browser. Report any unchecked criteria.

## Experiment protocol

Before starting, freeze the brief, team configuration, exact model identifiers,
spend ceiling and verification command. Keep the run isolated from earlier project
files. Model selection and the new spend ceiling remain to be decided.

Record model usage and cost per agent, retries, recovery attempts, verification
outcomes, and any additional human instructions or cancellations. Distinguish
provider-reported cost from estimates and unknown pricing. Do not label unknown
cost as zero.

Measure elapsed run time separately from active harness time. Concurrent agent
work counts once toward active wall time; an idle interval is not evidence of
completion. If recording starts late, mark the measurement as partial. Do not
claim these measurements are automated until the reporting feature is implemented.

Publish only a reviewed report without prompts, tokens, invitation URLs, personal
paths or raw transcripts. Link the tested source commit and show both the verified
result and remaining limitations. A later run can reuse the same brief and checks
to compare a different crew configuration.
