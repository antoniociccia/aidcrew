import { posix } from 'node:path'
import type { Hooks, Plugin, ToolCallInfo, ToolContext, ToolOutput } from '@aidcrew/core'

/**
 * Asking before doing something that cannot be taken back.
 *
 * The tools themselves deliberately have no policy: `bash` carries no
 * deny-list because a blocklist over an arbitrary shell is trivially bypassed,
 * and false confidence is worse than none. The control is here instead — a
 * hook that stops the call and waits for a person.
 *
 * What is asked about is deliberately narrow. An agent that asks about
 * everything trains you to approve everything without reading, which is worse
 * than not asking: reading files and running tests are safe and constant,
 * while writing outside the workspace and running commands are neither.
 */

/**
 * How far an approval reaches.
 *
 * `once` is this call. `folder` is this tool inside the directory it was asked
 * about. `always` is this tool, or this command, for the rest of the session.
 *
 * `folder` exists because the two ends were not enough: approving a write file
 * by file means answering the same question forty times, and approving writes
 * everywhere is a bigger decision than the one in front of you. Almost every
 * real answer is "yes, in here".
 */
export type Decision = 'once' | 'folder' | 'always' | 'no'

export type ApprovalRequest = {
  agentId: string
  tool: string
  input: unknown
  /** A one-line rendering of what is about to happen. */
  summary: string
  /** Why this one is being asked about, in a few words. */
  because: string
  /**
   * What each broader answer would cover, written out.
   *
   * Shown on the prompt itself: "always" is a leap when nobody says what it
   * means, and the difference between allowing writes under `src/` and
   * allowing writes anywhere is the whole decision.
   */
  scopes: Scopes
}

export type Scopes = {
  /** This tool within the directory in question, when there is one. */
  folder?: string
  /** This tool, or this command, wherever it is used. */
  /**
   * What the widest yes would cover, when there is a wider one.
   *
   * Absent for a question with no broader version — a plugin asking whether
   * it may use a token asks one thing, once. Offering "always" there put two
   * keys on the prompt that did the same thing.
   */
  broad?: string
}

export type ApprovalAsker = (request: ApprovalRequest) => Promise<Decision>

export type ApprovalPolicy = {
  /** Commands and tools approved for the rest of the session. */
  remembered: Set<string>
  ask: ApprovalAsker
  /** Off for headless runs, where there is nobody to ask. */
  enabled: boolean
  /**
   * Agents that may act without being asked first.
   *
   * Per agent, because trust is a property of the agent the way its model is.
   * This covers the routine — running a command, writing a file — and nothing
   * else: the guard plugin still stops what cannot be written at all and still
   * asks about the handful of commands that cannot be taken back.
   */
  trusted?: (agentId: string) => boolean
}

/** Tools that change something outside this process, or run arbitrary code. */
const GUARDED = new Set(['bash', 'write', 'edit'])

/**
 * Shell commands that only read.
 *
 * Not a security boundary — anything on this list can still be misused with
 * enough ingenuity, and the list is matched against the first word only. It
 * exists so that the twentieth `git status` of a session does not need a
 * keystroke, which is what makes people stop reading the prompts.
 *
 * Nothing that prints the environment is here. `bash` inherits this process's
 * environment, and this process holds the keys: with `env` on the list, an
 * exported AIDCREW_API_KEY went into the tool result, the record on disk and
 * the next request to the provider, and nobody was asked.
 */
const READ_ONLY = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'grep',
  'rg',
  'find',
  'wc',
  'file',
  'stat',
  'pwd',
  'which',
  'echo',
  'diff',
  'tree',
  'du',
  'df',
  'ps',
])

/**
 * Redirection, pipes, chaining, substitution — anything past a single call.
 *
 * A dollar sign counts: it is the shell about to substitute something, and
 * `echo $AIDCREW_API_KEY` is `env` one variable at a time. So does `<`, since
 * `cat <(id)` runs `id`, and the first word cannot see either.
 */
const COMPOSED = /[<>|;&`$]/

export function createApprovalHook(policy: ApprovalPolicy): Hooks {
  return {
    async preToolCall(call: ToolCallInfo, context: ToolContext): Promise<ToolOutput | undefined> {
      if (!policy.enabled) return undefined

      const verdict = classify(call)
      if (verdict === undefined) return undefined
      if (policy.trusted?.(context.agentId)) return undefined
      // Remembered per agent: letting one agent run `bash git` is not a
      // decision about every other agent on the team.
      const held = (key: string) => `${context.agentId}:${key}`
      if (covered(policy.remembered, context.agentId, verdict)) return undefined

      const decision = await policy.ask({
        agentId: context.agentId,
        tool: call.name,
        input: call.input,
        summary: verdict.summary,
        because: verdict.because,
        scopes: verdict.scopes,
      })

      if (decision === 'always') {
        policy.remembered.add(held(verdict.remember.broad))
        return undefined
      }
      if (decision === 'folder' && verdict.remember.folder !== undefined) {
        policy.remembered.add(held(verdict.remember.folder))
        return undefined
      }
      if (decision === 'folder' || decision === 'once') return undefined

      // Refused calls come back as a failed result rather than an exception,
      // so the agent can say something else instead of the session ending.
      return { content: `${call.name} was not approved by the user`, isError: true }
    },
  }
}

type Verdict = {
  summary: string
  because: string
  /** The keys each answer is remembered under. */
  remember: { folder?: string; broad: string }
  /** The same, in words somebody can read before answering. */
  scopes: Scopes
}

/** What is worth asking about, and what it should be described as. */
export function classify(call: ToolCallInfo): Verdict | undefined {
  if (!GUARDED.has(call.name)) return undefined

  const input = (call.input ?? {}) as Record<string, unknown>

  if (call.name === 'bash') {
    const command = typeof input.command === 'string' ? input.command : ''
    const verb = command.trim().split(/\s+/)[0] ?? ''

    // A reading command stops reading the moment it is redirected, piped or
    // chained: `echo` is harmless and `echo x > file` is not, and they differ
    // by one character the first word cannot see.
    if (READ_ONLY.has(verb) && !COMPOSED.test(command)) return undefined

    // A command has no directory to scope to; what varies is the rest of the
    // line, so the verb is the only sensible unit.
    return {
      summary: command.length > 120 ? `${command.slice(0, 120)}…` : command,
      because: 'runs a command',
      remember: { broad: `bash:${verb}` },
      scopes: { broad: `bash ${verb} …` },
    }
  }

  const path = typeof input.path === 'string' ? input.path : '?'
  const folder = folderOf(path)

  return {
    summary: `${call.name} ${path}`,
    because: call.name === 'write' ? 'writes a file' : 'changes a file',
    remember: {
      ...(folder === undefined ? {} : { folder: `${call.name}:${folder}/` }),
      broad: `${call.name}:*`,
    },
    scopes: {
      ...(folder === undefined ? {} : { folder: `${call.name} ${folder}/*` }),
      broad: `${call.name} *`,
    },
  }
}

/**
 * Whether an answer already given covers this call.
 *
 * A folder answer covers what is under it, not only what sits directly in it:
 * approving writes in `src/` and then being asked again about `src/deep/` is
 * the same question with more slashes, and answering it twice is what makes
 * people stop reading.
 */
function covered(remembered: Set<string>, agentId: string, verdict: Verdict): boolean {
  if (remembered.has(`${agentId}:${verdict.remember.broad}`)) return true

  const folder = verdict.remember.folder
  if (folder === undefined) return false

  const [tool = ''] = folder.split(':')
  const here = folder.slice(tool.length + 1)

  for (const key of remembered) {
    if (!key.startsWith(`${agentId}:${tool}:`)) continue
    const allowed = key.slice(`${agentId}:${tool}:`.length)
    // A trailing slash on both sides, so `src/` never matches `srcery/`.
    if (allowed.endsWith('/') && here.startsWith(allowed)) return true
  }
  return false
}

/**
 * The folder a "yes, in here" would cover, or nothing when there is no honest one.
 *
 * Normalised first, because a folder answer is compared by spelling and
 * `src/../package.json` begins with `src/` without being in it: after "yes, in
 * src/" that write went through with no prompt at all. Once normalised, a
 * path that still climbs out of the project, or names an absolute one, is
 * offered no folder — "yes, in `../elsewhere/`" is a yes to writing outside
 * the project, dressed as the smaller answer.
 */
function folderOf(path: string): string | undefined {
  const normal = posix.normalize(path.replace(/\\/g, '/'))
  if (posix.isAbsolute(normal) || normal.split('/').includes('..')) return undefined
  return directoryOf(normal)
}

/**
 * The directory a path is in, or nothing for a file at the top of the project.
 *
 * A file in the root has no folder narrower than the whole workspace, and
 * offering "everything in ." as the middle answer would make it the same
 * decision as "everywhere" while looking smaller.
 */
function directoryOf(path: string): string | undefined {
  const cut = path.replace(/\\/g, '/').lastIndexOf('/')
  if (cut <= 0) return undefined
  return path.slice(0, cut)
}

/**
 * The approval gate as a plugin, which is how it reaches the loop.
 *
 * Built when the policy is known rather than exported as a value, because who
 * to ask is a property of the session. Registered like everything else: there
 * is no privileged path by which a hook gets into the loop, and an interface
 * that forgot to register this one would simply run without approvals.
 */
export function createApprovalPlugin(policy: ApprovalPolicy): Plugin {
  return { name: 'hooks-approval', version: '0.0.0', hooks: createApprovalHook(policy) }
}
