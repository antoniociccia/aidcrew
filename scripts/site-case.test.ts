import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..')
test('the published case links a playable video, report and reproducible source', () => {
  const page = readFileSync(join(root, 'site/cases/skyforge-islands/index.html'), 'utf8')
  expect(page).toContain('<video')
  expect(page).toContain('session-report.json')
  expect(page).toContain('demos/aidcrew-blocks/source')
  expect(page).toContain('unfinished')
  expect(page).not.toContain('in progress')
  expect(statSync(join(root, 'site/media/skyforge-demo.mp4')).size).toBeLessThan(15_000_000)
  const report = JSON.parse(
    readFileSync(join(root, 'site/cases/skyforge-islands/session-report.json'), 'utf8'),
  )
  expect(report.agent_api_cost_usd).toBeCloseTo(4.951697555, 8)
  expect(report.status).toContain('cancelled')
})
