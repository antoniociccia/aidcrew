import type { AgentSnapshot } from '../agents/host.ts'
import type { Provider, Tool, ToolContext, ToolOutput } from '../loop.ts'
import type { Loader } from '../sources/types.ts'
import type { Message, Usage } from '../types.ts'

/**
 * A provider is declared, not instantiated: the plugin describes how to build
 * one, and the host supplies the credentials and endpoint at load time. That
 * way a plugin never has to know where configuration comes from.
 */
export type ProviderDefinition = {
  id: string
  create(config: unknown): Provider
  /**
   * Where this provider answers, when it is a fixed address.
   *
   * Declared so nothing else has to keep its own copy of the URL. A second
   * copy is how `opencode-go` ended up working for requests and failing to
   * list its models: the list was read from a map that had not been updated.
   */
  endpoint?: string
  /**
   * Whether this provider needs an API key at all.
   *
   * Most do. One serving a model on this machine does not, nor does the
   * demo's, and demanding a key for it would mean inventing one to get past
   * the check.
   * Absent means yes, because that is the case that must not be got wrong by
   * forgetting to say so.
   */
  needsKey?: boolean
  /**
   * Whether this provider keeps and shortens its own conversation.
   *
   * True for one that runs another coding program: it holds the history, not
   * us, and compacting here would be shortening our copy of something we do
   * not have. Absent means no, because a plain endpoint remembers nothing.
   */
  keepsOwnHistory?: boolean
  /**
   * Which models this provider will answer for, when it can say.
   *
   * Here rather than in the interface because the interface cannot know the
   * dialect. Discovery used to be one hardcoded path and one hardcoded auth
   * header, written down in two places: right for the services that share
   * that convention and wrong for the rest, which offered a blank field
   * instead — and a blank field is where mistyped model ids come from. A
   * provider that cannot answer leaves this out, and the caller falls back to
   * the field.
   *
   * A catalogue is not an entitlement: a name here means the gateway will
   * route it, not that a plan covers it or that the upstream is up.
   */
  listModels?(config: unknown, signal: AbortSignal): Promise<string[]>
}

/** What a hook running before a turn is told about it. */
export type TurnContext = {
  agentId: string
  /** The model about to be asked, as the agent named it. */
  model: string
  /** What the previous turn cost, which is the only true measure we get of size. */
  lastUsage: Usage
  /** Which turn this is, counting from one. */
  turn: number
  signal: AbortSignal
}

export type ToolCallInfo = {
  id: string
  name: string
  input: unknown
}

/**
 * Hooks compose rather than collide: every plugin's hook runs, in registration
 * order. This is where permission prompts, audit logging and context
 * management live — none of them belong inside the loop.
 */
export type Hooks = {
  /**
   * Runs before each request. Returning messages replaces the ones sent.
   *
   * This is where a conversation gets shortened when it no longer fits. The
   * context carries who is speaking and what the last turn cost, because both
   * decisions — whether to shorten, and what to shorten it with — belong to
   * the agent rather than to the harness.
   */
  preTurn?(messages: Message[], context: TurnContext): Promise<Message[] | undefined>

  /**
   * Runs before a tool executes. Returning a ToolOutput cancels the call and
   * hands that result to the model instead — which is how an approval gate
   * refuses a command without ending the session.
   */
  preToolCall?(call: ToolCallInfo, context: ToolContext): Promise<ToolOutput | undefined>

  /** Runs after a tool executes. Returning a ToolOutput replaces the result. */
  postToolCall?(
    call: ToolCallInfo,
    output: ToolOutput,
    context: ToolContext,
  ): Promise<ToolOutput | undefined>
}

export type HookName = keyof Hooks

/**
 * Everything a plugin can contribute. All fields are optional and combinable:
 * one plugin may add a tool, a provider and a hook at once.
 */
/**
 * Where the price of a model comes from.
 *
 * A capability of its own because it belongs to neither side: a provider
 * should not have to know what it costs to talk to, and the interface should
 * not have to know which services publish a price list and which do not. One
 * of these answers for a service, or says it cannot.
 */
export type PriceSource = {
  id: string
  /** Whether this source knows anything about that service. */
  covers(providerId: string): boolean
  /**
   * Dollars per input and output token, by model.
   *
   * An empty table is a real answer: plenty of services publish no prices, and
   * inventing one would put a number nobody can check on the screen.
   */
  load(providerId: string, config: unknown): Promise<Record<string, ModelPrice>>
}

export type ModelPrice = {
  input: number
  output: number
  /** Where the figure came from, so a surprising bill can be traced. */
  from: string
}

/**
 * A run of text with a look, which is all a plugin may draw.
 *
 * Deliberately not a component and deliberately not a panel. A plugin that
 * returns text cannot break the frame, cannot hold up a redraw, and cannot
 * argue with another plugin about how wide it is — and the layout stays with
 * the thing that knows how much room there is.
 *
 * Colours are whatever the interface understands, which today is a hex string.
 * The theme is handed over in the context, so a plugin can use the colours the
 * user chose rather than inventing its own and clashing with every skin.
 */
export type UiSegment = {
  text: string
  color?: string
  bold?: boolean
  background?: string
}

/** Where a plugin may add something. */
export type UiSlot =
  /** The bar along the bottom, beside the wordmark. */
  | 'tray'
  /** One agent's tab, after its name and what it costs. */
  | 'agent'

export type UiContext = {
  slot: UiSlot
  /** Present for the `agent` slot: whose tab this is. */
  agent?: AgentSnapshot
  /** Every agent on the team, for a slot that summarises. */
  agents: AgentSnapshot[]
  /** The agent being addressed. */
  target: string
  /** The colours in use, so an addition matches the skin rather than fights it. */
  theme: Record<string, string>
  /** Where the work is. */
  cwd: string
}

/**
 * Something a plugin adds to the interface.
 *
 * Called while a frame is being built, so it must not do any work worth
 * waiting for: read what you need elsewhere, keep it, and return it here.
 * Anything thrown is caught and the slot is drawn without it, because a
 * plugin with a bug should cost its own line and not the whole screen.
 */
export type UiExtension = {
  render(context: UiContext): UiSegment[] | undefined
}

export type Plugin = {
  name: string
  version?: string
  /**
   * The plugin contract this was written against.
   *
   * Stamped by `definePlugin` from the SDK's own constant, so an author never
   * types it and it cannot go stale. A host that does not understand the
   * number refuses the plugin and says both, rather than loading something
   * that will fail later in a more confusing place.
   */
  contract?: number
  tools?: Tool[]
  providers?: ProviderDefinition[]
  /** Where the price of a model comes from. */
  prices?: PriceSource[]
  /** Readers for instruction, skill and agent files in a given format. */
  loaders?: Loader[]
  hooks?: Hooks
  /** Additions to the interface — see `UiExtension`. */
  ui?: UiExtension
  /**
   * Builds the capabilities that need to know something first.
   *
   * Called once, after the module is imported and before the plugin is
   * registered. What it returns is merged over what the plugin declared
   * statically, and is checked by the same validator.
   *
   * This exists because the most interesting plugins this project ships could
   * not be written by a stranger. A permission guard needs to ask a person; a
   * plugin for somebody's issue tracker needs a token; both need to know
   * where the work is. Inside this repository those arrived as arguments to a
   * factory that only a file in this repository could call — which is the
   * ceiling between a plugin you write for yourself and one strangers
   * install. Now they arrive here.
   */
  setup?(host: PluginHost): PluginCapabilities | void | Promise<PluginCapabilities | void>
}

/** What a plugin may contribute; `Plugin` minus its identity. */
export type PluginCapabilities = Omit<
  Plugin,
  'name' | 'version' | 'contract' | 'description' | 'setup'
>

/**
 * What a plugin is handed when it is set up.
 *
 * Deliberately small. Everything here is something a plugin cannot work out
 * for itself and cannot be given any other way — not a door into the harness.
 */
export type PluginHost = {
  /** The project being worked on. */
  cwd: string
  /** Where this user's own files live: settings, plugins, session records. */
  home: string
  /**
   * This plugin's own settings, from `[plugins.<name>]` in the project config.
   *
   * Unvalidated on purpose: the core carries no validator, and the plugin
   * knows what it wants. Parse it in `setup` with a schema of your own and
   * throw if it is wrong — a throw from `setup` is reported as a plugin that
   * did not load, in the author's own words, which is the whole point of
   * doing the checking there rather than here.
   *
   * Only this plugin's table is passed. A plugin reading another's settings
   * would be a plugin reading another's tokens.
   */
  config: unknown
  /**
   * Asks the person at the keyboard a yes-or-no question.
   *
   * Absent when nobody is watching — a headless run — which is itself an
   * answer: an unattended session agrees to nothing it was not already told.
   */
  ask?(question: { title: string; detail?: string }): Promise<boolean>
  /** Says something in the session, for a plugin with news rather than a question. */
  say?(text: string): void
  /**
   * A directory this plugin may keep files in, made when first asked for.
   *
   * Its own, under the user's directory rather than the project's: a cache
   * keyed to a plugin should not turn up in somebody's diff.
   */
  stateDir(): Promise<string>
  /** Cancelled when the session ends, for a plugin that starts something. */
  signal: AbortSignal
}
