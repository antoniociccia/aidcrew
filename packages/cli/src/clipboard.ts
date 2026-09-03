import type { Picture } from './pictures.ts'
import { sniff } from './pictures.ts'

/**
 * The picture on the system clipboard, when there is one.
 *
 * No terminal pastes image data into stdin — pressing paste on a screenshot
 * types nothing at all — so the clipboard has to be asked for it directly, in
 * whatever way the operating system allows.
 *
 * Only asked when somebody presses the key for it. Reading the clipboard
 * unprompted would mean this program looking at whatever you last copied,
 * which is nobody's business but yours.
 */

export type Run = (command: string, args: string[]) => Promise<Uint8Array | undefined>

/** Shells out, and treats every failure as "there is no picture". */
const run: Run = async (command, args) => {
  try {
    const child = Bun.spawn([command, ...args], { stdout: 'pipe', stderr: 'ignore' })
    const bytes = new Uint8Array(await new Response(child.stdout).arrayBuffer())
    return (await child.exited) === 0 && bytes.byteLength > 0 ? bytes : undefined
  } catch {
    return undefined
  }
}

export async function clipboardPicture(
  platform: string = process.platform,
  exec: Run = run,
): Promise<Picture | undefined> {
  const bytes = platform === 'darwin' ? await fromMac(exec) : await fromLinux(exec)
  if (!bytes) return undefined

  const mediaType = sniff(bytes)
  if (!mediaType) return undefined

  return { mediaType, data: Buffer.from(bytes).toString('base64'), from: 'the clipboard' }
}

/**
 * macOS keeps the clipboard behind AppleScript, which hands back hex.
 *
 * `pngpaste` would be tidier and is not installed anywhere by default, so this
 * uses what every Mac already has.
 */
async function fromMac(exec: Run): Promise<Uint8Array | undefined> {
  const out = await exec('osascript', ['-e', 'the clipboard as «class PNGf»'])
  if (!out) return undefined

  // «data PNGf89504E47…» — the bytes are the hex between the marker and the
  // closing guillemet.
  const text = new TextDecoder().decode(out)
  const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(text)?.[1]
  if (!hex || hex.length % 2 !== 0) return undefined

  const bytes = new Uint8Array(hex.length / 2)
  for (let at = 0; at < bytes.length; at++) {
    bytes[at] = Number.parseInt(hex.slice(at * 2, at * 2 + 2), 16)
  }
  return bytes
}

/** Wayland first, then X11, because a Wayland session usually has both. */
async function fromLinux(exec: Run): Promise<Uint8Array | undefined> {
  return (
    (await exec('wl-paste', ['--type', 'image/png'])) ??
    (await exec('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-o']))
  )
}

/**
 * Puts text on the clipboard.
 *
 * The answer to a terminal that will not let you select: reporting the mouse
 * and selecting text are the same gesture, so one of them has to lose, and
 * copying what an agent said should not depend on winning that argument.
 *
 * Nothing is guessed about the platform beyond the command name, and a
 * machine without one is told plainly rather than left wondering whether it
 * worked.
 */
export async function copyToClipboard(
  text: string,
  spawn: (command: string, args: string[], input: string) => Promise<boolean> = write,
): Promise<boolean> {
  for (const [command, args] of COPIERS) {
    if (await spawn(command, args, text)) return true
  }
  return false
}

/**
 * The clipboard sequence a terminal itself understands.
 *
 * The fallback for a session over SSH, where `pbcopy` is on the wrong machine
 * — the commands above put the text on the clipboard of whatever is running
 * this program, which is not where the person's hands are. This asks the
 * terminal emulator to do it instead, and most of them will. Written to the
 * terminal by whoever is drawing it: this module never touches a stream, so
 * it cannot land in the middle of a frame.
 */
export function osc52(text: string): string {
  const esc = String.fromCharCode(27)
  return `${esc}]52;c;${Buffer.from(text, 'utf8').toString('base64')}${esc}\\`
}

/** In the order they are likely to exist, most specific first. */
const COPIERS: [string, string[]][] = [
  ['pbcopy', []],
  ['wl-copy', []],
  ['xclip', ['-selection', 'clipboard']],
  ['xsel', ['--clipboard', '--input']],
  ['clip.exe', []],
]

async function write(command: string, args: string[], input: string): Promise<boolean> {
  try {
    const child = Bun.spawn([command, ...args], {
      stdin: 'pipe',
      stdout: 'ignore',
      stderr: 'ignore',
    })
    child.stdin?.write(input)
    await child.stdin?.end()
    return (await child.exited) === 0
  } catch {
    return false
  }
}
