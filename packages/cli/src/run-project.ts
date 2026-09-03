import type { SettingsStore } from './store.ts'
import type { Refusal } from './workspace.ts'
import { loadWorkspaceConfig, WorkspaceConfigError } from './workspace.ts'

/**
 * What a project asked for, and what has been allowed.
 *
 * `.aidcrew/config.toml` is made to be committed — it is how a repository
 * ships its team — which is why the things in it that let an agent act
 * unasked, or read a file outside the project, wait to be allowed. This is
 * where they are read and where the answer is given, by typing it: a prompt
 * in the middle of something else is a prompt answered without reading, which
 * is the same reason `plugin trust` and `mcp trust` are commands.
 */

export type ProjectIo = {
  write(text: string): void
  writeError(text: string): void
}

export function projectTrustKey(workspace: string, claim: string): string {
  return `project.trust.${workspace}.${claim}`
}

/** Whether this project may have one of these, for the loader to consult. */
export function trustedClaims(store: SettingsStore, cwd: string) {
  return (claim: string): boolean => store.get(projectTrustKey(cwd, claim)) === 'allow'
}

/**
 * One refusal as a line somebody can act on.
 *
 * Written once and printed everywhere — the session, stderr under `-p`, and
 * the command — so the interface and a CI log never describe the same
 * refusal differently.
 */
export function refusalLine(refusal: Refusal): string {
  return (
    `.aidcrew/config.toml came with this project. It ${refusal.because} — not in effect. ` +
    `"aidcrew project trust ${refusal.claim}" if you want it.`
  )
}

export async function runProject(
  rest: string[],
  store: SettingsStore,
  io: ProjectIo,
  cwd: string,
  home: string,
): Promise<number> {
  const [action, target] = rest

  // Read with the default answer, so what this lists is by construction
  // everything the gate would refuse. The command and the loader cannot
  // disagree about what the file asks for, because it is the same read.
  let asked: Refusal[]
  try {
    asked = (await loadWorkspaceConfig({ cwd, home })).refused
  } catch (cause) {
    if (!(cause instanceof WorkspaceConfigError)) throw cause
    io.writeError(`${cause.message}\n`)
    return 1
  }

  if (action === undefined || action === 'list') {
    return list(asked, store, io, cwd)
  }

  if (action === 'trust' || action === 'revoke') {
    if (target === undefined) {
      io.writeError(`aidcrew project ${action} <claim>\n`)
      return 1
    }
    // Refused rather than remembered. A typo stored forever sits in the list
    // looking answered while the thing it was meant to allow is still
    // refused — and for a path, a near miss is a different path.
    const claims = asked.map((one) => one.claim)
    const known = claims.includes(target) || store.get(projectTrustKey(cwd, target)) !== undefined
    if (!known) {
      io.writeError(
        `.aidcrew/config.toml here does not ask for "${target}"` +
          (claims.length > 0 ? `. It asks for: ${claims.join(', ')}\n` : '\n'),
      )
      return 1
    }

    store.set(projectTrustKey(cwd, target), action === 'trust' ? 'allow' : 'refuse')
    io.write(
      action === 'trust'
        ? `${target} applies in this project from the next start.\n`
        : `${target} does not apply here.\n`,
    )
    return 0
  }

  io.writeError('aidcrew project [list|trust <claim>|revoke <claim>]\n')
  return 1
}

function list(asked: Refusal[], store: SettingsStore, io: ProjectIo, cwd: string): number {
  if (asked.length === 0) {
    io.write('.aidcrew/config.toml here asks for nothing a clone does not get.\n')
    return 0
  }

  io.write(
    `.aidcrew/config.toml asks for ${asked.length} thing${asked.length === 1 ? '' : 's'} ` +
      'a clone does not get:\n\n',
  )
  for (const one of asked) {
    const allowed = store.get(projectTrustKey(cwd, one.claim)) === 'allow'
    io.write(`  ${allowed ? 'trusted    ' : 'not trusted'}  ${one.claim}\n`)
    io.write(`                ${one.because}\n`)
  }
  io.write('\n"aidcrew project trust <claim>" allows one, here, in this project.\n')
  return 0
}
