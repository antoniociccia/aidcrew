import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keepStateOutOfGit, STATE_DIR } from './state-dir.ts'

let root: string
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('the runtime state under .aidcrew', () => {
  test('is kept out of git the first time the directory is made', () => {
    // `.aidcrew/` holds two kinds of thing: the config and the agents, which
    // are the point of committing it, and the runtime's own state — the
    // checkouts, the undo snapshots, the layout — which committed by accident
    // is a merge conflict at best and somebody's private file in a public
    // repository at worst. A fresh project got no ignore file at all, and
    // its first `git add .aidcrew` took eleven undo snapshots with it.
    root = mkdtempSync(join(tmpdir(), 'aidcrew-state-'))

    keepStateOutOfGit(root)

    const ignore = readFileSync(join(root, STATE_DIR, '.gitignore'), 'utf8')
    for (const entry of ['wt/', 'undo/', 'ui.json', 'history.db*']) {
      expect(ignore).toContain(entry)
    }
    expect(existsSync(join(root, STATE_DIR))).toBe(true)
  })

  test('leaves alone an ignore file somebody has edited', () => {
    // Written once and never touched again: a person who has changed it has
    // decided something, and this is not the place to argue.
    root = mkdtempSync(join(tmpdir(), 'aidcrew-state-'))
    keepStateOutOfGit(root)
    writeFileSync(join(root, STATE_DIR, '.gitignore'), 'mine\n')

    keepStateOutOfGit(root)

    expect(readFileSync(join(root, STATE_DIR, '.gitignore'), 'utf8')).toBe('mine\n')
  })
})
