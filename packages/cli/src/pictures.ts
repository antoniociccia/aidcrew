import { readFileSync } from 'node:fs'
import type { ImageMediaType } from '@aidcrew/core'

/**
 * Getting a picture into the conversation.
 *
 * Two ways in, because a terminal offers two. A file dragged onto the window
 * arrives as its path typed into the prompt, which is how every terminal
 * handles a drop. A picture copied from a screenshot tool is on the system
 * clipboard, which no terminal will paste as bytes — it has to be asked for.
 */

export type Picture = {
  mediaType: ImageMediaType
  /** Base64, which is what every model that can see one accepts. */
  data: string
  /** Where it came from, for the line the transcript shows. */
  from: string
}

/**
 * What a file is, read from the front of it rather than from its name.
 *
 * Extensions lie — a screenshot saved as `.jpg` that is really a PNG is
 * ordinary — and a provider told the wrong type rejects the whole message
 * rather than the picture.
 */
export function sniff(bytes: Uint8Array): ImageMediaType | undefined {
  const starts = (...signature: number[]): boolean =>
    signature.every((byte, at) => bytes[at] === byte)

  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return 'image/png'
  if (starts(0xff, 0xd8, 0xff)) return 'image/jpeg'
  if (starts(0x47, 0x49, 0x46, 0x38)) return 'image/gif'
  // RIFF....WEBP — the size sits between the two halves of the signature.
  if (
    starts(0x52, 0x49, 0x46, 0x46) &&
    [0x57, 0x45, 0x42, 0x50].every((b, at) => bytes[8 + at] === b)
  ) {
    return 'image/webp'
  }

  return undefined
}

/** Bigger than this and a provider refuses the request rather than the file. */
export const TOO_BIG = 5 * 1024 * 1024

export type PictureProblem = { path: string; because: string }

/**
 * Reads a picture off disk, or says why it could not.
 *
 * A refusal is returned rather than thrown: this runs on something somebody
 * typed, and a mistyped path should be a sentence in the transcript rather
 * than the end of the session.
 */
export function readPicture(path: string): Picture | PictureProblem {
  let bytes: Buffer
  try {
    bytes = readFileSync(path)
  } catch {
    return { path, because: 'there is no file there' }
  }

  const mediaType = sniff(bytes)
  if (!mediaType) return { path, because: 'it is not a picture in a format models can see' }
  if (bytes.byteLength > TOO_BIG) {
    return {
      path,
      because: `it is ${Math.round(bytes.byteLength / 1024 / 1024)}MB, which is too big`,
    }
  }

  return { mediaType, data: bytes.toString('base64'), from: path }
}

/** True for the shape of a returned problem rather than a picture. */
export function isProblem(result: Picture | PictureProblem): result is PictureProblem {
  return 'because' in result
}

/**
 * Paths to pictures inside something typed.
 *
 * A terminal writes a dropped file as its path, quoted or with its spaces
 * escaped, so both are unpicked. Only paths that look like pictures are
 * considered — what they really are is decided by reading them.
 */
export function picturePaths(text: string): string[] {
  const looksLikeOne = /\.(png|jpe?g|gif|webp)$/i
  const found: string[] = []

  // Quoted first, so a quoted path containing spaces survives the split.
  const quoted = /'([^']+)'|"([^"]+)"/g
  let rest = text
  for (const match of text.matchAll(quoted)) {
    const path = match[1] ?? match[2] ?? ''
    if (looksLikeOne.test(path)) {
      found.push(path)
      rest = rest.replace(match[0], ' ')
    }
  }

  for (const word of rest.split(/(?<!\\)\s+/)) {
    const path = word.replace(/\\ /g, ' ').trim()
    if (path !== '' && looksLikeOne.test(path)) found.push(path)
  }

  return found
}

/** What is left of the typed line once the paths are taken out of it. */
export function withoutPaths(text: string, paths: string[]): string {
  let rest = text
  for (const path of paths) {
    for (const form of [`'${path}'`, `"${path}"`, path.replace(/ /g, '\\ '), path]) {
      rest = rest.replace(form, '')
    }
  }
  return rest.replace(/\s+/g, ' ').trim()
}
