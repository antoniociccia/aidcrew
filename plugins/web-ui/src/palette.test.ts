import { expect, test } from 'bun:test'
import { createPaletteModel } from './palette.ts'

const runs: string[] = []
const actions = [
  { id: 'latest', label: 'Jump to latest', keywords: ['bottom'], run: () => runs.push('latest') },
  {
    id: 'agent:reviewer',
    label: 'Reviewer',
    description: 'Open agent transcript',
    run: () => runs.push('reviewer'),
  },
  { id: 'search', label: 'Search transcript', run: () => runs.push('search') },
]

test('finds commands and agents using every literal query term without interpreting patterns', () => {
  const model = createPaletteModel(() => actions)
  expect(model.search('  AGENT review ').map((action) => action.id)).toEqual(['agent:reviewer'])
  expect(model.search('bottom').map((action) => action.id)).toEqual(['latest'])
  expect(model.search('.*')).toEqual([])
})

test('wraps keyboard selection and resets it when the query changes', () => {
  const model = createPaletteModel(() => actions)
  model.search('')
  expect(model.move(-1)).toBe(2)
  expect(model.move(1)).toBe(0)
  model.move(1)
  model.search('search')
  expect(model.selected).toBe(0)
  expect(model.current()?.id).toBe('search')
  model.search('missing')
  expect(model.move(1)).toBe(-1)
  expect(model.current()).toBeUndefined()
})

test('refreshes available actions each time the palette is searched', () => {
  let available = actions
  const model = createPaletteModel(() => available)
  model.search('reviewer')
  available = actions.filter((action) => action.id !== 'agent:reviewer')
  expect(model.search('reviewer')).toEqual([])
  expect(model.current()).toBeUndefined()
})

test('resolves selected actions against current state and refuses removed actions', () => {
  let available = actions
  const model = createPaletteModel(() => available)
  model.search('reviewer')
  const replacement = {
    id: 'agent:reviewer',
    label: 'Updated reviewer',
    run: () => runs.push('new reviewer'),
  }
  available = [replacement]
  expect(model.resolve('agent:reviewer')).toBe(replacement)
  available = []
  expect(model.resolve('agent:reviewer')).toBeUndefined()
})
