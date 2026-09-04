import { closeOpenCalls } from '../conversation.ts'
import type { LoopEvent, Provider, Tool } from '../loop.ts'
import { accumulateUsage, runAgentLoop } from '../loop.ts'
import type { Hooks } from '../plugins/types.ts'
import type { AgentDef } from '../sources/types.ts'
import type { ContentBlock, Message, Usage } from '../types.ts'
import { addUsage } from '../types.ts'
import type { AgentMessage, Limits } from './governor.ts'
import { Governor } from './governor.ts'
import type { Note, SharedMemory } from './shared.ts'
import { asMessage, EMPTY_MEMORY, olderThanKept, remember, shorten, tooLong } from './shared.ts'
import type { MergeOutcome } from './workspace.ts'
import { type RemoveOutcome, WorkspaceManager } from './workspace.ts'

export type AgentStatus = 'idle' | 'working' | 'stopped'

export type AgentSnapshot = {
  id: string
  status: AgentStatus
  model: string
  usage: Usage
  turns: number
  workspace: string
  isolated: boolean
  /** The agent's last visible answer, which is what a pane shows. */
  lastText?: string
  /** Recent activity, oldest first: one sample per turn, for the trace. */
  activity: number[]
  /** Whether this agent acts without asking. Shown, because it is not the default. */
  yolo: boolean
  /**
   * How many commits this agent's copy of the repository is behind.
   *
   * Shown continuously, because it grows while the agent is doing nothing:
   * every commit made outside — by you, in your own editor — leaves every
   * idle agent one further back, and an agent that looks idle and current is
   * the one that answers confidently about code that has changed.
   */
  behind: number
  /**
   * Instructions waiting behind the one being worked on.
   *
   * Shown because sending three things and seeing one status is indisitinguishable
   * from sending three things and having two of them lost.
   */
  queued: number
  /** What it is for, which several agents can share. */
  role: string
  /** The job it is on, which decides whose checkout it shares. */
  task: string
  /**
   * Which service this agent is on.
   *
   * Shown because mixed providers is the point: an interface that says only
   * the model leaves you unable to tell which of two identically named ones
   * you are looking at, or that one of these agents is not a model at all.
   */
  provider?: string
}

export type TeamEvent =
  | { type: 'agent_spawned'; id: string; model: string }
  | { type: 'agent_status'; id: string; status: AgentStatus }
  | { type: 'agent_event'; id: string; event: LoopEvent }
  | { type: 'agent_message'; from: string; to: string; text: string }
  /**
   * A limit stopped something. Always surfaced: silent limits look like bugs.
   *
   * Also the one thing the harness decides for somebody without asking — a
   * message queued behind a busy agent, because there was nobody to ask or
   * the agents concerned run unattended — surfaced for the same reason.
   */
  | { type: 'agent_blocked'; id: string; reason: string }
  /** A turn failed — the provider refused, the network died, a plugin threw. */
  | { type: 'agent_failed'; id: string; reason: string }
  | { type: 'agent_killed'; id: string }
  /**
   * The agent's copy of the repository was moved forward before it started.
   *
   * Surfaced because it changes what the agent is looking at: one that has
   * been standing for a while answers about code that has since changed, and
   * knowing it has just caught up explains why its answer differs from the
   * last one.
   */
  | { type: 'agent_refreshed'; id: string; commits: number }
  /**
   * A turn that stopped rather than finished, and what it was in the middle of.
   *
   * The loop has always worked this out — `end_turn` and `max_tokens` are not
   * the same answer — and the single-agent path has always read it. This one
   * did not, so an agent guillotined by the output cap partway through writing
   * a file looked exactly like one that had finished, and the team went quiet
   * with nothing on screen saying why. `tool` is the call that was cut off and
   * therefore never ran, which is the part somebody can act on.
   */
  | { type: 'agent_cut_short'; id: string; reason: string; tool?: string }
  /**
   * An agent started in a checkout an earlier session left work in.
   *
   * Said once per checkout, to the first agent that lands in it: the agent
   * is starting in the middle of something, and the person should know the
   * files are there before the agent reports on them as though it wrote them.
   */
  | { type: 'workspace_resumed'; id: string; task: string; changed: number }
  /**
   * A checkout was left on disk because the work in it exists nowhere else.
   *
   * Uncommitted changes, or commits on no branch: removing the directory
   * would have removed the only copy. It is picked up by the next session.
   */
  | { type: 'workspace_kept'; task: string; path: string }
  /**
   * An unleashed agent reached its turn limit and was told to carry on.
   *
   * `round` of `of`: the harness says "go on" a bounded number of times, and
   * the count is shown so a turn that is genuinely going round in circles can
   * be seen to be.
   */
  | { type: 'agent_continued'; id: string; round: number; of: number }

/**
 * Something one party handed to another that has not come back.
 *
 * `relay` said `delivered: true` and forgot, so nothing anywhere knew that
 * somebody was waiting. Without that, "the team has stopped" can only be
 * guessed at from silence — and silence is what a model thinking for two
 * minutes looks like too. With it, the question is answerable rather than
 * estimated: nobody is working, and this was handed over and never answered.
 */
export type Handoff = {
  /** `user` for an instruction somebody typed. */
  from: string
  to: string
  text: string
  at: number
  /**
   * How the recipient's turn on it ended, when it ended badly.
   *
   * Absent means it has not finished a turn on this at all — delivered to an
   * agent that was stopped, or refused a turn by a limit after the sender had
   * already been told it arrived.
   */
  cutShort?: string
}

export type ContentionRequest = {
  from: string
  to: string
  /** What the sender wants done, so the choice is made knowing it. */
  text: string
  /** How many instructions are already waiting behind the one running. */
  queued: number
}

export type Contention =
  /** Put it behind what the agent is already doing. */
  | { at: 'queue' }
  /** Start a second agent of the same kind and give it to that one. */
  | { at: 'spawn' }
  /** Do neither, and tell the sender so it can decide something else. */
  | { at: 'drop' }

/**
 * What became of a message handed to `relay`.
 *
 * `to` is who actually has it. The name on a message can be a role, and the
 * answer to "who did I just write to" is the agent it resolved to — which is
 * what a sender has to remember to know whether it has been answered.
 */
export type Delivery = { delivered: true; to: string } | { delivered: false; reason: string }

export type HostOptions = {
  cwd: string
  /**
   * Builds the provider for one agent, honouring its own provider and model.
   *
   * The agent's directory comes too, because a provider is not always an
   * endpoint: one that runs a program has to run it somewhere, and the answer
   * is the agent's own worktree rather than wherever the harness was started.
   */
  providerFor(agent: AgentDef, cwd: string): Provider
  tools: Tool[]
  limits: Limits
  /** Give each agent its own git worktree. Off in tests and in plain directories. */
  isolate: boolean
  onEvent(event: TeamEvent): void
  hooks?: Hooks[]
  /**
   * Which plugin each set of hooks came from, in the same order.
   *
   * Carried so that a hook which throws is reported against somebody. The two
   * hooks the host adds itself are appended after these, and are unnamed:
   * they are the harness, and a bug in them is ours.
   */
  hookNames?: string[]
  maxTurnsPerInstruction?: number
  /**
   * Asked when one agent sends work to another that is already busy.
   *
   * Queuing it is what happens with nobody to ask, and it is often wrong: by
   * the time the agent reaches it the repository has moved and the reasoning
   * behind it may be stale. The person watching knows things the sender does
   * not — whether it is urgent, whether a second one is worth the money — so
   * they get the choice.
   *
   * Not asked when either agent is unleashed. Asking suspends the sender's
   * turn until somebody answers, and unleashing an agent is saying nobody
   * will be there to: the message is queued, and the transcript says so.
   */
  onContention?(request: ContentionRequest): Promise<Contention>

  /**
   * What an agent had said before this session started.
   *
   * A resumed agent picks up its own conversation rather than meeting you
   * again: the messages go back into the loop as they were. The host neither
   * knows nor cares where they were kept.
   */
  historyFor?(agentId: string): Message[]
  /**
   * Whether agents on a task keep a note the others can read.
   *
   * Off unless asked for. It puts a paragraph in front of every agent on the
   * task, on every request — worth it when a team is working something out
   * together, and pure cost when one agent is doing a small job alone. That
   * is a decision about how you are working, so it is one to make rather than
   * one to discover on a bill.
   */
  sharedMemory?: boolean

  /**
   * The agent that holds the job, and cannot be taken off the team.
   *
   * A position rather than a kind: it can be an architect, a coder, a fashion
   * stylist. What makes it the leader is that every chain reports back to it
   * and that it is always there.
   *
   * Without one, whoever owns a job is whichever agent somebody last typed at
   * — which changes with the keystroke, so nobody holds the end of work that
   * outlives one instruction, and the last step of a job is the step that goes
   * missing. Absent means that older behaviour: the chain reports to whoever
   * was spoken to.
   */
  leader?: string

  /**
   * What this project says about how its team works, from ORCHESTRATE.md.
   *
   * Absent means the built-in wording, which is the point: a team has to work
   * without anybody having written this file. What the file replaces is the
   * wording only — the roster is always the harness's, because it is the half
   * a file on disk cannot know.
   */
  orchestration?: string

  /**
   * Summarises the oldest notes when a task's shared note grows too long.
   *
   * Given rather than assumed, because which model does the summarising is
   * the same decision as for a conversation: the agent's own by default, a
   * cheaper one when the project names it. Absent means the notes are kept
   * as they are and simply stop growing.
   */
  summariseNotes?(task: string, notes: Note[]): Promise<string>

  /** Told when a task's shared note changes, so it can be kept. */
  onShared?(task: string, memory: SharedMemory): void
  /** What a task's shared note was, from a previous session. */
  sharedFor?(task: string): SharedMemory | undefined

  /**
   * What an agent has changed in its own workspace, as a diff.
   *
   * Used when one agent hands work to another. Injected rather than taken
   * from the workspaces directly so a host without git, or a test, can say
   * what it likes.
   */
  diffFor?(agentId: string): Promise<string>

  /**
   * What that agent had already spent, from a previous session.
   *
   * Restored with the conversation, because the two are the same fact: the
   * tokens were spent producing those messages, and coming back to find the
   * conversation intact and the total at zero says the session was free.
   */
  usageFor?(agentId: string): Usage | undefined
  /**
   * Called after every instruction with that agent's whole conversation.
   *
   * The whole thing rather than the new part: the loop rewrites what it holds
   * as it goes, so what is worth keeping is the state it ended in and not a
   * diary of how it got there.
   */
  onHistory?(agentId: string, messages: Message[], usage: Usage): void
}

/**
 * A team of long-lived agents, each on its own model, sharing one event loop.
 *
 * Running them in one process is not a compromise: an agent spends almost all
 * its time waiting on the network, so a single loop handles dozens without
 * strain. Processes would buy crash isolation, not speed — which is why the
 * seam is this class rather than the design, and a process-per-agent host can
 * be dropped in later without anything else moving.
 */
export class InProcessHost {
  readonly #options: HostOptions
  readonly #agents = new Map<string, LiveAgent>()
  /** What has been handed over and not come back. See `Handoff`. */
  readonly #handoffs: Handoff[] = []
  readonly #governor: Governor
  readonly #workspaces: WorkspaceManager
  /** What everyone on a task knows, by task. */
  readonly #shared = new Map<string, SharedMemory>()
  /** Checkouts picked up from an earlier session that have been announced. */
  readonly #resumedTold = new Set<string>()

  constructor(options: HostOptions) {
    this.#options = options
    this.#governor = new Governor(options.limits)
    this.#workspaces = new WorkspaceManager(options.cwd)
  }

  async spawn(def: AgentDef): Promise<AgentSnapshot> {
    if (this.#agents.has(def.id)) {
      throw new Error(`agent "${def.id}" is already running`)
    }

    const workspace = this.#options.isolate
      ? await this.#workspaces.create(taskOf(def))
      : { taskId: taskOf(def), path: this.#options.cwd, isolated: false }

    const agent = new LiveAgent(def, workspace.path, workspace.isolated, this)
    this.#agents.set(def.id, agent)
    this.#options.onEvent({ type: 'agent_spawned', id: def.id, model: def.model ?? 'default' })

    // Once per checkout, not once per agent: the second agent on the task is
    // joining the first, and the news is about the directory they share.
    const task = taskOf(def)
    if (workspace.resumed && !this.#resumedTold.has(task)) {
      this.#resumedTold.add(task)
      this.#options.onEvent({
        type: 'workspace_resumed',
        id: def.id,
        task,
        changed: await this.#workspaces.changed(task),
      })
    }

    return agent.snapshot()
  }

  /** Queues an instruction from the user. The agent picks it up when free. */
  async tell(id: string, text: string): Promise<void> {
    const agent = this.#agents.get(id)
    if (!agent) throw new Error(`no agent named "${id}"`)
    // A person speaking supersedes whatever either of them was waiting on:
    // they can see the screen, and the harness has no business still having
    // an opinion about a handoff somebody has just spoken over.
    this.#settle(id)
    // Everything that follows reports to the leader — or, where a project has
    // named none, to whoever was spoken to.
    const origin = this.#options.leader ?? id
    // Refused out loud while the agent is on its way out. Between `kill`
    // stopping it and its turn unwinding it is still on the roster, and its
    // mailbox drops everything: something typed in that window vanished with
    // no sign that it had.
    if (!agent.deliver({ from: 'user', to: id, text, hops: 0, origin })) {
      throw new Error(`"${id}" is being stopped`)
    }
    this.#handoffs.push({ from: 'user', to: id, text, at: Date.now() })
  }

  /**
   * Delivers a message between agents, subject to the hop and volume limits.
   *
   * Where the recipient is already working, the person watching decides what
   * happens to it — see `onContention`. Asking makes this await something
   * outside the machine, which is why it is worth the wait: nothing else here
   * knows whether a second agent is worth its price.
   */
  async relay(message: AgentMessage): Promise<Delivery> {
    // The allowance is for what the agent sends. Its closing reply is the
    // harness's — one per handoff, which cannot flood anybody — and charging
    // it to the agent meant one that had used its three sends fanning work
    // out had its own report refused as a fourth, and was blamed for it.
    const own = message.reply !== true
    const allowance = own ? this.#governor.allowSend(message.from) : { ok: true as const }
    if (!allowance.ok) {
      this.#options.onEvent({ type: 'agent_blocked', id: message.from, reason: allowance.reason })
      return { delivered: false, reason: allowance.reason }
    }

    const verdict = this.#governor.allowDelivery(message)
    if (!verdict.ok) {
      this.#options.onEvent({ type: 'agent_blocked', id: message.from, reason: verdict.reason })
      return { delivered: false, reason: verdict.reason }
    }

    const first = this.#pick(message.to, message.from)
    if (!first) {
      return { delivered: false, reason: this.#unreachable(message) }
    }

    const target = await this.#resolveContention(first, message)
    if (!target) {
      return {
        delivered: false,
        reason: `${message.to} is busy and the message was not queued — try again later, or do it yourself`,
      }
    }

    message = { ...message, to: target.id }

    // Nothing is written down about a message until it is in a mailbox.
    // `kill` stops an agent and then waits for its turn to unwind, and for
    // that long the agent is still on the roster: a message sent in that
    // window used to be recorded as a handoff, announced as delivered and
    // dropped on the floor — the sender's tool result said "delivered to
    // reviewer", and the message and the debt both vanished.
    if (!target.deliver(message)) {
      return { delivered: false, reason: `${target.id} is being stopped` }
    }

    // Counted once it is in a mailbox and not before: an attempt that found
    // nobody was costing one of the allowance, so the corrected message after
    // a typo could be the one refused.
    if (own) this.#governor.recordSend(message.from)
    this.#options.onEvent({
      type: 'agent_message',
      from: message.from,
      to: message.to,
      text: message.text,
    })
    // Passing anything on is an answer to whoever was waiting on the sender.
    // Without this, an agent that did hand its work forward and then overran
    // its own turn is reported as having gone silent, which is the opposite
    // of what it did.
    this.#settle(message.from, 'to')
    this.#handoffs.push({
      from: message.from,
      to: message.to,
      text: message.text,
      at: Date.now(),
    })
    return { delivered: true, to: target.id }
  }

  /**
   * Who a message addressed to `to` is for.
   *
   * `to` is a name or a role, and a role can have several agents on it. A free
   * one is preferred over a busy one, which is the entire reason for having a
   * second: work that could start now should not sit behind work that is
   * already running. Only when they are all busy does anybody get asked.
   *
   * Never the sender. A role is whoever is on it, and when the only agent on
   * it is the one asking — `coder-2`, on the coder role, after `coder` has
   * gone — it resolved to itself and spent the next turn answering its own
   * message. The governor's rule against that had been applied to the name as
   * written, which was the role and not the agent.
   *
   * Never one that is being stopped, either: its mailbox drops everything.
   */
  #pick(to: string, from: string): LiveAgent | undefined {
    const candidates = [...this.#agents.values()].filter(
      (agent) => agent.id !== from && !agent.stopped() && answersTo(agent, to),
    )
    // The one actually named comes first, so addressing somebody by name still
    // reaches them whenever they are free.
    candidates.sort((a, b) => Number(b.id === to) - Number(a.id === to))

    return candidates.find((agent) => !agent.busy()) ?? candidates[0]
  }

  /**
   * Why nobody could be found for a message, in words the sender can act on.
   *
   * Three different situations, and "no agent named" was the answer to all of
   * them — including the one where the agent named was the sender.
   */
  #unreachable(message: AgentMessage): string {
    const named = [...this.#agents.values()].filter((agent) => answersTo(agent, message.to))
    if (named.length === 0) return `no agent named "${message.to}"`
    if (named.every((agent) => agent.id === message.from)) {
      return (
        `agent "${message.from}" cannot send messages to itself, ` +
        `and nobody else is on "${message.to}"`
      )
    }
    return `${message.to} is being stopped`
  }

  /**
   * Who actually receives a message aimed at a busy agent.
   *
   * Returns the original when it is free or the wait is accepted, a fresh
   * second of it when the answer is to spawn, and nothing when the answer is
   * to drop — which the sender is then told, because an agent that thinks its
   * instruction landed will sit waiting for an answer that is not coming.
   */
  async #resolveContention(
    target: LiveAgent,
    message: AgentMessage,
  ): Promise<LiveAgent | undefined> {
    if (!target.busy()) return target
    // A reply is not new work, so it waits its turn rather than asking. Asked
    // about like new work it puts a choice to the person that they have no
    // reason to make — start a second agent, to receive an answer?
    if (message.reply === true) return target

    // Nobody to ask, or nobody who would be there to answer. Asking suspends
    // the sender's turn until the person chooses, and an unleashed agent — on
    // either end — is one they have said they are not watching: the prompt
    // sat on the screen all afternoon with the whole chain stopped behind it,
    // which is the opposite of what unleashing an agent is for. Queued
    // instead, and said out loud, because a message waiting in silence leaves
    // the sender looking answered and the recipient looking idle on the wrong
    // job.
    const ask = this.#options.onContention
    const unleashed = [this.#agents.get(message.from), target]
      .filter((one): one is LiveAgent => one?.yolo === true)
      .map((one) => one.id)
    if (!ask || unleashed.length > 0) {
      this.#options.onEvent({
        type: 'agent_blocked',
        id: message.from,
        reason: queuedBehind(target.id, unleashed),
      })
      return target
    }

    const snapshot = target.snapshot()
    const choice = await ask({
      from: message.from,
      to: target.id,
      text: message.text,
      queued: snapshot.queued,
    })

    if (choice.at === 'drop') return undefined
    if (choice.at === 'queue') return target

    const second = await this.duplicate(target.id)
    return second === undefined ? target : this.#agents.get(second)
  }

  /**
   * Lets an agent act without being asked, for as long as this session lasts.
   *
   * Reported through the snapshot so the mark on its tab is true: an agent
   * running unattended that still looks supervised is the worst of both.
   */
  setYolo(id: string, on: boolean): boolean {
    const agent = this.#agents.get(id)
    if (!agent) return false
    agent.yolo = on
    this.#options.onEvent({ type: 'agent_status', id, status: agent.snapshot().status })
    return true
  }

  /**
   * Moves a running agent to another model, or another service.
   *
   * Nothing stops. The model is read off the definition at the top of every
   * turn, so replacing the definition is the whole of it — and what the agent
   * has said, spent and is in the middle of stays where it is.
   *
   * This existed twice and worked neither time: `/model` wrote the config and
   * told you to restart the session, while the team editor killed the agent
   * and started it again. Restarting is also not available for the leader,
   * which cannot be taken off the team — so the agent most likely to be moved
   * to a better model was the one that could not be.
   */
  setModel(id: string, to: { model?: string; provider?: string }): boolean {
    const agent = this.#agents.get(id)
    if (!agent) return false

    agent.retarget(to)
    this.#options.onEvent({ type: 'agent_status', id, status: agent.snapshot().status })
    return true
  }

  /**
   * Stops an agent and forgets it.
   *
   * Says what became of its checkout, because the two answers call for
   * different sentences on screen: gone with the agent, or kept because the
   * work in it exists nowhere else.
   */
  async kill(id: string, andTheLeader = false): Promise<{ workspace: RemoveOutcome }> {
    // The leader stays. Removing it would leave a team with nowhere for work
    // to come back to, and the position exists precisely so that there is
    // always somewhere. Said rather than ignored: a key that does nothing and
    // explains nothing is a key people press twice.
    if (!andTheLeader && this.#options.leader === id && this.#agents.has(id)) {
      this.#options.onEvent({
        type: 'agent_blocked',
        id,
        reason: `"${id}" leads this team and stays on it. Every job reports back to it.`,
      })
      return { workspace: 'none' }
    }

    this.#settle(id)
    const agent = this.#agents.get(id)
    if (!agent) return { workspace: 'none' }

    // Stopped, then waited for. A turn in flight goes on emitting events after
    // the agent is forgotten, and on shutdown those arrive at an interface
    // that has already closed its transcript — which threw, from inside a
    // pump nobody was watching, while the program was trying to exit.
    agent.cancel()
    agent.stop()
    await agent.settled()

    this.#agents.delete(id)
    // Only when nobody else is on that task: removing the checkout out from
    // under a colleague still working in it would destroy their work.
    const task = taskOf(agent.definition)
    const alone = [...this.#agents.values()].every(
      (other) => other.id === id || taskOf(other.definition) !== task,
    )
    const path = this.#workspaces.list().find((one) => one.taskId === task)?.path
    const workspace = alone ? await this.#workspaces.remove(task) : 'none'
    if (workspace === 'kept' && path !== undefined) {
      this.#options.onEvent({ type: 'workspace_kept', task, path })
    }
    this.#options.onEvent({ type: 'agent_killed', id })
    return { workspace }
  }

  /**
   * Starts a second agent of the same kind, with its own worktree.
   *
   * Named after the one it copies — `coder-2`, then `coder-3` — because who
   * it is a second of is the only thing you need to know about it, and a
   * generated name would make the team unreadable within the hour.
   */
  async duplicate(agentId: string): Promise<string | undefined> {
    const original = this.#agents.get(agentId)
    if (!original) return undefined

    // A copy of a copy is still a copy of the original: `coder-2` duplicated
    // is `coder-3`, never `coder-2-2`, which reads like a different role.
    const base = agentId.replace(/-\d+$/, '')
    let at = 2
    while (this.#agents.has(`${base}-${at}`)) at += 1
    const id = `${base}-${at}`

    // The copy carries the role explicitly: without it, `coder-2` would be a
    // role of its own and the next message would find nobody free again.
    await this.spawn({ ...original.definition, id, role: roleOf(original.definition) })
    return id
  }

  /**
   * Looks at how far each agent has fallen behind the repository.
   *
   * Asked periodically rather than computed per snapshot: the interface reads
   * snapshots on every frame, and shelling out to git sixty times a second to
   * answer a question whose answer changes when you commit would be absurd.
   */
  async sweep(): Promise<void> {
    for (const agent of this.#agents.values()) {
      agent.setBehind(await this.#workspaces.behind(taskOf(agent.definition)))
    }
  }

  /**
   * Stops what an agent is doing now, and leaves the agent standing.
   *
   * Different from killing it: the worktree stays, the conversation stays, and
   * it can be told something else. A turn that has run away — a model looping,
   * a command that will not finish — should cost you the turn, not the agent
   * and everything it had done.
   *
   * What is already waiting is dropped too. Whatever made you stop this turn
   * almost certainly applies to the instruction behind it.
   */
  cancel(id: string): boolean {
    // Somebody stepped in, so the harness stops having an opinion.
    this.#settle(id)
    return this.#agents.get(id)?.cancel() ?? false
  }

  /**
   * Drops what an agent has waiting, without disturbing the turn it is in.
   *
   * "Actually, not that" is the common case, and the alternative was killing
   * the agent — which also throws away the work in progress and the
   * conversation it belongs to.
   */
  /**
   * Empties an agent's conversation, leaving everything else alone.
   *
   * A conversation is sent again in full on every turn, so a long one costs
   * money for as long as it lives. Compaction shortens it; this is the other
   * thing somebody wants, which is to begin again — and there was no way to do
   * it at all.
   *
   * What it has spent stays. Those tokens were bought, and a bill does not
   * reset because you changed the subject.
   *
   * Refused mid-turn: emptying the messages under a running loop hands the
   * provider a conversation with a tool call whose result has just been thrown
   * away, which providers reject outright.
   */
  forget(id: string): boolean {
    const agent = this.#agents.get(id)
    if (!agent || agent.busy()) return false
    this.#settle(id)
    return agent.forget()
  }

  clearQueue(id: string): number {
    // Somebody stepped in, so the harness stops having an opinion.
    this.#settle(id)
    return this.#agents.get(id)?.clearQueue() ?? 0
  }

  async shutdown(): Promise<void> {
    // Everybody, the leader included: staying on the team is about the team,
    // not about the process, and one that outlived shutdown would hold its
    // worktree open and the program with it.
    for (const id of [...this.#agents.keys()]) await this.kill(id, true)
    const { kept } = await this.#workspaces.removeAll()
    for (const one of kept) {
      this.#options.onEvent({ type: 'workspace_kept', task: one.taskId, path: one.path })
    }
  }

  list(): AgentSnapshot[] {
    return [...this.#agents.values()].map((agent) => agent.snapshot())
  }

  /** Resolves once no agent has anything left to do. */
  /**
   * Drops handoffs this agent is part of.
   *
   * `both` when a person has stepped in — they can see the screen, and the
   * harness has no business still waiting on either side of something they
   * have just spoken over. Otherwise only what was handed TO it: an agent
   * finishing its turn has answered whoever was waiting on it, and has not
   * withdrawn what it handed to somebody else.
   */
  #settle(id: string, which: 'to' | 'both' = 'both'): void {
    for (let at = this.#handoffs.length - 1; at >= 0; at--) {
      const one = this.#handoffs[at]
      if (!one) continue
      if (one.to === id || (which === 'both' && one.from === id)) this.#handoffs.splice(at, 1)
    }
  }

  /**
   * Told how a turn ended, so the ledger can tell answered from abandoned.
   *
   * A turn that ends cleanly is an answer: the recipient did the work and
   * said so, and nobody is waiting any more. One that ran out of room or
   * turns did not answer, and the entry stays — marked, so what is finally
   * shown can say what happened rather than only that nothing did.
   */
  #turnEnded(id: string, stopReason: string, answered: boolean): void {
    // Ending cleanly is not the same as answering, and this used to treat
    // them as one thing: an agent that did the work, said so to nobody and
    // stopped settled a handoff it had never answered, so the one waiting on
    // it waited for ever and `stalled()` reported that all was well. The
    // harness now sends that answer itself, and this stays honest for the
    // times it cannot — a hop limit, a volume limit, a stopped sender.
    if ((stopReason === 'end_turn' || stopReason === 'stop_sequence') && answered) {
      this.#settle(id, 'to')
      return
    }
    if (stopReason === 'end_turn' || stopReason === 'stop_sequence') return
    for (const one of this.#handoffs) if (one.to === id) one.cutShort = stopReason
  }

  /** Told by an agent how its turn ended, so the ledger can be kept. */
  turnEnded(id: string, stopReason: string, answered = true): void {
    this.#turnEnded(id, stopReason, answered)
  }

  /** What has been handed over and not come back, oldest first. */
  outstanding(): Handoff[] {
    return [...this.#handoffs]
  }

  /**
   * Work handed over that nobody is going to do, or nothing.
   *
   * Asked rather than announced, for the reason falling behind is: a stall is
   * the absence of things happening, and nothing ever fires to say nothing
   * happened.
   *
   * There is no quiet threshold here, and that is deliberate rather than a
   * threshold of zero. `busy()` is true from the moment something is put in
   * an agent's mailbox until its turn is over — through a six-minute first
   * token, a four-minute test run, an approval nobody has answered. To a clock
   * watching the transcript a thinking agent and a dead one are identical, so
   * this asks the agents instead.
   */
  stalled(): Handoff[] | undefined {
    if (this.#agents.size === 0) return undefined
    if (this.#handoffs.length === 0) return undefined
    if ([...this.#agents.values()].some((agent) => agent.busy())) return undefined
    return this.outstanding()
  }

  async idle(options: { except?: string[] } = {}): Promise<void> {
    const ignore = new Set(options.except ?? [])
    for (;;) {
      const busy = [...this.#agents.values()].filter(
        (agent) => agent.busy() && !ignore.has(agent.id),
      )
      if (busy.length === 0) return
      await Promise.all(busy.map((agent) => agent.settled()))
      // Back to the event loop before asking again. An agent whose mailbox
      // holds something and whose pump is between one drain and the next has
      // nothing to be awaited, and this went round on it without yielding —
      // which starved the timers and the pump alike, for the rest of the
      // process.
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
  }

  /** Merges the branch of the task an agent is on into the repository. */
  async merge(id: string): Promise<MergeOutcome> {
    const agent = this.#agents.get(id)
    return this.#workspaces.merge(agent ? taskOf(agent.definition) : id)
  }

  async diff(id: string): Promise<string> {
    // Asked by agent, answered by task: what an agent has changed is what the
    // checkout it shares has changed, and its colleagues on the same job have
    // been changing the same files on purpose.
    const agent = this.#agents.get(id)
    return this.#workspaces.diff(agent ? taskOf(agent.definition) : id)
  }

  /**
   * Replaces a task's oldest notes with a summary.
   *
   * Without a summariser the notes simply stop growing, which is a worse
   * shared note than a summarised one and a better one than a note nobody can
   * afford to carry.
   */
  async #shortenNotes(task: string): Promise<void> {
    const memory = this.#shared.get(task) ?? EMPTY_MEMORY
    const older = olderThanKept(memory)
    if (older.length === 0) return

    const summary = this.#options.summariseNotes
      ? await this.#options.summariseNotes(task, older).catch(() => '')
      : ''

    const shortened = shorten(memory, summary)
    this.#shared.set(task, shortened)
    this.#options.onShared?.(task, shortened)
  }

  /**
   * Turns the team's shared note on or off while the session is running.
   *
   * The tools an agent has are worked out at the start of every turn, so this
   * takes effect on the next one — no restart, which is the only answer for a
   * setting somebody is switching to see what it does.
   */
  setSharedMemory(on: boolean): void {
    this.#options.sharedMemory = on
  }

  /**
   * Replaces the tools every agent is offered, from the next turn on.
   *
   * What a plugin adds should arrive the way a setting does: while you are
   * looking. An agent's tools are worked out at the start of each turn, so a
   * tool added now is a tool the next request carries — and one taken away
   * stops being offered without ending anything mid-flight.
   */
  setTools(tools: Tool[]): void {
    this.#options.tools = tools
  }

  /** The same for hooks, which is where a plugin's guards and gates live. */
  setHooks(hooks: Hooks[]): void {
    this.#options.hooks = hooks
  }

  /** What the team on a task has established, for the interface to show. */
  sharedMemory(task: string): SharedMemory {
    return this.#shared.get(task) ?? EMPTY_MEMORY
  }

  /** @internal — used by the agents this host owns. */
  get internals() {
    return {
      shared: {
        read: (task: string) => this.#shared.get(task) ?? EMPTY_MEMORY,
        write: (task: string, memory: SharedMemory) => {
          this.#shared.set(task, memory)
          this.#options.onShared?.(task, memory)
        },
      },
      shortenNotes: (task: string) => this.#shortenNotes(task),
      options: this.#options,
      governor: this.#governor,
      workspaces: this.#workspaces,
      relay: (message: AgentMessage) => this.relay(message),
      /**
       * Who is on the team and — when asked for now — who is mid-turn.
       *
       * Without status for the system prompt, which a provider caches across
       * turns and which must therefore change only when the team does. With
       * it for the tool that sends, which is built per turn regardless.
       */
      roster: (now = false): AgentLine[] =>
        [...this.#agents.values()].map((agent) => ({
          id: agent.id,
          description: agent.definition.description,
          ...(now ? { busy: agent.busy() } : {}),
        })),
      /** Who a message to `to` would reach right now, and which job they are on. */
      recipientOf: (to: string, from: string) => {
        const found = this.#pick(to, from)
        if (found === undefined) return undefined
        const { id, task, workspace } = found.snapshot()
        return { id, task, workspace }
      },
      diffFor: async (agentId: string) => {
        const given = this.#options.diffFor
        const diff = given ? await given(agentId) : await this.diff(agentId)
        // Enough to review, not enough to fill a window: a diff past this is
        // a sign the handoff is too big, and saying so is more use than
        // sending eighty thousand tokens nobody reads.
        return diff.length > MAX_HANDOFF
          ? `${diff.slice(0, MAX_HANDOFF)}\n… the rest is longer than a message should carry`
          : diff
      },
    }
  }
}

/**
 * One agent: a conversation, a mailbox, and a pump that drains it.
 *
 * Only one turn runs at a time per agent — messages queue rather than
 * interleave — because two turns editing the same conversation would produce a
 * transcript that never happened.
 */
class LiveAgent {
  #def: AgentDef
  readonly #path: string
  readonly #isolated: boolean
  readonly #host: InProcessHost
  readonly #mailbox: AgentMessage[] = []
  readonly #messages: Message[] = []
  #usage: Usage = { inputTokens: 0, outputTokens: 0 }
  /**
   * Who this turn has answered.
   *
   * Kept because a turn that finished and a turn that replied are different
   * things, and the ledger used to treat them as one — so an agent that did
   * the work, said so to nobody and stopped settled the handoff it had never
   * answered, and whoever was waiting waited for ever with nothing on screen
   * saying so.
   */
  readonly #repliedTo = new Set<string>()
  /** Who the current turn's work ultimately belongs to. */
  #origin: string | undefined
  #status: AgentStatus = 'idle'
  #turns = 0
  #lastText: string | undefined
  readonly #activity: number[] = []
  #pump: Promise<void> | undefined
  /** The turn in flight, so it can be stopped without stopping the agent. */
  #running: AbortController | undefined
  /** Typed while the turn was running, waiting for the next step of the loop. */
  readonly #interjections: string[] = []
  /** Commits behind the repository, as of the last sweep. */
  #behind = 0
  /**
   * Whether it may act without being asked, which can change mid-session.
   *
   * Kept here rather than read from the definition each time, because trust
   * given while watching an agent work is a decision about this session, and
   * writing it back to the definition would make it permanent by accident.
   */
  #yolo: boolean

  constructor(def: AgentDef, path: string, isolated: boolean, host: InProcessHost) {
    this.#def = def
    this.#path = path
    this.#isolated = isolated
    this.#host = host

    // Whatever it had said before, if this session is a continuation of one.
    this.#yolo = def.yolo === true
    // Repaired on the way in as well as on the way out. A conversation left
    // broken by an older version — a tool call with no result, from a turn
    // that was interrupted — makes every request fail, so an agent that has
    // one can never speak again until somebody closes it.
    this.#messages.push(...closeOpenCalls(host.internals.options.historyFor?.(def.id) ?? []))
    this.#usage = host.internals.options.usageFor?.(def.id) ?? this.#usage
  }

  /**
   * Takes a message, and says whether it did.
   *
   * A stopped agent takes nothing. Its callers used to carry on as though it
   * had — a handoff recorded, a sender told "delivered" — for a message that
   * had gone nowhere.
   */
  deliver(message: AgentMessage): boolean {
    if (this.#status === 'stopped') return false

    // Something you typed while it was working reaches the turn in flight,
    // rather than queuing behind everything it was already doing. Waiting for
    // a long turn to end means watching an agent carry on down a path you
    // have already told it to abandon — so it is handed over at the next step
    // of the loop, which is where the model can act on it.
    //
    // Only from a person. An agent's message is work to be scheduled, and
    // splicing it into somebody else's turn would make two agents share one
    // conversation.
    if (message.from === 'user' && this.#running !== undefined) {
      this.#interjections.push(message.text)
      return true
    }

    this.#mailbox.push(message)
    this.#start()
    return true
  }

  busy(): boolean {
    return this.#pump !== undefined || this.#mailbox.length > 0
  }

  /** Whether `stop` has been called, which outlasts the turn it interrupted. */
  stopped(): boolean {
    return this.#status === 'stopped'
  }

  async settled(): Promise<void> {
    await this.#pump
  }

  stop(): void {
    this.#status = 'stopped'
    this.#mailbox.length = 0
  }

  /** Told by the sweep, so the snapshot can carry it without waiting on git. */
  setBehind(commits: number): void {
    this.#behind = commits
  }

  /** Stops the turn in flight and drops what was queued behind it. */
  cancel(): boolean {
    const running = this.#running !== undefined
    this.#running?.abort()
    this.#mailbox.length = 0
    this.#interjections.length = 0
    return running
  }

  /** Drops what is waiting and returns how much that was. */
  /** Empties this agent's conversation. See the host's `forget`. */
  forget(): boolean {
    this.#messages.length = 0
    this.#lastText = undefined
    return true
  }

  clearQueue(): number {
    const dropped = this.#mailbox.length + this.#interjections.length
    this.#mailbox.length = 0
    this.#interjections.length = 0
    return dropped
  }

  get id(): string {
    return this.#def.id
  }

  set yolo(on: boolean) {
    this.#yolo = on
  }

  /** Whether it acts unattended, which decides whether anybody can be asked about it. */
  get yolo(): boolean {
    return this.#yolo
  }

  /** What this agent was made from, so a second of it can be made too. */
  /**
   * Points this agent at another model or service, between turns.
   *
   * The definition is what every turn reads its model from, so swapping it is
   * enough: no restart, and the conversation, the spend and the worktree are
   * all where they were.
   */
  retarget(to: { model?: string; provider?: string }): void {
    this.#def = {
      ...this.#def,
      ...(to.model ? { model: to.model } : {}),
      ...(to.provider ? { provider: to.provider } : {}),
    }
  }

  get definition(): AgentDef {
    return this.#def
  }

  snapshot(): AgentSnapshot {
    return {
      id: this.#def.id,
      status: this.#status,
      model: this.#def.model ?? 'default',
      usage: this.#usage,
      turns: this.#turns,
      activity: [...this.#activity],
      workspace: this.#path,
      isolated: this.#isolated,
      yolo: this.#yolo,
      role: roleOf(this.#def),
      task: taskOf(this.#def),
      // What is waiting either way: behind this turn, or held for the next
      // step of it. Both are things somebody typed that have not happened yet,
      // and an interface that counted only one of them would say "nothing
      // waiting" a moment after you typed something.
      queued: this.#mailbox.length + this.#interjections.length,
      behind: this.#behind,
      ...(this.#def.provider === undefined ? {} : { provider: this.#def.provider }),
      ...(this.#lastText === undefined ? {} : { lastText: this.#lastText }),
    }
  }

  #start(): void {
    if (this.#pump) return
    this.#pump = this.#drain().finally(() => {
      this.#pump = undefined
      // Started again for anything that arrived while this pump was on its
      // way out. The idle status is emitted from inside the pump, and an
      // interface that queues the next instruction on that event put it in
      // the mailbox while the pump was still set: the call above saw the
      // pump and did nothing, the pump then cleared itself, and the
      // instruction sat in a mailbox nothing was draining — `busy()` true,
      // nothing to wait on, and `idle()` spinning for the rest of the process.
      if (this.#mailbox.length > 0 && this.#status !== 'stopped') this.#start()
    })
  }

  async #drain(): Promise<void> {
    const { options, governor } = this.#host.internals

    while (this.#mailbox.length > 0 && this.#status !== 'stopped') {
      const message = this.#mailbox.shift()
      if (!message) break

      const verdict = governor.allowTurn(this.#def.id, message.from === 'user' ? 'user' : 'agent')
      if (!verdict.ok) {
        options.onEvent({ type: 'agent_blocked', id: this.#def.id, reason: verdict.reason })
        // Draining the rest would report the same refusal once per message.
        this.#mailbox.length = 0
        break
      }

      try {
        await this.#runTurn(message)
      } catch (cause) {
        // An escaping exception would kill this pump, leaving the agent stuck
        // at "working" for the rest of the session with nothing on screen to
        // say why. Report it and carry on: the next instruction may well work.
        options.onEvent({
          type: 'agent_failed',
          id: this.#def.id,
          reason: this.#explain(cause),
        })
        // Marked in the ledger too. A turn that threw left no mark at all, so
        // the stall notice said "never took a turn on it" about an agent that
        // had taken one and lost it to a provider error — contradicting the
        // error sitting on the screen right above it.
        this.#host.turnEnded(this.#def.id, 'failed', false)
      } finally {
        // However the turn ended. Promoted only when the turn had succeeded,
        // what was typed during one that failed stayed held: the agent went
        // idle with one thing queued, and nothing was ever going to run it.
        this.#answerWhatWasTyped()
      }
    }

    this.#setStatus('idle')
  }

  async #runTurn(message: AgentMessage): Promise<void> {
    const { options, governor } = this.#host.internals
    this.#setStatus('working')
    governor.beginTurn(this.#def.id)
    this.#repliedTo.clear()

    // Brought up to date before it starts, not when it was spawned: a
    // worktree stands still, so an agent left running through an afternoon
    // reads the repository as it was that morning and answers confidently
    // about code that has since changed. Skipped when it has work of its own
    // in there, because moving the ground under it would destroy that work.
    const task = taskOf(this.#def)
    const behind = await this.#host.internals.workspaces.behind(task)
    if ((await this.#host.internals.workspaces.refresh(task)) === 'moved') {
      options.onEvent({ type: 'agent_refreshed', id: this.#def.id, commits: behind })
    }

    // A continuation is the harness speaking, and says so itself.
    const from = message.from === 'user' || message.continued ? '' : `[from ${message.from}] `
    this.#messages.push({
      role: 'user',
      content: [{ type: 'text', text: `${from}${message.text}` }],
    })

    // Its own controller per turn: aborting one must not poison the next.
    const running = new AbortController()
    this.#running = running

    const run = runAgentLoop({
      signal: running.signal,
      provider: options.providerFor(this.#def, this.#path),
      model: this.#def.model ?? 'default',
      system: this.#systemPrompt(),
      tools: this.#toolsFor(options.tools, message),
      messages: this.#messages,
      cwd: this.#path,
      agentId: this.#def.id,
      ...(options.maxTurnsPerInstruction ? { maxTurns: options.maxTurnsPerInstruction } : {}),
      ...(this.#def.maxTokens ? { maxTokens: this.#def.maxTokens } : {}),
      hooks: [...(options.hooks ?? []), this.#interjectionHook(), this.#sharedHook()],
      ...(options.hookNames ? { hookNames: options.hookNames } : {}),
    })

    // What this turn cost, as opposed to what the agent has cost. Both are
    // wanted below and they are easy to reach for by mistake, so the delta
    // gets a name of its own rather than being read back off the total.
    //
    // Summed here as the requests go by, rather than read off the loop's
    // result at the end: a turn that throws has no result. Three requests of
    // a hundred thousand tokens each and then a 502 were recorded as free,
    // and the agent — half again over its budget — was let through to spend
    // more.
    const spentThisTurn: Usage = { inputTokens: 0, outputTokens: 0 }
    /** How the turn ended, which decides whether it has an answer to give. */
    let ended = ''
    // What this turn said, for the answer it owes. Read off the responses as
    // they go by rather than off the conversation afterwards: the
    // conversation is the whole history, and reading it backwards for "the
    // last thing said" found the previous job's answer whenever this turn
    // ended without one — a confident, specific, entirely unrelated sentence,
    // relayed as the result.
    const said: TurnWords = { closing: '' }
    // Whether this turn answered whoever asked, which is what decides if the
    // handoff is settled. An instruction from the person is answered by being
    // on their screen. An answer needs no answer, and treating it as one
    // leaves the ledger holding a debt nobody can ever pay — which reads, to
    // anything asking whether the team has stalled, exactly like a team that
    // has. Anything else is answered only by a message back, and if the agent
    // did not send one the harness sends it below and settles the ledger
    // then. Asked at the end rather than now, because the answer can be sent
    // partway through.
    const answered = (): boolean =>
      message.from === 'user' || message.reply === true || this.#repliedTo.has(message.from)

    try {
      for (;;) {
        const step = await run.next()
        if (step.done) {
          this.#messages.length = 0
          this.#messages.push(...step.value.messages)
          this.#lastText = lastTextOf(step.value.messages) ?? this.#lastText
          // A turn that stopped is not a turn that finished, and until now
          // this was the place that forgot the difference. `aborted` is left
          // out: somebody pressed the key, so they already know.
          const stopped = step.value.stopReason
          ended = stopped
          // Sent back to work rather than reported as stopped, when nobody is
          // watching and the count allows. The ledger is left alone: the
          // handoff is still being worked on.
          if (stopped === 'max_turns' && this.#carriesOn(message)) break
          // The ledger learns the same thing at the same moment: a clean end
          // is an answer to whoever was waiting, and anything else is not.
          this.#host.turnEnded(this.#def.id, stopped, answered())
          if (stopped !== 'end_turn' && stopped !== 'stop_sequence' && stopped !== 'aborted') {
            const unrun = unrunToolOf(step.value.messages)
            options.onEvent({
              type: 'agent_cut_short',
              id: this.#def.id,
              reason: stopped,
              ...(unrun ? { tool: unrun } : {}),
            })
          }
          break
        }
        if (step.value.type === 'assistant_turn') {
          accumulateUsage(spentThisTurn, step.value.turn.usage)
          said.closing = textOf(step.value.turn.content)
          if (said.closing !== '') said.lastWords = said.closing
        }
        options.onEvent({ type: 'agent_event', id: this.#def.id, event: step.value })
      }
    } catch (cause) {
      // The escape key, as a real provider delivers it: fetch throws an
      // AbortError when its signal fires, and so the loop threw too. That is
      // not a failure — it is the thing the person just did — and it reached
      // the screen as "agent_failed: The operation was aborted." A turn that
      // threw under its own abort ends the way one that noticed the signal
      // in time ends: quietly, with nothing to answer.
      if (!running.signal.aborted) throw cause
      ended = 'aborted'
      this.#host.turnEnded(this.#def.id, ended, answered())
    } finally {
      // Cleared here rather than after the loop, because a turn that throws
      // never reaches the line after it: the agent then looked busy for the
      // rest of the session, and everything typed at it was held for a step
      // that would never come.
      this.#running = undefined

      // Charged however the turn ended, and before anything is written down,
      // so the total the history keeps is the one the money was spent on.
      // Below the loop, none of this happened for a turn that threw: the
      // tokens were gone and the budget never heard.
      this.#usage = addUsage(this.#usage, spentThisTurn)
      this.#turns += 1
      // One sample per turn, sized by what the turn cost: the trace then
      // shows effort rather than merely elapsed time. Read off the running
      // total this said nothing about the turn — it climbed with the session
      // and wrapped at five thousand, so a quiet turn after a long one drew
      // tall.
      this.#activity.push(Math.min(8, Math.round(spentThisTurn.outputTokens / 600) + 1))
      if (this.#activity.length > 120) this.#activity.shift()
      governor.charge(this.#def.id, spentThisTurn)
      governor.recordTurn(this.#def.id)

      // Written down however the turn ended, not only when it ended well. An
      // agent that worked all afternoon and stopped on a provider error, or
      // was cancelled, used to have nothing kept — so reopening the session
      // found it with no idea what it had been doing, and the instruction it
      // had been given was gone too. What was said before the failure is
      // exactly what makes the next attempt possible.
      // Never written down with a call left open. A turn that stops between
      // asking for a tool and running it — the escape key, a dropped
      // connection — leaves one, and every dialect refuses a conversation
      // that has one: "No tool output found for function call". Saving it as
      // it is would make an agent permanently unable to say anything.
      this.#messages.splice(0, this.#messages.length, ...closeOpenCalls(this.#messages))
      options.onHistory?.(this.#def.id, this.#messages, this.#usage)
    }

    await this.#answerWhoeverAsked(message, ended, said)
  }

  /**
   * Turns what was typed during the last response into the next turn.
   *
   * An interjection joins the turn's next request, and a turn's last response
   * has none: typed while the model was writing its final sentence, it sat in
   * the queue until the next turn's first request — hours later, under an
   * unrelated instruction, with a question nobody remembered asking pasted
   * onto the end. Watched: "pwd? you should be in another folder" went
   * unanswered. So whatever is still waiting when a turn ends becomes the
   * turn that runs next, ahead of anything else queued.
   */
  #answerWhatWasTyped(): void {
    if (this.#interjections.length === 0) return
    const said = this.#interjections.splice(0).join('\n')
    const origin = this.#host.internals.options.leader ?? this.#def.id
    this.#mailbox.unshift({ from: 'user', to: this.#def.id, text: said, hops: 0, origin })
  }

  /**
   * Puts the same instruction back at the front of the mailbox, if it may.
   *
   * Only for an agent turned loose — when somebody is watching, the stop is
   * theirs to lift — and only `MAX_CONTINUATIONS` times, so a model that is
   * genuinely going round in circles is still stopped. What goes back keeps
   * who asked and who the work belongs to, so the report at the end still
   * finds its way home.
   */
  #carriesOn(message: AgentMessage): boolean {
    const round = (message.continued ?? 0) + 1
    if (!this.#yolo || round > MAX_CONTINUATIONS) return false

    const { options } = this.#host.internals
    this.#mailbox.unshift({
      ...message,
      text: carryOn(options.maxTurnsPerInstruction, MAX_CONTINUATIONS - round),
      continued: round,
    })
    options.onEvent({ type: 'agent_continued', id: this.#def.id, round, of: MAX_CONTINUATIONS })
    return true
  }

  /**
   * Sends the turn's answer back to the agent that asked for it.
   *
   * A handoff is a request, and a request nobody answers is a failure of the
   * protocol rather than of the model's diligence — so it is closed here
   * instead of being asked for in a prompt. Observed before it was written:
   * an agent finished the work, wrote "verification passed" into its own
   * transcript, and stopped; the agent that had handed it over was left
   * waiting for a message nobody was going to send, with no turn in which to
   * notice, and the ledger had already recorded the handoff as answered.
   *
   * Only when it did not answer for itself. An agent that replied has said
   * its own thing to its own recipient, and adding a second copy would be the
   * harness talking over the agent it exists to carry.
   *
   * Only between agents. A turn the person started ends by being on the
   * screen they are reading; a reply addressed to nobody is a turn spent
   * talking to a transcript.
   *
   * Only from a turn that finished. One cut short has half a thought rather
   * than an answer. One that finished saying nothing gets a report written
   * for it — see `#closingReport` — because a turn that ended is the news
   * the leader is waiting for, with or without the words.
   *
   * Never in answer to an answer, or the two of them thank each other until
   * the hop limit intervenes.
   *
   * It travels as an ordinary message, so it is bounded by the same hop limit
   * as anything else an agent sends, and a chain of them stops where any
   * other chain would. It is not charged to the agent's per-turn allowance,
   * because it is not the agent's message.
   */
  async #answerWhoeverAsked(message: AgentMessage, ended: string, said: TurnWords): Promise<void> {
    if (message.from === 'user') return
    if (this.#repliedTo.has(message.from)) return

    // Never an answer to an answer. Without this the two of them say "done"
    // and "thank you" to each other until the hop limit stops them, which is
    // thirty-two turns of politeness nobody asked for and somebody pays for.
    // One closing message per handoff, which is what closing it means.
    if (message.reply === true) return

    // Only a turn that finished has an answer. One cut short by the output
    // cap or a limit has half a thought, and sending that as though it were
    // the result both misleads the reader and erases the ledger entry the
    // stall notice exists to show.
    if (ended !== 'end_turn' && ended !== 'stop_sequence') return

    // Reported to whoever owns the job rather than to whoever happened to
    // pass it on. They are the same agent for a chain one link long, and for
    // a longer one this is the difference between the owner hearing that the
    // work is written and hearing that it passes.
    const to = message.origin ?? message.from
    if (to === this.#def.id) return
    if (this.#repliedTo.has(to)) return

    // The closing message is the answer. When there is none — the model ran
    // its last tool and returned an empty response with end_turn, which some
    // do — a report goes in its place rather than nothing: nothing left the
    // ledger open on a job that was finished, and the leader waiting for it.
    const closing = said.closing.trim()
    const answer = closing !== '' ? closing : await this.#closingReport(said.lastWords)

    const sent = await this.#host.internals.relay({
      from: this.#def.id,
      to,
      text: answer,
      // The same hop, not the next one. Hops bound how far a job travels from
      // the person who started it, and an answer is that journey ending
      // rather than continuing — counting it spends the budget for forward
      // progress on the message that reports there was some. It was found by
      // being bitten: a three-agent chain reported nothing back, because the
      // reply from the far end was one hop past the limit and was dropped.
      // Nothing runs away on this: a reply never earns another reply.
      hops: message.hops,
      reply: true,
      ...(message.origin ? { origin: message.origin } : {}),
    })

    // Settled only once it is actually on its way. A reply refused by the hop
    // limit leaves somebody genuinely waiting, and that is the case the stall
    // notice exists for.
    if (sent.delivered) this.#host.turnEnded(this.#def.id, 'end_turn', true)
  }

  /**
   * The answer the harness writes when a turn finished without one.
   *
   * Says whose words these are, because the recipient reads it under
   * `[from coder]` and would otherwise take the harness's shrug for the
   * coder's considered report. What it did say and what it changed are the
   * two things a leader can act on: ask again, or go and look.
   */
  async #closingReport(lastWords: string | undefined): Promise<string> {
    const id = this.#def.id
    const changed = filesIn(await this.#host.internals.diffFor(id).catch(() => ''))
    const words =
      lastWords === undefined
        ? 'It said nothing at all during the turn.'
        : `Its last words were: "${clipped(lastWords)}"`
    const files =
      changed === 0 ? '' : ` It changed ${changed} file${changed === 1 ? '' : 's'} in its checkout.`
    return (
      `${id} finished its turn without a closing message — this is the harness reporting, ` +
      `not ${id}. ${words}${files}`
    )
  }

  /**
   * Puts what the team has established in front of the model.
   *
   * Added at the end, next to the current instruction, rather than at the top:
   * a note written an hour ago is not the oldest thing in the conversation,
   * it is the most recent thing anybody agreed, and burying it under a
   * transcript is a way of having written it down and not read it.
   *
   * Replaced rather than appended each turn, so the note appears once however
   * many turns a conversation runs for.
   */
  #sharedHook(): Hooks {
    const shared = this.#host.internals.shared
    const task = taskOf(this.#def)

    return {
      async preTurn(messages: Message[]): Promise<Message[] | undefined> {
        const carried = asMessage(shared.read(task), task)
        const { without, removed } = withoutShared(messages, task)
        if (carried === undefined) return removed ? without : undefined

        const last = without.at(-1)
        if (last === undefined) return [carried]

        // Before the last message, which is what the agent was actually asked:
        // context comes before the question, never after it.
        //
        // Unless the last message is answering a tool call. Then it has to
        // stay directly after the call — every provider refuses a
        // conversation where it does not, "tool_use ids were found without
        // tool_result blocks immediately after" — and putting the note
        // between the two was exactly that. Once any note existed, every turn
        // that used a tool failed at its second request. So mid-turn the note
        // goes inside that message: after the results, and before anything
        // the person typed meanwhile.
        if (last.role === 'user' && last.content.some((block) => block.type === 'tool_result')) {
          const at = last.content.findLastIndex((block) => block.type === 'tool_result') + 1
          const content = [
            ...last.content.slice(0, at),
            ...carried.content,
            ...last.content.slice(at),
          ]
          return [...without.slice(0, -1), { role: 'user', content }]
        }
        return [...without.slice(0, -1), carried, last]
      },
    }
  }

  /**
   * Hands the model anything typed since the last step of this turn.
   *
   * `preTurn` runs before every request the loop makes, including the ones in
   * the middle of a turn, which is exactly the seam this needs. Added to the
   * last message when that message is already the user's — two user messages
   * in a row is legal everywhere and read as one thought by nobody.
   */
  #interjectionHook(): Hooks {
    const waiting = this.#interjections

    return {
      async preTurn(messages: Message[]): Promise<Message[] | undefined> {
        if (waiting.length === 0) return undefined

        const said = waiting.splice(0).join('\n')
        const last = messages.at(-1)

        if (last?.role === 'user') {
          return [
            ...messages.slice(0, -1),
            { role: 'user', content: [...last.content, { type: 'text', text: said }] },
          ]
        }
        return [...messages, { role: 'user', content: [{ type: 'text', text: said }] }]
      },
    }
  }

  /**
   * The agent's tools, plus the one that lets it talk to the others.
   *
   * `agent_send` is built per turn because it carries this message's hop count:
   * a reply is one hop further along than what prompted it.
   */
  #toolsFor(base: Tool[], incoming: AgentMessage): Tool[] {
    this.#origin = incoming.origin
    const allowed = this.#def.tools
    const usable = allowed ? base.filter((tool) => allowed.includes(tool.name)) : base

    return [
      ...usable,
      this.#sendTool(incoming.hops + 1),
      // Only when the team is keeping one. A tool an agent cannot usefully
      // call is a tool it will call anyway, and then be told no.
      ...(this.#host.internals.options.sharedMemory === true ? [this.#noteTool()] : []),
    ]
  }

  /**
   * Writing something down for everybody else on this task.
   *
   * Agents on one job share a checkout but not their reasoning: the reviewer
   * does not know why a shape was chosen, and rediscovers it by reading code
   * and guessing. This is where the answer goes instead.
   */
  #noteTool(): Tool {
    const shared = this.#host.internals.shared
    const task = taskOf(this.#def)
    const from = this.#def.id
    const shorten = (name: string) => this.#host.internals.shortenNotes(name)

    return {
      name: 'task_note',
      description:
        'Write down something the other agents on this task need to know and cannot work out ' +
        'from the code: a decision, a constraint, a dead end. Everyone on the task sees it. ' +
        'Keep it to a sentence — this is a shared note, not a log.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'One thing worth knowing, in a sentence.' },
        },
        required: ['text'],
      },
      async execute(input: unknown) {
        const { text } = (input ?? {}) as { text?: unknown }
        if (typeof text !== 'string' || text.trim() === '') {
          return { content: 'task_note needs something to say', isError: true }
        }

        const written = remember(shared.read(task), { from, text, at: Date.now() })
        shared.write(task, written)

        // Whoever wrote the note that tipped it over is the one who shortens
        // it. Not a timer and not the next reader: the cost belongs to the
        // turn that caused it, and a reader made to pay for somebody else's
        // notes is a reader that pauses for no reason it can see.
        if (tooLong(written)) await shorten(task)
        return { content: `noted for everyone on "${task}"` }
      },
    }
  }

  /**
   * The agent's own file, and then where it is.
   *
   * Its own first: what it is for is the frame, and who else is here is the
   * situation that frame is applied in. An agent working alone gets its file
   * unchanged, which is also what keeps the single-agent path exactly as it
   * was.
   *
   * Rebuilt per turn, like the tools beside it, so somebody spawned mid-session
   * is on the roster the next time anybody speaks rather than at the next
   * restart. It changes only when the team does, so the prompt prefix a
   * provider is caching survives every turn that changes nothing.
   */
  #systemPrompt(): string {
    const options = this.#host.internals.options
    const briefing = teamBriefing({
      agents: this.#host.internals.roster(),
      from: this.#def.id,
      sharedMemory: options.sharedMemory === true,
      ...(options.orchestration ? { instructions: options.orchestration } : {}),
    })

    return briefing === undefined
      ? this.#def.systemPrompt
      : `${this.#def.systemPrompt}\n\n${briefing}`
  }

  #sendTool(hops: number): Tool {
    const { relay, recipientOf, diffFor: workOf } = this.#host.internals
    const from = this.#def.id
    const task = taskOf(this.#def)
    const path = this.#path
    // Who this turn has answered, so the harness can tell a turn that
    // finished from a turn that replied. They are not the same thing and the
    // ledger used to assume they were.
    const replied = this.#repliedTo
    // Carried along unchanged, so the third agent on a chain still knows who
    // is waiting on the whole of it.
    const origin = this.#origin

    return {
      name: 'agent_send',
      // The team is named here, in the description, because this is the only
      // thing a model reads before choosing — and "by name" with the names
      // nowhere is a parameter to be guessed at. It was: an instruction had to
      // say who to hand the work to, when the harness is the thing that knows.
      //
      // Built per turn already, for the hop count, so the roster is whoever is
      // on the team at the moment of asking rather than whoever was there when
      // the session opened — and, since it is, who is mid-turn right now, so
      // the choice between two of a role is made knowing it and can be read
      // off the transcript afterwards. That changes the description between
      // turns more often than the roster does, which is a cache miss at the
      // top of a turn and never inside one: the tools are fixed when it starts.
      description:
        'Send a message to another agent by name. They reply in their own time; one marked ' +
        `[busy] is mid-turn and reads it after. ${describeTeam(this.#host.internals.roster(true), from)}`,
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'The agent name.' },
          message: { type: 'string', description: 'What to tell them.' },
        },
        required: ['to', 'message'],
      },
      async execute(input: unknown) {
        const { to, message } = (input ?? {}) as { to?: unknown; message?: unknown }
        if (typeof to !== 'string' || typeof message !== 'string') {
          return { content: 'agent_send needs a "to" name and a "message" string', isError: true }
        }

        // What the sender has changed goes with the message, when the reader
        // cannot see it. A checkout is per task: a colleague on another task
        // is in a worktree of their own, and "I have written the four files"
        // hands them a sentence about work they cannot see — they then spend
        // turns hunting for it and end up reading absolute paths into
        // somebody else's checkout, which defeats the isolation. A colleague
        // on the same task is standing in the directory the files were
        // written into, and the diff went to them too: tens of kilobytes in
        // the message, then in every request of every turn after it, under a
        // sentence saying the worktree was not theirs. For them it is one
        // line saying where to look.
        const changed = await workOf(from)
        // Resolved here, with nothing awaited between this and the relay, so
        // it is the same answer the relay is about to give.
        const reader = recipientOf(to, from)
        const carried =
          changed === '' || reader === undefined
            ? message
            : reader.task === task
              ? `${message}\n\n${inPlace(path)}`
              : `${message}\n\n${asDiff(changed)}`

        const result = await relay({ from, to, text: carried, hops, ...(origin ? { origin } : {}) })
        if (!result.delivered) return { content: result.reason, isError: true }
        // Remembered as the agent it reached, not as the name typed. A role
        // name answered nobody's handoff — "reviewer" is not "bea" — so the
        // turn looked unanswered and the harness sent the closing words to
        // the same agent a second time.
        replied.add(result.to)
        return { content: `delivered to ${result.to}` }
      },
    }
  }

  /**
   * A failure in words that say where it happened.
   *
   * "The operation timed out." is what a stalled request says of itself, and
   * on a screen with five agents on three services it says nothing anybody
   * can act on. Watched: an agent on a slow service went quiet for twenty
   * minutes and ended on those four words.
   */
  #explain(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : String(cause)
    const timedOut =
      (cause instanceof DOMException && cause.name === 'TimeoutError') ||
      /operation timed out/i.test(message)
    if (!timedOut) return message
    const service = this.#def.provider ?? 'the provider'
    return `the request to ${service} for ${this.#def.model ?? 'default'} timed out before it answered`
  }

  #setStatus(status: AgentStatus): void {
    if (this.#status === 'stopped' || this.#status === status) return
    this.#status = status
    this.#host.internals.options.onEvent({ type: 'agent_status', id: this.#def.id, status })
  }
}

/**
 * The job an agent is on, which decides whose checkout it shares.
 *
 * Everything without one is on the main task, so a project that never mentions
 * tasks is one team working together — which is what a team is for.
 */
export function taskOf(def: AgentDef): string {
  return def.task ?? MAIN_TASK
}

export const MAIN_TASK = 'main'

/**
 * How many times an unleashed agent is told to carry on past its turn limit.
 *
 * The limit exists to stop a model going round in circles, and it stops one
 * that is building something too: a coder forty tool calls into a project
 * stopped with a file half-edited, and the person who had said "stop only
 * when you have something to show me" came back three hours later to type
 * "go on?". Unleashed means nobody is watching, so the harness says it
 * instead — this many times, and then the stop is real.
 */
export const MAX_CONTINUATIONS = 4

/** What an agent is told when the harness sends it back to work. */
function carryOn(limit: number | undefined, left: number): string {
  const reached = limit === undefined ? 'its limit' : `the limit of ${limit} tool calls`
  return (
    `This is the harness, not a colleague: your last turn reached ${reached} before the work was ` +
    'finished. Carry on from exactly where you were — do not start over, and do not re-read what ' +
    'you have already read. When the job is done, report as you were asked. ' +
    (left === 0
      ? 'This is the last time you will be sent back: after this turn the stop is final.'
      : `You will be sent back like this ${left} more time${left === 1 ? '' : 's'} at most.`)
  )
}

/**
 * The conversation with the shared note taken out, wherever the hook put it
 * last time: a message of its own between turns, or a block inside the reply
 * to a tool call mid-turn. `removed` says whether there was one to take out,
 * so a hook with nothing to add can leave the conversation untouched.
 */
function withoutShared(
  messages: Message[],
  task: string,
): { without: Message[]; removed: boolean } {
  let removed = false
  const without: Message[] = []
  for (const message of messages) {
    if (message.role !== 'user') {
      without.push(message)
      continue
    }
    const kept = message.content.filter((block) => !isSharedNote(block, task))
    if (kept.length === message.content.length) {
      without.push(message)
      continue
    }
    removed = true
    if (kept.length > 0) without.push({ role: 'user', content: kept })
  }
  return { without, removed }
}

/** Whether a block is the shared note the hook put there last turn. */
function isSharedNote(block: ContentBlock, task: string): boolean {
  return block.type === 'text' && block.text.startsWith(`What the team working on "${task}"`)
}

/** Whether an agent is who a message addressed to `to` means, by name or role. */
function answersTo(agent: LiveAgent, to: string): boolean {
  return agent.id === to || roleOf(agent.definition) === to
}

/** How much of a diff one handoff may carry. */
const MAX_HANDOFF = 24_000

/**
 * What an agent is for, falling back to what it is called.
 *
 * The numeric suffix is stripped so a second spawned mid-session belongs to
 * the same role as the one it copies even if nobody wrote a role down.
 */
function roleOf(def: AgentDef): string {
  return def.role ?? def.id.replace(/-\d+$/, '')
}

/**
 * The tool call a cut-off turn had started and never got to run.
 *
 * A turn that overruns its output budget partway through a call leaves the
 * call in the transcript with whatever arrived — usually nothing — and the
 * loop returns without executing it. The name is the whole of what makes the
 * report actionable: "it ran out of room" is a shrug, and "the write it had
 * started never ran" is something to do.
 */
function unrunToolOf(messages: Message[]): string | undefined {
  const last = messages.at(-1)
  if (last?.role !== 'assistant') return undefined
  for (let index = last.content.length - 1; index >= 0; index--) {
    const block = last.content[index]
    if (block?.type === 'tool_use') return block.name
  }
  return undefined
}

function lastTextOf(messages: Message[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role !== 'assistant') continue
    const text = textOf(message.content)
    if (text !== '') return text
  }
  return undefined
}

/** The text of one response, with its tool calls and thinking left out. */
function textOf(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

/** What a turn said, for the answer it owes. See `#runTurn`. */
type TurnWords = {
  /** The response that ended the turn, which is the answer when it says anything. */
  closing: string
  /** The last thing said anywhere in the turn, for the report when the closing is empty. */
  lastWords?: string
}

/** How many files a diff touches, counting new files the way `diff()` lists them. */
function filesIn(diff: string): number {
  return (
    (diff.match(/^diff --git /gm)?.length ?? 0) + (diff.match(/^\+\+\+ new file: /gm)?.length ?? 0)
  )
}

/** Enough of the last words to recognise them, not the whole paragraph. */
function clipped(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** The line under a message to a colleague standing in the same checkout. */
function inPlace(path: string): string {
  return (
    `My changes are already in place in the checkout we share, ${path} — read them there ` +
    'rather than asking for a diff.'
  )
}

/** The diff under a message to a colleague in a checkout of their own. */
function asDiff(changed: string): string {
  return (
    'What I changed, as a diff — my worktree is not yours, so this is the work itself rather ' +
    `than somewhere to look for it:\n\n${changed}`
  )
}

/** Why a message was put behind what its recipient is doing, without anybody being asked. */
function queuedBehind(target: string, unleashed: string[]): string {
  const why =
    unleashed.length === 0
      ? 'there is nobody here to ask whether to wait'
      : `${unleashed.join(' and ')} ${unleashed.length === 1 ? 'is' : 'are'} unleashed, ` +
        'so nobody was asked whether to wait'
  return `queued behind what ${target} is doing: it is busy, and ${why}`
}

/**
 * Who else is on the team, for the tool that talks to them.
 *
 * Everybody but the reader — an agent cannot send to itself and the governor
 * refuses it, so listing it is offering a mistake. Each with what it is for,
 * because a name alone answers "who can I write to" and not "who should I".
 */
/** One agent, as the roster knows it. `busy` only where the moment matters. */
export type AgentLine = { id: string; description?: string; busy?: boolean }

/**
 * What an agent is told about the situation it is in, as opposed to the job.
 *
 * An agent's own file says what it is for. It cannot say who else is here or
 * that anybody else is here at all: that is decided when the session opens and
 * changes while it runs. So an agent's only clue that it was on a team used to
 * be the description of the tool for talking to one, and the behaviour that
 * follows from knowing — hand the work on, do not stop to ask — was left to be
 * inferred from a tool description. It was not inferred. The common ending to
 * a turn was a question put to a person who had gone.
 *
 * Nothing here is advice about being a good agent. Every line is something
 * this harness does that a model cannot see from inside one turn: that the
 * checkouts are separate, that the diff travels with the message, that the
 * notes are shared, that nobody is reading the reply.
 *
 * Returns nothing for an agent working alone. A single agent told to hand its
 * work to a list of nobody spends turns looking for somebody to hand it to.
 *
 * It is short on purpose: this rides with the system prompt on every request
 * of every turn of every agent, so a paragraph nobody needed is a bill. There
 * is a test that keeps it short, and one that keeps it honest about `task_note`
 * being absent when the team is not keeping notes.
 */
export function teamBriefing(options: {
  agents: AgentLine[]
  from: string
  /** Whether `task_note` is on this team's tool list. */
  sharedMemory?: boolean
  /**
   * What the project says about how its team works, from ORCHESTRATE.md.
   *
   * Replaces the wording below and never the roster: the roster is the half a
   * file cannot know, so it is always the harness that supplies it. An edited
   * file therefore cannot accidentally leave an agent with no idea who is here.
   */
  instructions?: string | undefined
}): string | undefined {
  const others = options.agents.filter((agent) => agent.id !== options.from)
  if (others.length === 0) return undefined

  const roster =
    `You are one of several agents working on this together, not an assistant answering a ` +
    `person. ${describeTeam(options.agents, options.from)}`

  const said = options.instructions?.trim()
  return `${roster}\n\n${said !== undefined && said !== '' ? said : ORCHESTRATION.trim()}${
    said !== undefined && said !== '' ? '' : notesLine(options.sharedMemory === true)
  }`
}

/** The paragraph about shared notes, which only applies when there are any. */
function notesLine(sharedMemory: boolean): string {
  return sharedMemory
    ? '\n\nWhat you worked out that the code does not show — a decision, a constraint, a dead ' +
        'end — goes in task_note, once, in a sentence. Read what is there before starting ' +
        'something somebody may already have done.'
    : ''
}

/** Where a project says how its team should work. */
export const ORCHESTRATION_FILE = 'ORCHESTRATE.md'

/**
 * How a team works here, when the project has not said otherwise.
 *
 * Exported so `aidcrew` can write it into ORCHESTRATE.md for somebody to edit:
 * the default has to be good enough that most projects never touch it, and
 * visible enough that the ones that want to, can.
 */
export const ORCHESTRATION = `
Nobody is watching this run. Whoever started it has gone, so a turn that ends by asking
permission ends the work. When the next step is clear, take it. When it belongs to somebody
else, send it to them with agent_send and say what you expect back.

Read the least that lets you act, then act; verify by running, not by reading. Do not do
somebody else's half: if you plan, the plan going out is your turn finished.

A handoff is not a summary: say what you did, what is left, and the check that proves it.
A colleague on your task already has your files; one on another task gets them as a diff.

Finished means checked, not written. If this project has tests, they pass before you hand
anything on or call it done.

In a git repository your checkout is on a branch made for the job, work/<job>. Commit as
you go — small, with no signature or trailer — and never git reset --hard or git push
--force. The leader brings it home: when a report says the checks pass, run them on that
branch, then merge it into the repository's branch with
git -C "$(git rev-parse --git-common-dir)/.." merge --no-ff --no-edit work/<job>
and only then say the job is done.

If you are stuck, say so to whoever gave you the work, with what you tried. Stopping
quietly reads exactly like still working.
`

export function describeTeam(agents: AgentLine[], from: string): string {
  const others = agents.filter((agent) => agent.id !== from)
  if (others.length === 0) return 'There is nobody else on this team yet.'

  const named = others
    .map((agent) => {
      const what = agent.description ? `${agent.id} (${agent.description})` : agent.id
      // Only where the roster was asked for the moment: in the system prompt
      // a status would change with every colleague finishing, and the cached
      // prefix with it.
      return agent.busy === undefined ? what : `${what} [${agent.busy ? 'busy' : 'free'}]`
    })
    .join(', ')
  return `On this team: ${named}.`
}
