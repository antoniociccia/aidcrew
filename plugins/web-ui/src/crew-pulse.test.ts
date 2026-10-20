import { expect, test } from 'bun:test'
import { crewPulse } from './crew-pulse.ts'

const agent = (id: string, overrides = {}) => ({
  id,
  status: 'idle',
  queued: 0,
  behind: 0,
  ...overrides,
})

test('summarizes actual work without treating idle agents as completed jobs', () => {
  const result = crewPulse([
    agent('planner', { status: 'working', queued: 2 }),
    agent('coder'),
    agent('reviewer', { status: 'stopped', queued: 1 }),
  ])
  expect(result.working).toBe(1)
  expect(result.queued).toBe(3)
  expect(result.attention).toEqual([{ id: 'reviewer', reason: 'stopped' }])
})

test('prioritizes pending decisions and reports each agent only once', () => {
  expect(
    crewPulse(
      [
        agent('stopped', { status: 'stopped' }),
        agent('behind', { behind: 2 }),
        agent('approval', { status: 'working', behind: 3 }),
        agent('queued', { queued: 1 }),
      ],
      'approval',
    ).attention,
  ).toEqual([
    { id: 'approval', reason: 'decision' },
    { id: 'stopped', reason: 'stopped' },
    { id: 'queued', reason: 'queued' },
    { id: 'behind', reason: 'behind' },
  ])
})

test('ignores pending decisions for departed agents and updates when conditions clear', () => {
  expect(crewPulse([], 'departed')).toEqual({ working: 0, queued: 0, attention: [] })
  expect(crewPulse([agent('coder', { status: 'working', queued: 1 })]).attention).toEqual([])
  expect(crewPulse([agent('coder')]).attention).toEqual([])
})
