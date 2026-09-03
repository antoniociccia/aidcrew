import type { Decision } from '@aidcrew/cli'
import type { Answer } from './screens/session.tsx'

/**
 * The answers a question offers, which is not always the same three.
 *
 * A guard asking about a command has broader versions of yes — this folder,
 * anything like this — and they are worth offering because the alternative is
 * being asked again in four seconds. A plugin asking whether it may use a
 * token has none: it asks one thing, once, at one moment, and there is nothing
 * wider to allow.
 *
 * Offering one anyway put two keys on the prompt that did the same thing, one
 * of them labelled "yes" beside another labelled "once" — which is not a
 * choice, it is a thing to work out before you can answer.
 */
export function answersFor(
  scopes: { folder?: string; broad?: string },
  take: (decision: Decision) => () => void,
): Answer[] {
  return [
    { key: 'y', label: 'once', tone: 'ok', take: take('once') },
    // Each wider answer says what it would cover, in the words of the thing
    // itself. "always" with nothing after it is a leap, and the difference
    // between writes under src/ and writes anywhere is the whole decision.
    ...(scopes.folder
      ? [{ key: 'd', label: scopes.folder, tone: 'warn' as const, take: take('folder') }]
      : []),
    ...(scopes.broad
      ? [{ key: 'a', label: scopes.broad, tone: 'warn' as const, take: take('always') }]
      : []),
    { key: 'n', label: 'refuse', tone: 'bad', take: take('no') },
  ]
}
