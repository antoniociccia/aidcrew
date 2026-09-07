import { describe, expect, test } from 'bun:test'
import { withHome } from './main.ts'

describe('where home is', () => {
  // For a benchmark, a container, a test from the shell: somewhere with no
  // crew of one's own and no settings, so a run is only what the project
  // declares.
  test('AIDCREW_HOME points a run at another home', () => {
    expect(withHome({ AIDCREW_HOME: '/elsewhere' }, {})).toEqual({ home: '/elsewhere' })
  })

  test('the option given in code still wins', () => {
    expect(withHome({ AIDCREW_HOME: '/elsewhere' }, { home: '/mine' })).toEqual({ home: '/mine' })
  })

  test('an empty or absent variable changes nothing', () => {
    expect(withHome({ AIDCREW_HOME: '  ' }, {})).toEqual({})
    expect(withHome({}, {})).toEqual({})
  })
})
