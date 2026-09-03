import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { resolveInWorkspace, WorkspaceBoundaryError } from '@aidcrew/tool-fs'

/**
 * Files an agent is never allowed to write, whatever mode it is running in.
 *
 * This is a short list on purpose. A long blocklist over the file tools would
 * be an attempt to enumerate everything that matters, which nobody manages;
 * this enumerates the few things that are never the task and whose loss is
 * either unrecoverable or a security incident.
 *
 * It is not a sandbox. An agent with a shell can reach these paths anyway —
 * that is what the approval prompt is for. What this stops is the accident:
 * the model that decides the cleanest fix is to rewrite `.env`, and does it
 * through the tool that asks no questions because writing files is its job.
 */

/** Matched against the path relative to the workspace, in segments. */
const NEVER: { pattern: RegExp; because: string }[] = [
  { pattern: /(^|\/)\.git(\/|$)/, because: 'it would rewrite the repository itself' },
  { pattern: /(^|\/)\.env($|\.)/, because: 'it holds credentials' },
  { pattern: /(^|\/)\.aidcrew\/(history|aidcrew)\.db($|-)/, because: 'it is the session record' },
  { pattern: /(^|\/)\.ssh(\/|$)/, because: 'it holds keys' },
  { pattern: /(^|\/)\.aws(\/|$)/, because: 'it holds credentials' },
  { pattern: /(^|\/)\.npmrc$/, because: 'it can hold a publish token' },
  { pattern: /(^|\/)id_(rsa|ed25519|ecdsa)($|\.)/, because: 'it is a private key' },
]

export type Refusal = { path: string; because: string }

/**
 * Whether writing here is refused, and why.
 *
 * The reason is returned because a refusal the model cannot understand becomes
 * a retry: told only "no", it tries the same thing through the shell.
 *
 * Matched against the path the write will actually land on, not the one that
 * was typed. `resolveInWorkspace` is the same function the file tools use to
 * decide where they are writing, and it follows symlinks — which is the whole
 * point of asking it: a link named `notes.md` pointing at `.env` is a write to
 * `.env`, and a guard that reads only the name it was handed says yes to it.
 */
export function refuseWrite(path: string, workspace: string): Refusal | undefined {
  const root = resolve(workspace)

  let full: string
  try {
    // A workspace that is not on disk has no links to follow, so plain
    // resolution is not a fallback here — it is the whole answer.
    full = existsSync(root) ? resolveInWorkspace(root, path) : resolve(root, path)
  } catch (error) {
    // Outside the workspace entirely: the file tools already refuse this, and
    // saying so here too costs nothing and covers a tool that forgets to.
    if (error instanceof WorkspaceBoundaryError) {
      return { path, because: 'it is outside the workspace' }
    }
    throw error
  }

  const within = relative(existsSync(root) ? realpathSync(root) : root, full)
  if (within.startsWith('..') || isAbsolute(within)) {
    return { path, because: 'it is outside the workspace' }
  }

  for (const { pattern, because } of NEVER) {
    if (pattern.test(within)) return { path, because }
  }

  return undefined
}
