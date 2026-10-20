import { expect, test } from 'bun:test'
import { interactionPoints } from './team-interactions.ts'

const curve = { start: { x: 0, y: 0 }, control: { x: 50, y: 100 }, end: { x: 100, y: 0 } }

test('maps every message in journal order to a point on the selected curve', () => {
  const messages = [
    { id: 'later', index: 9 },
    { id: 'earlier', index: 2 },
  ]
  const points = interactionPoints(messages, curve)
  expect(points).toMatchObject([
    { id: 'earlier', index: 2, label: 1, t: 1 / 3 },
    { id: 'later', index: 9, label: 2, t: 2 / 3 },
  ])
  expect(points[0]?.x).toBeCloseTo(100 / 3, 10)
  expect(points[1]?.x).toBeCloseTo(200 / 3, 10)
  expect(points[0]?.y).toBeCloseTo(400 / 9, 10)
  expect(points[1]?.y).toBeCloseTo(400 / 9, 10)
  expect(messages.map((message) => message.id)).toEqual(['later', 'earlier'])
})

test('preserves separate journal ids for repeated message contents and handles no messages', () => {
  const messages = [
    { id: 'repeat:0', index: 1, text: 'Same' },
    { id: 'repeat:1', index: 2, text: 'Same' },
  ]
  expect(interactionPoints(messages, curve).map((point) => point.id)).toEqual([
    'repeat:0',
    'repeat:1',
  ])
  expect(interactionPoints([], curve)).toEqual([])
  expect(interactionPoints([{ id: 'one', index: 0 }], curve)[0]).toEqual({
    id: 'one',
    index: 0,
    label: 1,
    t: 0.5,
    x: 50,
    y: 50,
  })
})

test('keeps all dense exchanges finite and inside the curve control bounds without mutating inputs', () => {
  const messages = Array.from({ length: 100 }, (_, index) => ({ id: `message-${index}`, index }))
  const original = JSON.stringify({ messages, curve })
  const points = interactionPoints(messages, curve)
  expect(points).toHaveLength(100)
  expect(new Set(points.map((point) => point.id)).size).toBe(100)
  expect(
    points.every(
      (point) =>
        Number.isFinite(point.x) &&
        Number.isFinite(point.y) &&
        point.x > 0 &&
        point.x < 100 &&
        point.y >= 0 &&
        point.y <= 100,
    ),
  ).toBe(true)
  expect(
    points.every((point, index) => point.label === index + 1 && point.t > 0 && point.t < 1),
  ).toBe(true)
  expect(JSON.stringify({ messages, curve })).toBe(original)
})
