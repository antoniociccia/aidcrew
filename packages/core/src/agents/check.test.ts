import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detectCheck, runCheck } from './check.ts'

let dir: string
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function project(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), 'aidcrew-check-'))
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text)
  return dir
}

describe('the check a project is proved by', () => {
  // Nobody should have to say `bun test` to a harness that can see the
  // package.json. What is declared wins; what is not declared is read off
  // the files every ecosystem leaves behind.
  test('is bun test where bun is plainly in use', () => {
    expect(
      detectCheck(project({ 'package.json': '{"scripts":{"test":"bun test"}}', 'bun.lock': '' })),
    ).toBe('bun test')
  })

  test('is npm test for a package with a test script and no sign of bun', () => {
    expect(detectCheck(project({ 'package.json': '{"scripts":{"test":"vitest"}}' }))).toBe(
      'npm test',
    )
  })

  test('is nothing for a package without a test script', () => {
    expect(detectCheck(project({ 'package.json': '{"name":"x"}' }))).toBeUndefined()
  })

  test('knows pytest, go and cargo by their files', () => {
    expect(detectCheck(project({ 'pyproject.toml': '' }))).toBe('pytest -q')
    expect(detectCheck(project({ 'go.mod': 'module x' }))).toBe('go test ./...')
    expect(detectCheck(project({ 'Cargo.toml': '' }))).toBe('cargo test')
  })

  test('is nothing where nothing is recognised', () => {
    expect(detectCheck(project({ 'README.md': '# hi' }))).toBeUndefined()
  })
})

describe('running the check', () => {
  test('passes on exit 0 and keeps what was printed', async () => {
    const verdict = await runCheck('echo all good', project({}))

    expect(verdict.passed).toBe(true)
    expect(verdict.output).toContain('all good')
  })

  test('fails on any other exit, with the code and the last of the output', async () => {
    const verdict = await runCheck('echo boom >&2; exit 3', project({}))

    expect(verdict.passed).toBe(false)
    expect(verdict.code).toBe(3)
    expect(verdict.output).toContain('boom')
  })

  test('keeps only the tail of a long output, which is where the failure is', async () => {
    const verdict = await runCheck(
      'for i in $(seq 1 500); do echo line $i; done; exit 1',
      project({}),
    )

    expect(verdict.output).toContain('line 500')
    expect(verdict.output).not.toContain('line 1\n')
  })
})
