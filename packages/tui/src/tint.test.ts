import { describe, expect, test } from 'bun:test'
import { headerTint, mix, paneTint } from './tint.ts'

describe('mix', () => {
  test('keeps the colour at zero', () => {
    expect(mix('#ff0000', '#000000', 0)).toBe('#ff0000')
  })

  test('gives the ground at one', () => {
    expect(mix('#ff0000', '#000000', 1)).toBe('#000000')
  })

  test('lands between them halfway', () => {
    expect(mix('#ffffff', '#000000', 0.5)).toBe('#808080')
  })

  test('falls back to the ground for anything that is not a colour', () => {
    expect(mix('lilac', '#101010', 0.5)).toBe('#101010')
  })

  test('clamps rather than overshooting', () => {
    expect(mix('#ffffff', '#000000', 5)).toBe('#000000')
  })
})

describe('tints', () => {
  test('a pane tint stays close to the ground, so text still reads on it', () => {
    const ground = '#0e0e10'
    const tinted = paneTint('#a78bfa', ground)

    expect(tinted).not.toBe('#a78bfa')
    expect(tinted).not.toBe(ground)
  })

  test('a header tint is stronger than a pane tint', () => {
    const ground = '#0e0e10'
    const pane = Number.parseInt(paneTint('#a78bfa', ground).slice(1), 16)
    const header = Number.parseInt(headerTint('#a78bfa', ground).slice(1), 16)

    // Stronger means further from the ground, which here means brighter.
    expect(header).toBeGreaterThan(pane)
  })

  test('every agent colour tints to something distinct', () => {
    const ground = '#0e0e10'
    const tints = ['#a78bfa', '#7dd3fc', '#f0abfc', '#4ade80'].map((v) => paneTint(v, ground))

    expect(new Set(tints).size).toBe(4)
  })
})
