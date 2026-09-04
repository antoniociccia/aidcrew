/**
 * Everything a plugin needs, from one package.
 *
 * A plugin author should never have to work out which of two packages a name
 * lives in. What the host itself throws, accumulates and streams with is
 * re-exported here, so `import { ... } from '@aidcrew/plugin-sdk'` is the
 * whole contract — and so the bundled plugins, which are the proof that the
 * contract is enough, can be written the same way a stranger's would be.
 */

// The canonical model every provider translates into, and the shapes of the
// other five capabilities. Types only: they cost nothing at run time.
export type {
  AgentDef,
  AgentSnapshot,
  ContentBlock,
  Hooks,
  Loader,
  Message,
  ModelPrice,
  Plugin,
  PluginCapabilities,
  PluginHost,
  PriceSource,
  ProtocolErrorDetail,
  Provider,
  ProviderDefinition,
  StopReason,
  StreamDelta,
  Tool,
  ToolCallInfo,
  ToolContext,
  ToolOutput,
  TurnContext,
  UiContext,
  UiExtension,
  UiSegment,
  UiSlot,
  Usage,
} from '@aidcrew/core'
// What the host throws, so a provider's failures are told apart from a bug in
// the harness rather than being another anonymous Error.
// Turning a stream of deltas back into messages, which anything that keeps
// its own conversation needs and nobody should write twice.
export {
  accumulate,
  keepStateOutOfGit,
  ProviderProtocolError,
  ProviderResponseError,
} from '@aidcrew/core'
export type { ProviderSpec } from './define-plugin.ts'
export { definePlugin, defineProvider } from './define-plugin.ts'
export type { PriceSpec, UiSpec } from './define-rest.ts'
export { defineHooks, defineLoader, definePrices, defineUi } from './define-rest.ts'
export type { ToolSpec } from './define-tool.ts'
export { defineTool } from './define-tool.ts'
// The shortlist for a model name that does not exist, for every dialect's
// "no such model" error.
export { nearest } from './nearest.ts'
export { withPromptedTools } from './prompted-tools.ts'
// What a service says about its limits — when to come back, and how much of
// an allowance is left — read the same way by every HTTP provider.
export { meterWindow, RetryAfterError, retryAfterMs } from './rate-limit.ts'
export { retrying } from './retrying.ts'
export { parseSse } from './sse.ts'
// The clock on a request, so a service that stops talking is given up on.
export type { StallTimeouts, StallWatch } from './stall.ts'
export { DEFAULT_STALL_TIMEOUTS, watchForStall } from './stall.ts'
