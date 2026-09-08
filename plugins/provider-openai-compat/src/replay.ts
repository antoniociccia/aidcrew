import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CanonicalRequest, Provider, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import { buildRequestBody } from './request.ts'
import { parseOpenAiStream } from './stream.ts'

/**
 * A provider that answers from a trace instead of a service.
 *
 * `AIDCREW_TRACE_DIR` writes every request and the raw stream that answered
 * it. This reads them back: a request whose model and messages match a
 * recorded one gets the recorded stream, byte for byte, through the same
 * parser a live answer goes through. A failure nobody can replay is a
 * failure nobody can fix; with this, a run that broke is a test that runs in
 * a moment, with no key and no bill — and a stream that once broke the
 * parser is kept as the thing the parser is checked against.
 *
 * Only what was recorded is answered. A request the trace never saw is an
 * error naming the directory, never a guess: a replay that improvised would
 * be a test of nothing.
 */
export type ReplayConfig = {
  /** The directory `AIDCREW_TRACE_DIR` wrote into. */
  dir: string
}

type Trace = { name: string; request: { model?: string; messages?: unknown }; sse: string }

/** Every recorded request in the directory, oldest first, with its answer. */
function tracesIn(dir: string): Trace[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith('.request.json'))
    .sort()
    .flatMap((name) => {
      const stem = name.slice(0, -'.request.json'.length)
      const answer = join(dir, `${stem}.response.sse`)
      if (!existsSync(answer)) return []
      try {
        return [
          {
            name: stem,
            request: JSON.parse(readFileSync(join(dir, name), 'utf8')) as Trace['request'],
            sse: readFileSync(answer, 'utf8'),
          },
        ]
      } catch {
        return []
      }
    })
}

async function* bytesOf(text: string): AsyncIterable<Uint8Array> {
  yield new TextEncoder().encode(text)
}

export function createReplayProvider(config: ReplayConfig): Provider {
  const id = 'replay'
  // Each trace answers once, so a turn asked twice in a run — the same
  // question after a tool result — gets the second recording, not the first
  // again.
  const used = new Set<string>()

  return {
    id,
    async *send(request: CanonicalRequest): AsyncIterable<StreamDelta> {
      const wanted = buildRequestBody(request)
      const messages = JSON.stringify(wanted.messages)
      const traces = tracesIn(config.dir)
      const match =
        traces.find(
          (trace) =>
            !used.has(trace.name) &&
            trace.request.model === wanted.model &&
            JSON.stringify(trace.request.messages) === messages,
        ) ?? traces.find((trace) => !used.has(trace.name) && trace.request.model === wanted.model)
      if (!match) {
        throw new ProviderResponseError(
          `${id}: no recorded answer for ${wanted.model} in ${config.dir} (${traces.length} traces, ${used.size} used)`,
          id,
          false,
        )
      }
      used.add(match.name)
      yield* parseOpenAiStream(bytesOf(match.sse), id)
    },
  }
}
