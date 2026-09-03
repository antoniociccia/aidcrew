import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectTrustKey, runProject, trustedClaims } from './run-project.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'
import { loadWorkspaceConfig } from './workspace.ts'

let cwd: string
let home: string
let store: SettingsStore
let out: string[]
let errors: string[]

const io = () => ({
  write: (text: string) => out.push(text),
  writeError: (text: string) => errors.push(text),
})

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-projectcmd-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-projecthome-')))
  store = openStore(home)
  out = []
  errors = []
})

afterEach(() => {
  store.close()
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function config(toml: string): void {
  mkdirSync(join(cwd, '.aidcrew'), { recursive: true })
  writeFileSync(join(cwd, '.aidcrew', 'config.toml'), toml)
}

describe('what a project asks for that a clone does not get', () => {
  test('remembers one claim, for this project only', async () => {
    // Kept in the user's own store rather than in the project, because a
    // record kept in the project would let a repository ship its own
    // approval, which is the whole thing being guarded against.
    config('[agents.coder]\nyolo = true\n')

    expect(await runProject(['trust', 'agents.coder.yolo'], store, io(), cwd, home)).toBe(0)

    expect(store.get(projectTrustKey(cwd, 'agents.coder.yolo'))).toBe('allow')
    expect(trustedClaims(store, cwd)('agents.coder.yolo')).toBe(true)
    expect(trustedClaims(store, join(cwd, 'elsewhere'))('agents.coder.yolo')).toBe(false)
  })

  test('what it remembers is what the loader then honours', async () => {
    // The two halves have to agree, and the only way to be sure is to run
    // them against each other rather than to assert on the key twice.
    config('[agents.coder]\nyolo = true\n')
    await runProject(['trust', 'agents.coder.yolo'], store, io(), cwd, home)

    const loaded = await loadWorkspaceConfig({ cwd, home, trusted: trustedClaims(store, cwd) })

    expect(loaded.agents.coder?.yolo).toBe(true)
    expect(loaded.refused).toEqual([])
  })

  test('takes one back', async () => {
    config('[agents.coder]\nyolo = true\n')
    await runProject(['trust', 'agents.coder.yolo'], store, io(), cwd, home)

    expect(await runProject(['revoke', 'agents.coder.yolo'], store, io(), cwd, home)).toBe(0)

    expect(trustedClaims(store, cwd)('agents.coder.yolo')).toBe(false)
  })

  test('refuses a claim the config does not ask for', async () => {
    // A typo remembered forever sits in the list looking answered while the
    // thing it was meant to allow is still refused — and for a path, a near
    // miss is a different file.
    config('[agents.coder]\nyolo = true\n')

    expect(await runProject(['trust', 'agents.codr.yolo'], store, io(), cwd, home)).toBe(1)

    expect(errors.join('')).toContain('agents.coder.yolo')
    expect(store.get(projectTrustKey(cwd, 'agents.codr.yolo'))).toBeUndefined()
  })

  test('lists what the config asks for and whether it applies', async () => {
    config('[agents.coder]\nyolo = true\n\n[sources]\ninstructions = ["~/.aws/credentials"]\n')

    expect(await runProject([], store, io(), cwd, home)).toBe(0)

    const said = out.join('')
    expect(said).toContain('agents.coder.yolo')
    expect(said).toContain(`sources.instructions=${join(home, '.aws', 'credentials')}`)
    expect(said).toContain('not trusted')
  })

  test('says so plainly when a project asks for nothing', async () => {
    // The common case by far, and it must not read as an error.
    config('[agents.coder]\nmodel = "sonnet"\n')

    expect(await runProject([], store, io(), cwd, home)).toBe(0)

    expect(out.join('')).toContain('nothing a clone does not get')
    expect(errors).toEqual([])
  })

  test('a config it cannot read is a reason to stop, not to guess', async () => {
    config('this is not toml [[[\n')

    expect(await runProject([], store, io(), cwd, home)).toBe(1)

    expect(errors.join('')).toMatch(/not valid TOML/)
  })
})
