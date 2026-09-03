/**
 * Questions put to a person, one at a time.
 *
 * The screen holds one question. Two agents running `bash` in the same second
 * both asked, the second replaced the first, and the first agent's promise was
 * never answered: its turn sat at "working" for the rest of the session with
 * no mark on its tab and nothing to press. So a question waits for the one
 * before it to be answered — refused counts as answered — and is then asked.
 */
export function oneAtATime(): <T>(ask: () => Promise<T>) => Promise<T> {
  let last: Promise<unknown> = Promise.resolve()
  return <T>(ask: () => Promise<T>): Promise<T> => {
    const turn = last.then(ask, ask)
    last = turn.catch(() => undefined)
    return turn
  }
}
