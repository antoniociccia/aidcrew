/**
 * What the agent reads from a project besides its code: standing instructions,
 * skills it can pull in when relevant, and the agents it can run as.
 *
 * These types are deliberately format-free. `CLAUDE.md`, `AGENTS.md` and the
 * `.claude/` layout are one loader plugin's business; the core sees only what
 * comes out the other side, so a format changing upstream means changing a
 * plugin rather than the core.
 */

/** A standing instruction, always in the system prompt. */
export type Instruction = {
  /** Where it came from, so a surprising rule can be traced back. */
  source: string
  text: string
}

/**
 * A skill the model can pull in when it decides it is relevant.
 *
 * Only `name` and `description` reach the system prompt; the body is read by a
 * tool on demand. Twenty skills inlined would cost more context than the whole
 * base prompt, and nineteen of them would be irrelevant to the task at hand.
 */
export type Skill = {
  name: string
  description: string
  /** Read when the model asks for this skill by name. */
  path: string
}

/** An agent the user can run or spawn. */
export type AgentDef = {
  id: string
  description: string
  systemPrompt: string
  /** Provider and model for this agent; absent means the session default. */
  provider?: string
  model?: string
  /** Tool names this agent may use; absent means all of them. */
  tools?: string[]
  /**
   * Environment variable holding this agent's API key, so two agents on the
   * same provider can run on different plans or accounts.
   */
  apiKeyEnv?: string
  /**
   * Whether this agent may act without being asked first.
   *
   * Trust is a property of the agent, like its model: a reviewer that only
   * reads can be left alone, while the one rewriting your auth code probably
   * should not be. The core carries the flag and enforces none of it — what it
   * means is decided by whichever hook is watching.
   */
  yolo?: boolean
  /** Input tokens past which this agent's conversation is shortened. */
  compactAt?: number
  /**
   * How long one of this agent's answers may be, when the default is wrong.
   *
   * Per agent for the reason `compactAt` is: it is a property of the model it
   * runs on. Needed only by a service that refuses the default, which is
   * generous on purpose — a turn cut in half loses the tool call it was in the
   * middle of.
   */
  maxTokens?: number
  /**
   * Who writes its summaries, if not the agent itself.
   *
   * `provider/model` names both — `zen/a-small-model` — and is the form
   * that works: the summary is a small mechanical job, and a cheaper model on
   * a cheaper service is the point. A bare provider is asked for the agent's
   * own model, which only helps when that service serves it.
   */
  compactWith?: string
  /**
   * What this agent is for, as opposed to which one it is.
   *
   * Several agents can share a role, and work sent to a role goes to whichever
   * of them is free — which is the whole point of having two. Absent means the
   * agent's own name is its role, so a team that never mentions roles behaves
   * exactly as it did before.
   */
  role?: string
  /**
   * The job this agent is on, which decides whose checkout it shares.
   *
   * Agents on the same task work in the same directory and see one another's
   * files, which is the point of a team. Two tasks running at once cannot see
   * each other's half-finished work. Absent means the main task, so a project
   * that never mentions tasks behaves as one team on one job.
   */
  task?: string
}

export type LoadedSources = {
  instructions: Instruction[]
  skills: Skill[]
  agents: AgentDef[]
}

/**
 * Reads one kind of source from a path.
 *
 * Every method is optional: a loader that only understands instruction files
 * implements only the first one.
 */
export type Loader = {
  name: string
  loadInstructions?(path: string): Promise<Instruction[]>
  loadSkills?(directory: string): Promise<Skill[]>
  loadAgents?(directory: string): Promise<AgentDef[]>
}

export const emptySources = (): LoadedSources => ({
  instructions: [],
  skills: [],
  agents: [],
})
