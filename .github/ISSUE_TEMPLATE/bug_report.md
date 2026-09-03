---
name: Bug report
about: Something an agent, a tool or the interface did that it should not have
labels: bug
---

**What happened, and what you expected instead**

**How to see it**

The command or the keystrokes, and the project shape if it matters (a git
repository with no commits, a directory that is not one, a plugin of yours).

**The record**

Every session is written to `~/.aidcrew/projects/<your-project-path>/session.jsonl`,
one line per thing that happened. The lines around the moment it went wrong
are the fastest way to a fix — search for `"kind":"error"`. Take out anything
you would not want on a public issue: the record holds tool output and the
contents of files that were read.

**Setup**

- `aidcrew --version`:
- Provider and model the agent was on (`.aidcrew/config.toml`):
- OS:
