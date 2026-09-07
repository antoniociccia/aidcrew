import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { grade, materialise, tasksNamed } from './run.ts'

/**
 * Every task is proved before it is used to prove anything: as given, it
 * fails the hidden tests, and with the reference solution it passes them.
 * A task nobody can pass measures nothing; a task the unsolved project
 * already passes measures nothing either.
 */
const CATEGORIES = ['bugfix', 'feature', 'refactor', 'multi-file']

for (const task of tasksNamed()) {
  describe(task.name, () => {
    test('has an instruction and a category', () => {
      expect(task.instruction.length).toBeGreaterThan(80)
      expect(CATEGORIES).toContain(task.category)
    })

    test('as given, fails the hidden tests', async () => {
      const dir = mkdtempSync(join(tmpdir(), `aidcrew-bench-given-${task.name}-`))
      try {
        materialise(join(task.dir, 'project'), dir)
        expect(await grade(task, dir)).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 60_000)

    test('with the reference solution, passes them', async () => {
      const dir = mkdtempSync(join(tmpdir(), `aidcrew-bench-solved-${task.name}-`))
      try {
        materialise(join(task.dir, 'project'), dir)
        materialise(join(task.dir, 'solution'), dir)
        expect(await grade(task, dir)).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 60_000)
  })
}
