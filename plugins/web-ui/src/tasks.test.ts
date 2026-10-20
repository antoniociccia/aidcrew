import { expect, test } from 'bun:test'
import { taskCards } from './tasks.ts'

const checkout = {
  name: 'parser',
  path: '/project/.aidcrew/wt/parser',
  head: 'abc123def456',
  changed: 2,
  behind: 1,
  main: false,
}
const coder = {
  id: 'coder',
  task: 'parser',
  status: 'working',
  model: 'model-a',
  provider: 'provider-a',
  cost: 0.02,
  estimated: false,
}

test('associates agents with their task and preserves checkout evidence', () => {
  const cards = taskCards([checkout], [coder, { ...coder, id: 'other', task: 'other' }])
  expect(cards).toEqual([
    {
      ...checkout,
      activity: 'working',
      agents: [coder],
      knownCost: 0.02,
      partialCost: false,
      estimatedCost: false,
    },
  ])
})

test('does not present a clean idle or unassigned checkout as completed', () => {
  expect(
    taskCards([{ ...checkout, changed: 0 }], [{ ...coder, status: 'idle' }])[0]?.activity,
  ).toBe('idle')
  expect(taskCards([checkout], [])[0]).toMatchObject({
    activity: 'unassigned',
    agents: [],
    knownCost: undefined,
    partialCost: false,
  })
})

test('labels incomplete and estimated costs instead of treating unknown prices as free', () => {
  const { cost: _cost, ...unpriced } = coder
  expect(taskCards([checkout], [coder, { ...unpriced, id: 'reviewer' }])[0]).toMatchObject({
    knownCost: 0.02,
    partialCost: true,
    estimatedCost: false,
  })
  expect(taskCards([checkout], [{ ...coder, cost: 0, estimated: true }])[0]).toMatchObject({
    knownCost: 0,
    partialCost: false,
    estimatedCost: true,
  })
  expect(taskCards([checkout], [unpriced])[0]).toMatchObject({
    knownCost: undefined,
    partialCost: true,
  })
})

test('preserves repository order and does not modify task or agent inputs', () => {
  const tasks = Object.freeze([Object.freeze(checkout), { ...checkout, name: 'main', main: true }])
  const agents = Object.freeze([Object.freeze(coder)])
  expect(taskCards(tasks, agents).map((card) => card.name)).toEqual(['parser', 'main'])
  expect(tasks[0]).toBe(checkout)
  expect(taskCards([], agents)).toEqual([])
})
