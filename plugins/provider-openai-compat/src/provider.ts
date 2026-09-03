import type { CanonicalRequest, Provider, StreamDelta } from '@aidcrew/core'
import { ProviderResponseError } from '@aidcrew/core'
import type { StallTimeouts, StallWatch } from '@aidcrew/plugin-sdk'
import { RetryAfterError, retryAfterMs, watchForStall } from '@aidcrew/plugin-sdk'
import { explain, truncate } from './body.ts'
import { meterFromHeaders } from './headers.ts'
import { listOpenAiModels, nearest } from './models.ts'
import { buildRequestBody } from './request.ts'
import { buildResponsesBody, parseResponsesStream } from './responses.ts'
import { parseOpenAiStream } from './stream.ts'

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>

/**
 * Which of OpenAI's two dialects to speak.
 *
 * `auto` sends chat completions and retries once on /responses when the first
 * call fails for a reason a different endpoint could fix. This is not
 * hypothetical: OpenCode Go serves `muse-spark-1.2-contributor`, `grok-4.6`
 * and `gpt-5.6-luna` only on /responses, and answers for them at
 * /chat/completions with a bare 500 — nothing in the error, and nothing in
 * the model catalogue, says the address is the problem. Only trying tells you.
 */
export type Dialect = 'chat' | 'responses' | 'auto'

export type OpenAiCompatConfig = {
  /** How this provider is referred to in config and in agent definitions. */
  id: string
  /** Base URL up to and including the version segment, e.g. `.../v1`. */
  baseUrl: string
  apiKey: string
  /** Extra headers some gateways require (OpenRouter's attribution, and such). */
  headers?: Record<string, string>
  /** Injected in tests; production uses the platform fetch. */
  fetchImpl?: FetchImpl
  dialect?: Dialect
  /** How long a service may go without sending a byte before it is given up on. */
  timeouts?: Partial<StallTimeouts>
}

/** Statuses where sending the very same request again can succeed. */
const RETRYABLE_STATUSES = new Set([408, 409, 429, 500, 502, 503, 504])

/** A request the service answered, with the clock still running on its body. */
type Sent = { response: Response; watch: StallWatch }

/** A request the service refused, and what the refusal was about. */
type Refused = { failure: ProviderResponseError; worthRetrying: boolean; aboutTheCaller: boolean }

/**
 * A provider for any endpoint that speaks the OpenAI chat-completions dialect
 * — which is most of them: OpenCode Zen and Go, OpenRouter, DeepSeek, GLM,
 * Ollama, vLLM. One adapter, many models.
 *
 * All it does is bolt together the two translations that live next door and
 * put an HTTP call between them. There is no agent logic here, and there is no
 * knowledge of this wire format anywhere else.
 */
export function createOpenAiCompatProvider(config: OpenAiCompatConfig): Provider {
  const base = config.baseUrl.replace(/\/+$/, '')
  const doFetch = config.fetchImpl ?? ((url, init) => fetch(url, init))
  const dialect = config.dialect ?? 'auto'

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    ...config.headers,
  }

  async function post(
    path: string,
    body: unknown,
    model: string,
    signal: AbortSignal,
  ): Promise<Sent | Refused> {
    const url = `${base}${path}`
    // The clock starts with the request, not with the body: a service that
    // never sends its headers is the stall that held a turn for twenty-three
    // minutes, and it is the one a body-only clock could never see.
    const watch = watchForStall({
      provider: config.id,
      model,
      signal,
      ...(config.timeouts ? { timeouts: config.timeouts } : {}),
    })

    let response: Response
    try {
      response = await doFetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: watch.signal,
      })
    } catch (cause) {
      watch.release()
      const failure = watch.failure(cause)
      // A cancellation is the caller's own doing and is handed back as it
      // came; a stall is the clock's own report; everything else here is a
      // service that could not be reached.
      if (signal.aborted || failure instanceof ProviderResponseError) throw failure
      throw networkFailure('could not reach', url, cause)
    }

    if (response.ok) return { response, watch }

    // The body is read because gateways explain the real cause there, but
    // never the request: it carries the key and the whole transcript.
    const text = await response.text().catch(() => '')
    watch.release()
    const complaint = explain(text)
    const message = complaint
      ? `${config.id}: ${complaint}`
      : `${config.id} returned ${response.status} ${response.statusText}: ${truncate(text)}`
    const retryable = RETRYABLE_STATUSES.has(response.status) && !isOutOfCredit(text)
    const wait = retryAfterMs(response.headers)

    return {
      // With the wait the service asked for, when it named one: the retry
      // honours that rather than its own guess, so a rate limit is waited
      // out once instead of being walked into three times.
      failure:
        retryable && wait !== undefined
          ? new RetryAfterError(message, config.id, wait)
          : new ProviderResponseError(message, config.id, retryable),
      worthRetrying:
        response.status !== 429 && !ABOUT_THE_CALLER.test(text) && !ABOUT_THE_SERVICE.test(text),
      // Kept apart from `worthRetrying`, which is also false for an outage:
      // an outage is exactly when the catalogue is worth asking for, and a
      // rejected key is exactly when it is not — the same key would be
      // rejected there, and a second refusal on top of the first explains
      // nothing.
      aboutTheCaller: ABOUT_THE_CALLER.test(text),
    }
  }

  /**
   * A failure below HTTP: nothing was refused, because nobody answered.
   *
   * Ollama not running is the commonest failure a new user meets, and what
   * they saw was `TypeError: fetch failed` — no provider, no address, no
   * reason — and no retry, because it was not the error the retry reads. It
   * is retryable: a service that is not there now is the one kind of failure
   * where waiting a moment and asking again is the right response.
   */
  function networkFailure(what: string, url: string, cause: unknown): ProviderResponseError {
    return new ProviderResponseError(
      `${config.id}: ${what} ${url}: ${describe(cause)}`,
      config.id,
      true,
    )
  }

  function bodyOf(sent: Sent, path: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    if (!sent.response.body) {
      sent.watch.release()
      throw new ProviderResponseError(`${config.id} returned no body`, config.id, true)
    }
    return guarded(sent, `${base}${path}`, signal)
  }

  /**
   * The body, with the connection dropping under it reported as what it was,
   * and a service that stops talking reported as that rather than as a drop.
   */
  async function* guarded(sent: Sent, url: string, signal: AbortSignal): AsyncIterable<Uint8Array> {
    const { watch } = sent
    try {
      for await (const chunk of watch.body(sent.response.body as ReadableStream<Uint8Array>)) {
        yield chunk
      }
    } catch (cause) {
      const failure = watch.failure(cause)
      if (signal.aborted || failure instanceof ProviderResponseError) throw failure
      throw networkFailure('lost the connection to', url, cause)
    } finally {
      watch.release()
    }
  }

  /**
   * What the headers say is left of the allowance, before the answer.
   *
   * Before rather than after, because a stream that fails halfway still had
   * headers, and the meter is the one thing worth keeping from it. It is not
   * part of the answer, and the retry wrapper knows not to count it as one.
   */
  function* announce(response: Response): Generator<StreamDelta> {
    const windows = meterFromHeaders(response.headers)
    if (windows.length > 0) yield { type: 'meter', providerId: config.id, windows }
  }

  /**
   * Models learned to live on /responses. Kept per provider instance so the
   * cost of finding out is paid once per session, not once per turn.
   */
  const speaksResponses = new Set<string>()

  /**
   * What this endpoint says it has, fetched at most once and only after
   * something has already gone wrong.
   *
   * Never on the way in: that would put a round trip in front of every
   * session to catch a mistake most people do not make. The promise rather
   * than the value, so six agents failing at once ask once.
   */
  let catalogue: Promise<string[] | undefined> | undefined

  async function listModels(signal: AbortSignal): Promise<string[] | undefined> {
    try {
      const found = await listOpenAiModels(
        { baseUrl: base, apiKey: config.apiKey, fetchImpl: doFetch },
        signal,
      )
      return found.length > 0 ? found : undefined
    } catch {
      // An endpoint with no catalogue is normal, and a failure to read one is
      // never worth reporting: the caller already has a real error to show.
      return undefined
    }
  }

  /**
   * Replaces an error about the network with one about the config, when the
   * catalogue proves the model was never there.
   *
   * The gateway that prompted this answers `Endpoint is unavailable` for a
   * model it has never had, so a name with a typo in it reads as an outage —
   * and gets waited out instead of fixed, on every turn of every agent.
   */
  async function sharpen(
    failure: ProviderResponseError,
    model: string,
    signal: AbortSignal,
  ): Promise<ProviderResponseError> {
    catalogue ??= listModels(signal)
    const known = await catalogue
    if (!known || known.includes(model)) return failure

    const close = nearest(model, known)
    return new ProviderResponseError(
      `${config.id} has no model called "${model}" (it offers ${known.length}). ` +
        (close.length > 0
          ? `Closest: ${close.join(', ')}.`
          : 'None of its names are close to that one.') +
        ` The endpoint itself answered: ${failure.message}`,
      config.id,
      // A name that is not there will not be there next time either, and three
      // retries only postpone the same message.
      false,
    )
  }

  return {
    id: config.id,

    async *send(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<StreamDelta> {
      const preferResponses = dialect === 'responses' || speaksResponses.has(request.model)

      if (!preferResponses) {
        const chat = await post(
          '/chat/completions',
          buildRequestBody(request),
          request.model,
          signal,
        )
        if ('response' in chat) {
          yield* announce(chat.response)
          yield* parseOpenAiStream(bodyOf(chat, '/chat/completions', signal), config.id)
          return
        }

        // A second endpoint only helps when the first refusal was about the
        // request rather than about us: a bad key or a spent balance would
        // fail identically there, and asking again just costs a round trip.
        if (dialect !== 'auto' || !chat.worthRetrying) {
          throw chat.aboutTheCaller
            ? chat.failure
            : await sharpen(chat.failure, request.model, signal)
        }

        const responses = await post(
          '/responses',
          buildResponsesBody(request),
          request.model,
          signal,
        )
        if (!('response' in responses)) {
          // Both refused, so say both: reporting only the first hides the
          // reason the fallback did not work, which is the useful half.
          throw await sharpen(
            new ProviderResponseError(
              `${chat.failure.message} (and on /responses: ${responses.failure.message})`,
              config.id,
              // The first refusal decides, because it is the one about the
              // service: the fallback was only ever tried because the first
              // looked transient, and its own answer is usually "this model is
              // not supported here" — true, permanent, and about the endpoint we
              // are not using. Marking the pair final on that basis reported a
              // gateway that was briefly down as a configuration mistake, and
              // the retry that exists for exactly this never ran.
              chat.failure.retryable,
            ),
            request.model,
            signal,
          )
        }

        speaksResponses.add(request.model)
        yield* announce(responses.response)
        yield* parseResponsesStream(bodyOf(responses, '/responses', signal), config.id)
        return
      }

      const responses = await post('/responses', buildResponsesBody(request), request.model, signal)
      if (!('response' in responses)) {
        throw responses.aboutTheCaller
          ? responses.failure
          : await sharpen(responses.failure, request.model, signal)
      }
      yield* announce(responses.response)
      yield* parseResponsesStream(bodyOf(responses, '/responses', signal), config.id)
    },
  }
}

/**
 * A network failure as a person can act on it.
 *
 * Bun says "Unable to connect" and puts the code on the error itself; undici
 * says "fetch failed" and puts both the reason and the code one level down,
 * in `cause`. The code is the part a search turns up an answer for, so it is
 * shown wherever the runtime put it.
 */
function describe(failure: unknown): string {
  if (!(failure instanceof Error)) return String(failure)

  const reasons = [failure.message]
  if (failure.cause instanceof Error) reasons.push(failure.cause.message)

  const code = codeOf(failure) ?? codeOf(failure.cause)
  return code === undefined ? reasons.join(': ') : `${reasons.join(': ')} (${code})`
}

function codeOf(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof value.code === 'string'
    ? value.code
    : undefined
}

/**
 * Refusals about the caller rather than about the request, which the other
 * endpoint would repeat word for word.
 *
 * The status cannot decide this. OpenCode Go answers 401 both to a bad key
 * ("Invalid API key.") and to a model this endpoint does not serve ("Model
 * grok-4.6 is not supported for format oa-compat") — same status, opposite
 * meaning, and only the second is worth a second address.
 */
/**
 * Refusals that are about the service being unreachable rather than about the
 * request being wrong.
 *
 * The status code cannot carry this: OpenCode Go answers 500 for a model that
 * only lives on `/responses` and 401 for a model error, so on that gateway the
 * number says nothing and only the message tells the cases apart — which is
 * why the caller check next to this one reads the body too.
 *
 * Both endpoints are the same gateway, so when it is down the second path is a
 * round trip to the same outage. Worse, it usually answers "this model is not
 * supported for format openai" — true, permanent, and about the endpoint we
 * were never going to use — and that sentence ends up in the error a person
 * reads, naming the model as the culprit for an outage.
 */
const ABOUT_THE_SERVICE =
  /endpoint is unavailable|upstream request failed|service unavailable|bad gateway|temporarily unavailable|overloaded/i

const ABOUT_THE_CALLER =
  /invalid api key|unauthori[sz]ed|authentication|forbidden|permission|credit|insufficient balance|quota|billing/i

/** Recognises a spent balance across the wordings gateways use for it. */
function isOutOfCredit(body: string): boolean {
  return /credit|insufficient balance|quota|billing/i.test(body)
}
