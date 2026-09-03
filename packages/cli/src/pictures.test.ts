import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { clipboardPicture } from './clipboard.ts'
import { isProblem, picturePaths, readPicture, sniff, withoutPaths } from './pictures.ts'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13])
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10])
const WEBP = Buffer.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-pic-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('what a file really is', () => {
  test('recognises the formats models can see', () => {
    expect(sniff(PNG)).toBe('image/png')
    expect(sniff(JPEG)).toBe('image/jpeg')
    expect(sniff(WEBP)).toBe('image/webp')
    expect(sniff(Buffer.from('GIF89a'))).toBe('image/gif')
  })

  test('is not fooled by the name', () => {
    // A screenshot saved as .jpg that is really a PNG is ordinary, and a
    // provider told the wrong type rejects the whole message.
    const path = join(root, 'shot.jpg')
    writeFileSync(path, PNG)

    const picture = readPicture(path)
    expect(isProblem(picture)).toBe(false)
    expect(isProblem(picture) ? '' : picture.mediaType).toBe('image/png')
  })

  test('says nothing for something that is not a picture', () => {
    expect(sniff(Buffer.from('#!/bin/sh\n'))).toBeUndefined()
  })
})

describe('reading one off disk', () => {
  test('comes back as base64, which is what every model takes', () => {
    const path = join(root, 'a.png')
    writeFileSync(path, PNG)

    const picture = readPicture(path)
    expect(isProblem(picture) ? '' : picture.data).toBe(PNG.toString('base64'))
  })

  test('explains a path that is not there rather than throwing', () => {
    // This runs on something somebody typed. A mistyped path should be a
    // sentence in the transcript, not the end of the session.
    const problem = readPicture(join(root, 'nope.png'))

    expect(isProblem(problem) && problem.because).toMatch(/no file/)
  })

  test('explains a file that is not a picture', () => {
    const path = join(root, 'notes.png')
    writeFileSync(path, 'just text')

    expect(isProblem(readPicture(path))).toBe(true)
  })
})

describe('finding pictures in what was typed', () => {
  test('takes a path a terminal wrote when a file was dropped on it', () => {
    expect(picturePaths('look at /Users/me/Desktop/shot.png')).toEqual([
      '/Users/me/Desktop/shot.png',
    ])
  })

  test('unpicks a quoted path, which is how spaces survive', () => {
    expect(picturePaths(`what is '/Users/me/My Pictures/a b.png'`)).toEqual([
      '/Users/me/My Pictures/a b.png',
    ])
  })

  test('unpicks an escaped path, which is the other way terminals write it', () => {
    expect(picturePaths('see /Users/me/My\\ Pictures/a.png')).toEqual([
      '/Users/me/My Pictures/a.png',
    ])
  })

  test('takes several at once', () => {
    expect(picturePaths('compare a.png and b.jpg')).toEqual(['a.png', 'b.jpg'])
  })

  test('leaves ordinary words alone', () => {
    expect(picturePaths('run the tests and fix src/app.ts')).toEqual([])
  })

  test('leaves the sentence readable once the paths are taken out', () => {
    const text = 'what is wrong with /tmp/shot.png here'

    expect(withoutPaths(text, picturePaths(text))).toBe('what is wrong with here')
  })
})

describe('the clipboard', () => {
  test('decodes what AppleScript hands back', async () => {
    // macOS keeps the clipboard behind AppleScript, which returns hex.
    const hex = PNG.toString('hex').toUpperCase()
    const picture = await clipboardPicture('darwin', async () =>
      new TextEncoder().encode(`«data PNGf${hex}»\n`),
    )

    expect(picture?.mediaType).toBe('image/png')
    expect(picture?.data).toBe(PNG.toString('base64'))
    expect(picture?.from).toBe('the clipboard')
  })

  test('says nothing when the clipboard holds text', async () => {
    const picture = await clipboardPicture('darwin', async () =>
      new TextEncoder().encode('some words someone copied'),
    )

    expect(picture).toBeUndefined()
  })

  test('says nothing when there is no way to ask', async () => {
    expect(await clipboardPicture('linux', async () => undefined)).toBeUndefined()
  })
})
