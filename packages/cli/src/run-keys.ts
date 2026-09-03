/**
 * What your terminal actually sends when you press a key.
 *
 * Written because guessing twice was twice too many. A character that needs a
 * modifier — `@` on an Italian layout, `#` on a British one — reaches a
 * program differently depending on the terminal, its settings, and the
 * keyboard: as the character, as an escape followed by it, or as nothing at
 * all. No amount of reading fixes that. This prints what arrived.
 *
 *   aidcrew keys
 */

export type KeysIo = {
  write(text: string): void
}

export type Stdin = {
  isTTY?: boolean
  setRawMode?(on: boolean): void
  resume?(): void
  pause?(): void
  /**
   * Node types this as returning the stream and taking its own encoding
   * union, so the parameter stays wide rather than being narrowed to a
   * shape the real stdin does not satisfy.
   */
  // biome-ignore lint/suspicious/noExplicitAny: matching Node's own signature
  setEncoding?(encoding: any): unknown
  on(event: string, listener: (chunk: string) => void): void
  off(event: string, listener: (chunk: string) => void): void
}

/** How each byte is worth describing, for the ones that have a name. */
const NAMED: Record<string, string> = {
  '\u001b': 'escape',
  '\r': 'return',
  '\n': 'newline',
  '\t': 'tab',
  '\u007f': 'backspace',
  ' ': 'space',
}

/** One read, as something a person can compare with what they pressed. */
export function describe(chunk: string): string {
  const codes = [...chunk]
    .map((character) => {
      const point = character.codePointAt(0) ?? 0
      return point < 32 || point === 127 ? `\\x${point.toString(16).padStart(2, '0')}` : character
    })
    .join('')

  const names = [...chunk]
    .map((character) =>
      (NAMED[character] ?? (character.codePointAt(0) ?? 0) < 32)
        ? (NAMED[character] ?? `ctrl-${String.fromCodePoint((character.codePointAt(0) ?? 0) + 96)}`)
        : character,
    )
    .join(' ')

  const points = [...chunk]
    .map(
      (character) =>
        `U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}`,
    )
    .join(' ')

  return `  ${codes.padEnd(24)} ${names.padEnd(20)} ${points}`
}

export async function runKeys(io: KeysIo, stdin: Stdin): Promise<number> {
  if (!stdin.isTTY) {
    io.write('this needs a terminal: run it directly rather than through a pipe\n')
    return 1
  }

  io.write('Press keys to see what your terminal sends. Ctrl-C to stop.\n')
  io.write('Try the one you cannot type — @ on an Italian layout is option-ò.\n\n')
  io.write(`  ${'bytes'.padEnd(24)} ${'meaning'.padEnd(20)} codepoints\n`)

  stdin.setRawMode?.(true)
  stdin.setEncoding?.('utf8')
  stdin.resume?.()

  return await new Promise<number>((resolve) => {
    const onData = (chunk: string): void => {
      // Ctrl-C, which in raw mode is a byte like any other and has to be
      // noticed here or the only way out is another window.
      if (chunk === '\u0003') {
        stdin.off('data', onData)
        stdin.setRawMode?.(false)
        stdin.pause?.()
        io.write('\n')
        resolve(0)
        return
      }
      io.write(`${describe(chunk)}\n`)
    }

    stdin.on('data', onData)
  })
}
