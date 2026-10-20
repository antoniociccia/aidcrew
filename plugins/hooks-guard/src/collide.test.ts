import { describe, expect, test } from 'bun:test'
import { createRadar } from './collide.ts'

describe('two agents heading for the same lines', () => {
  test('are seen before git sees them, across two checkouts of one repository', () => {
    const radar = createRadar()

    radar.saw({
      agentId: 'architect',
      path: '.aidcrew/wt/plan/src/rates.ts',
      ranges: [[8, 14]],
      at: 1_000,
    })
    const hit = radar.saw({
      agentId: 'coder',
      path: '.aidcrew/wt/rates/src/rates.ts',
      ranges: [[10, 12]],
      at: 2_000,
    })

    expect(hit).toEqual([
      {
        file: 'src/rates.ts',
        mine: 'coder',
        theirs: 'architect',
        lines: [10, 12],
        theirLines: [8, 14],
        task: 'plan',
        since: 1_000,
      },
    ])
  })

  test('the same agent writing twice is not a collision with itself', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'coder', path: 'a.ts', ranges: [[1, 3]], at: 1 })

    expect(radar.saw({ agentId: 'coder', path: 'a.ts', ranges: [[1, 3]], at: 2 })).toEqual([])
  })

  test('two files of the same name in one checkout are one file', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'src/a.ts', ranges: [[1, 3]], at: 1 })

    expect(radar.saw({ agentId: 'b', path: 'src/b.ts', ranges: [[1, 3]], at: 2 })).toEqual([])
  })

  test('lines that never meet are not a collision', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'x.ts', ranges: [[1, 3]], at: 1 })

    expect(radar.saw({ agentId: 'b', path: 'x.ts', ranges: [[40, 42]], at: 2 })).toEqual([])
  })

  test('lines that nearly meet are, because a merge does not split hairs', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'x.ts', ranges: [[1, 3]], at: 1 })

    expect(radar.saw({ agentId: 'b', path: 'x.ts', ranges: [[5, 6]], at: 2 })).toHaveLength(1)
  })

  test('a job that has come home collides with nobody', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'x.ts', ranges: [[1, 3]], at: 1 })
    radar.finished('a')

    expect(radar.saw({ agentId: 'b', path: 'x.ts', ranges: [[1, 3]], at: 2 })).toEqual([])
  })

  test('says it once rather than on every write that follows', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'x.ts', ranges: [[1, 3]], at: 1 })

    expect(radar.saw({ agentId: 'b', path: 'x.ts', ranges: [[1, 3]], at: 2 })).toHaveLength(1)
    expect(radar.saw({ agentId: 'b', path: 'x.ts', ranges: [[1, 3]], at: 3 })).toEqual([])
  })

  test('names every agent already in the same place, not only the first', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'x.ts', ranges: [[1, 3]], at: 1 })
    radar.saw({ agentId: 'b', path: 'x.ts', ranges: [[2, 4]], at: 2 })

    const hit = radar.saw({ agentId: 'c', path: 'x.ts', ranges: [[1, 5]], at: 3 })

    expect(hit.map((one) => one.theirs).sort()).toEqual(['a', 'b'])
  })

  test('an agent that shares the repository still collides with one in a checkout', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'a', path: 'src/rates.ts', ranges: [[1, 3]], at: 1 })

    const hit = radar.saw({
      agentId: 'b',
      path: '.aidcrew/wt/rates/src/rates.ts',
      ranges: [[2, 4]],
      at: 2,
    })

    expect(hit).toHaveLength(1)
    expect(hit[0]?.file).toBe('src/rates.ts')
  })
})

describe('how a collision reads', () => {
  test('is one sentence naming who, where and when', () => {
    const radar = createRadar()
    radar.saw({ agentId: 'architect', path: '.aidcrew/wt/plan/a.ts', ranges: [[8, 14]], at: 0 })
    const [hit] = radar.saw({ agentId: 'coder', path: 'a.ts', ranges: [[10, 12]], at: 120_000 })

    expect(hit).toBeDefined()
    if (!hit) return
    expect(radar.sentence(hit, 120_000)).toBe(
      'architect changed a.ts lines 8-14 in its own checkout (plan) 2m ago; your change to lines 10-12 overlaps it, and the two will have to be merged.',
    )
  })
})
