/**
 * Shell commands that cannot be taken back.
 *
 * These always ask, even for an agent running unattended, and approving one
 * never approves the next. That is the whole point: "stop asking me" is a
 * statement about routine work, and none of these are routine.
 *
 * This is a heuristic and it is described as one. Over an arbitrary shell no
 * pattern list is a boundary — `rm` can be spelled a dozen ways, and anything
 * here can be hidden in a variable. It catches the accident, which is the case
 * that actually happens: a delete with an unset variable in the path, a force
 * push to the wrong branch, a reset that throws away an hour. It does not
 * catch an agent that is trying to get past it, and nothing in this file
 * should be read as claiming otherwise.
 */

export type Danger = { what: string }

const IRREVERSIBLE: { pattern: RegExp; what: string }[] = [
  // The flags may be spread over several words (`-v -rf`) or spelled out
  // (`--recursive --force`); a pattern that only read the first word after
  // `rm` let both of those through while asking about `rm -rf`.
  {
    pattern: /\brm\s+(?:-[\w-]+\s+)*(?:-[a-zA-Z]*[rRf]|--(?:recursive|force)\b)/,
    what: 'deletes files for good',
  },
  { pattern: /\bfind\b[^\n|;&]*\s-delete\b/, what: 'deletes files for good' },
  // `-f` folded into other flags (`-fu`), and the `+refspec` form, which is
  // --force spelled without the word.
  {
    pattern: /\bgit\s+push\b[^\n]*\s(-[a-zA-Z]*f[a-zA-Z]*\b|--force(?!-with-lease)|\+\S)/,
    what: 'force-pushes over what is on the remote',
  },
  {
    pattern: /\bgit\s+push\b[^\n]*\s(-d\b|--delete\b|:\S)/,
    what: 'deletes a branch on the remote',
  },
  { pattern: /\bgit\s+reset\b[^\n]*--hard/, what: 'throws away uncommitted work' },
  // `git restore` and `git checkout -- <path>` are `reset --hard` for one file
  // or for all of them. Unstaging (`--staged` alone) leaves the working tree
  // as it was, and is the one form of restore that can be taken back.
  {
    pattern: /\bgit\s+restore\b(?![^\n]*(?:--staged|\s-S\b))/,
    what: 'throws away uncommitted work',
  },
  {
    pattern: /\bgit\s+restore\b[^\n]*(?:--worktree|\s-W\b)/,
    what: 'throws away uncommitted work',
  },
  {
    pattern: /\bgit\s+checkout\b[^\n]*(?:\s--\s|\s\.(?:\s|$))/,
    what: 'throws away uncommitted work',
  },
  { pattern: /\bgit\s+clean\b[^\n]*-[a-zA-Z]*f/, what: 'deletes untracked files' },
  {
    pattern: /\bgit\s+branch\b[^\n]*\s-D\b/,
    what: 'deletes a branch without checking it is merged',
  },
  { pattern: /\b(dd|mkfs|fdisk|shred)\b/, what: 'writes over a device or destroys data' },
  { pattern: /\b(chmod|chown)\s+-[a-zA-Z]*R/, what: 'changes permissions of a whole tree' },
  {
    pattern: /\bcurl\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
    what: 'runs a script downloaded from the network',
  },
  {
    pattern: /\bwget\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/,
    what: 'runs a script downloaded from the network',
  },
  { pattern: /\bsudo\b/, what: 'runs as another user' },
  { pattern: /\bnpm\s+publish\b/, what: 'publishes a package where everyone can see it' },
  {
    pattern: /\b(kill|pkill|killall)\s+(-9\b|-(SIG)?KILL\b|-s\s+(9|(SIG)?KILL)\b)/,
    what: 'kills a process without letting it finish',
  },
  { pattern: />\s*\/dev\/(sd|nvme|disk)/, what: 'writes straight to a disk' },
]

/** What makes this command irreversible, if anything does. */
export function irreversible(command: string): Danger | undefined {
  for (const { pattern, what } of IRREVERSIBLE) {
    if (pattern.test(command)) return { what }
  }
  return undefined
}
