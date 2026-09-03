import { ProviderProtocolError } from './errors.ts'
import type { AssistantTurn, ContentBlock, StopReason, StreamDelta, Usage } from './types.ts'

/**
 * Blocks under construction. Tool inputs are kept as raw JSON text until the
 * call closes, because providers slice that JSON at arbitrary offsets and no
 * prefix of it is parseable on its own.
 */
type PendingBlock =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool'; id: string; name: string; raw: string; input?: unknown }

/**
 * Reassembles a provider's delta stream into one assistant turn.
 *
 * This is the only place that tracks partial state, which is what lets a
 * provider plugin stay a pure translation of its wire format.
 */
export async function accumulate(deltas: AsyncIterable<StreamDelta>): Promise<AssistantTurn> {
  const blocks: PendingBlock[] = []
  const toolIndex = new Map<string, number>()
  let finished: { stopReason: StopReason; usage: Usage } | undefined

  const appendText = (kind: 'text' | 'thinking', text: string): void => {
    const last = blocks.at(-1)
    if (last?.kind === kind) {
      last.text += text
      return
    }
    blocks.push({ kind, text })
  }

  const pendingTool = (id: string): Extract<PendingBlock, { kind: 'tool' }> => {
    const index = toolIndex.get(id)
    const block = index === undefined ? undefined : blocks[index]
    if (block?.kind !== 'tool') {
      throw new ProviderProtocolError(`received a tool fragment for unknown tool call ${id}`, {
        toolUseId: id,
      })
    }
    return block
  }

  const closeTool = (
    block: Extract<PendingBlock, { kind: 'tool' }>,
    stopReason: StopReason,
  ): void => {
    if (block.input !== undefined) return
    // An absent input is how providers spell "no arguments"; an unparseable
    // one is a real failure and must not be guessed at, because the guess
    // would be handed to a tool that can touch the filesystem.
    if (block.raw.trim() === '') {
      block.input = {}
      return
    }
    try {
      block.input = JSON.parse(block.raw)
    } catch (cause) {
      // Unless the model was cut off while writing it. A turn stopped by the
      // output cap ends wherever it ends, and the middle of a call's JSON is
      // an ordinary place for that to be — an agent writing a file is
      // writing most of its output into one argument. The loop reports such
      // a turn as cut short and names the call that never ran, which it can
      // only do if the call is here to be named; rejected here instead, the
      // turn was a protocol error, the text before the call was lost, and
      // the screen said "arguments that are not valid JSON" about a model
      // that had simply run out of room. Kept with no arguments: nothing
      // runs a call from a turn that did not ask for tools, so there is no
      // guess to hand anywhere. Only a call the model says is complete and
      // is not is the provider speaking the protocol wrongly.
      if (stopReason !== 'tool_use') {
        block.input = {}
        return
      }
      throw new ProviderProtocolError(
        `tool call ${block.id} (${block.name}) sent arguments that are not valid JSON`,
        { toolUseId: block.id },
        { cause },
      )
    }
  }

  for await (const delta of deltas) {
    switch (delta.type) {
      case 'text_delta':
        appendText('text', delta.text)
        break
      case 'thinking_delta':
        appendText('thinking', delta.text)
        break
      case 'tool_use_start':
        toolIndex.set(delta.id, blocks.length)
        blocks.push({ kind: 'tool', id: delta.id, name: delta.name, raw: '' })
        break
      case 'tool_use_delta':
        pendingTool(delta.id).raw += delta.partialInput
        break
      case 'tool_use_end':
        // Checked, not closed: whether a half-written input is a protocol
        // error depends on why the turn stopped, and `done` is still to come.
        pendingTool(delta.id)
        break
      case 'done':
        finished = { stopReason: delta.stopReason, usage: delta.usage }
        break
    }
  }

  if (!finished) {
    throw new ProviderProtocolError('stream ended without a done delta')
  }

  // Every call is closed here, whether or not the provider closed it: some
  // stop streaming without a `tool_use_end`, and the rest were left open on
  // purpose until the stop reason was known.
  for (const block of blocks) {
    if (block.kind === 'tool') closeTool(block, finished.stopReason)
  }

  return {
    content: blocks.map(toContentBlock),
    stopReason: finished.stopReason,
    usage: finished.usage,
  }
}

function toContentBlock(block: PendingBlock): ContentBlock {
  switch (block.kind) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return { type: 'thinking', text: block.text }
    case 'tool':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
  }
}
