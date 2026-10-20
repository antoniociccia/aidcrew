import { describe, expect, test } from 'bun:test'
import { agentAvatar } from './agent-avatar.ts'

describe('agent visual identity', () => {
  test('keeps identity stable when roles or roster order change', () => {
    const first = agentAvatar('architect', 'Architecture')
    agentAvatar('tester')
    const next = agentAvatar('architect', 'Team leader')
    expect(next.cells).toEqual(first.cells)
    expect(next.color).toBe(first.color)
    expect(next.initials).toBe(first.initials)
  })

  test('gives clones distinct symmetric identicons', () => {
    const identities = [
      'architect',
      'coder',
      'reviewer',
      'tester',
      'tester-2',
      'plugin-writer',
    ].map((id) => agentAvatar(id))
    expect(new Set(identities.map((identity) => JSON.stringify(identity.cells))).size).toBe(6)
    for (const identity of identities) {
      expect(identity.cells.length).toBeGreaterThan(5)
      expect(identity.cells.length).toBeLessThan(25)
      for (const cell of identity.cells) {
        expect(identity.cells).toContainEqual({ x: 4 - cell.x, y: cell.y })
      }
    }
  })

  test('only emits bounded drawing coordinates and safe color values', () => {
    const identity = agentAvatar('<svg onload="alert(1)">', '<script>')
    expect(identity.color).toMatch(/^#[0-9a-f]{6}$/)
    expect(identity.background).toMatch(/^#[0-9a-f]{6}$/)
    expect(identity.initials).toMatch(/^[A-Z0-9?]{1,2}$/)
    for (const cell of identity.cells) {
      expect(Number.isInteger(cell.x) && cell.x >= 0 && cell.x <= 4).toBe(true)
      expect(Number.isInteger(cell.y) && cell.y >= 0 && cell.y <= 4).toBe(true)
    }
  })

  test('keeps avatar marks readable against their background', () => {
    function luminance(hex: string): number {
      const channels = [1, 3, 5].map((offset) => {
        const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
      })
      return (channels[0] ?? 0) * 0.2126 + (channels[1] ?? 0) * 0.7152 + (channels[2] ?? 0) * 0.0722
    }
    for (let index = 0; index < 100; index++) {
      const identity = agentAvatar(`agent-${index}`)
      const contrast = (luminance(identity.color) + 0.05) / (luminance(identity.background) + 0.05)
      expect(contrast).toBeGreaterThanOrEqual(4.5)
    }
  })

  test('provides readable identity labels and role hints with safe empty fallback', () => {
    expect(agentAvatar('tester-2', 'tester')).toMatchObject({
      initials: 'T2',
      mark: 'T',
      label: 'tester-2 · tester',
    })
    expect(agentAvatar('')).toMatchObject({ initials: '?', mark: '?', label: '?' })
    expect(agentAvatar('reviewer').label).toBe('reviewer')
  })
})
