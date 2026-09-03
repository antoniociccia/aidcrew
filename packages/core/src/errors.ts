/**
 * Every error the core raises is one of these, so callers can react to the
 * cause instead of matching on message text.
 */

export type ProtocolErrorDetail = {
  provider?: string
  toolUseId?: string
}

/** A provider produced a stream the canonical model cannot represent. */
export class ProviderProtocolError extends Error {
  override readonly name = 'ProviderProtocolError'

  constructor(
    message: string,
    readonly detail: ProtocolErrorDetail = {},
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

/** The provider itself reported a failure: rate limit, bad key, overload. */
export class ProviderResponseError extends Error {
  override readonly name = 'ProviderResponseError'

  constructor(
    message: string,
    readonly provider: string,
    /** Whether the same request could succeed if sent again. */
    readonly retryable: boolean,
  ) {
    super(message)
  }
}
