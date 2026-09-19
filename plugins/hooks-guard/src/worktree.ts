/**
 * Reading a path that came from inside an agent's checkout.
 *
 * Every agent works in `<repo>/.aidcrew/wt/<task>`, and the journal of
 * changes lives with the repository — so a change to `src/rates.ts` is
 * recorded as `.aidcrew/wt/rates/src/rates.ts`. Two agents editing the same
 * file are two different paths, which is exactly the thing anybody looking at
 * this wants told apart from two agents editing two files.
 */

/** `.aidcrew/wt/<task>/<file>`, in either separator a machine might have used. */
const INSIDE = /^\.aidcrew[\\/]wt[\\/]([^\\/]+)[\\/](.+)$/

/** The file a path names, with the checkout it was reached through taken off. */
export function fileOf(path: string): string {
  const inside = INSIDE.exec(path)
  return (inside?.[2] ?? path).replace(/\\/g, '/')
}

/** The job whose checkout a path is in, or nothing when it is the repository. */
export function taskOf(path: string): string | undefined {
  return INSIDE.exec(path)?.[1]
}
