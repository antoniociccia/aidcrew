import type { LoopEvent, TeamEvent } from '@aidcrew/core'

export type RendererOptions = {
  write(text: string): void
  color: boolean
}

/** How much of a tool's result is worth showing; the model still gets all of it. */
const TOOL_PREVIEW_CHARS = 120

const ESC = String.fromCharCode(27)

/**
 * Prints a run to the terminal.
 *
 * The model's answer streams through verbatim; everything else is compressed
 * to one line, because a transcript that scrolls away is a transcript nobody
 * reads. Reasoning is never shown: it is the model talking to itself.
 */
export function createRenderer({ write, color }: RendererOptions) {
  const paint = (code: string, text: string) => (color ? `${ESC}[${code}m${text}${ESC}[0m` : text)

  let atLineStart = true

  const newlineIfNeeded = (): void => {
    if (!atLineStart) {
      write('\n')
      atLineStart = true
    }
  }

  return {
    handle(event: LoopEvent): void {
      switch (event.type) {
        case 'delta':
          if (event.delta.type === 'text_delta') {
            write(event.delta.text)
            atLineStart = event.delta.text.endsWith('\n')
          }
          break

        case 'tool_start':
          newlineIfNeeded()
          write(paint('2', `  ${event.name}(${summarise(event.input)})`))
          write('\n')
          break

        case 'tool_end':
          if (event.output.isError) {
            write(paint('31', `  error: ${preview(event.output.content)}`))
            write('\n')
          }
          break

        default:
          break
      }
    },

    finish(): void {
      newlineIfNeeded()
    },
  }
}

/** The first string argument is almost always the one that identifies the call. */
function summarise(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''

  const first = Object.values(input).find((value) => typeof value === 'string')
  return first === undefined ? '' : preview(first, 60)
}

function preview(text: string, max = TOOL_PREVIEW_CHARS): string {
  const oneLine = text.replaceAll('\n', ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine
}

/** Colours agents get, in order, so each keeps the same one all session. */
const AGENT_COLOURS = ['36', '35', '33', '32', '34', '31']

/**
 * Prints a team run: many agents, interleaved.
 *
 * Every line is prefixed with who it came from, because with four agents
 * working at once an unattributed line is noise. Agent answers are shown in
 * full; tool calls stay on one line, as in a single-agent run.
 */
export function createTeamRenderer({ write, color }: RendererOptions) {
  const colours = new Map<string, string>()
  const paint = (id: string, text: string) => {
    if (!color) return text
    const assigned =
      colours.get(id) ?? (AGENT_COLOURS[colours.size % AGENT_COLOURS.length] as string)
    colours.set(id, assigned)
    return `${ESC}[${assigned}m${text}${ESC}[0m`
  }

  const buffers = new Map<string, string>()

  const flush = (id: string): void => {
    const pending = buffers.get(id)?.trim()
    buffers.delete(id)
    if (pending) write(`${paint(id, `${id} ›`)} ${pending}\n`)
  }

  /** One agent's own activity: answer text buffered, tool calls one per line. */
  const showLoopEvent = (id: string, event: LoopEvent): void => {
    if (event.type === 'delta' && event.delta.type === 'text_delta') {
      buffers.set(id, (buffers.get(id) ?? '') + event.delta.text)
      return
    }
    if (event.type === 'tool_start') {
      flush(id)
      write(paint(id, `${id} ·`))
      write(` ${event.name}(${summarise(event.input)})\n`)
      return
    }
    if (event.type === 'tool_end' && event.output.isError) {
      write(paint(id, `${id} ·`))
      write(` error: ${preview(event.output.content)}\n`)
    }
  }

  return {
    handle(event: TeamEvent): void {
      if (event.type === 'agent_spawned') {
        write(paint(event.id, `+ ${event.id} on ${event.model}\n`))
        return
      }
      if (event.type === 'agent_event') {
        showLoopEvent(event.id, event.event)
        return
      }
      if (event.type === 'agent_message') {
        flush(event.from)
        write(paint(event.from, `${event.from} → ${event.to}`))
        write(` ${preview(event.text)}\n`)
        return
      }
      if (event.type === 'agent_failed') {
        flush(event.id)
        write(paint(event.id, `${event.id} ✕`))
        write(` ${event.reason}\n`)
        return
      }
      if (event.type === 'agent_blocked') {
        flush(event.id)
        write(paint(event.id, `${event.id} ✕`))
        write(` ${event.reason}\n`)
        return
      }
      // What the interface puts in a pane, printed here because a headless
      // run has no pane: why a turn stopped, and what became of the
      // checkout. A CI log that ends in silence is a log somebody reads
      // three times.
      if (event.type === 'agent_cut_short') {
        flush(event.id)
        write(paint(event.id, `${event.id} ✕`))
        write(` ${cutShortly(event.reason, event.tool)}\n`)
        return
      }
      if (event.type === 'agent_continued') {
        flush(event.id)
        write(paint(event.id, `${event.id} ·`))
        write(
          ` reached its turn limit with the work unfinished — sent back to carry on (${event.round} of ${event.of})\n`,
        )
        return
      }
      if (event.type === 'workspace_resumed') {
        write(paint(event.id, `${event.id} ·`))
        write(
          ` picked up the checkout for ${event.task} where the last run left it: ${event.changed} file${event.changed === 1 ? '' : 's'} changed and not committed\n`,
        )
        return
      }
      if (event.type === 'workspace_kept') {
        write(
          `kept the checkout for ${event.task}, at ${event.path}: the work in it is nowhere else\n`,
        )
        return
      }
      if (event.type === 'agent_status' && event.status === 'idle') {
        flush(event.id)
      }
    },

    finish(): void {
      for (const id of [...buffers.keys()]) flush(id)
    },
  }
}

/** Why a turn stopped instead of finishing, in the words the interface uses. */
function cutShortly(reason: string, tool?: string): string {
  if (reason === 'failed') return 'failed — the reason was printed above'
  if (reason === 'max_turns') return 'stopped after its turn limit without finishing'
  if (reason === 'refusal') return 'the model refused to carry on'
  const what = tool ? `the ${tool} it had started never ran` : 'it stopped mid-sentence'
  return `ran out of room before it finished — ${what}`
}
