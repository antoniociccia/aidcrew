import { expect, test } from 'bun:test'
import { controlPreview } from '../site/case-preview.js'

function setup(reduced = false) {
  const video = { paused: true, play() { this.paused = false; return Promise.resolve() }, pause() { this.paused = true } }
  const button = { textContent: '', setAttribute() {}, addEventListener(_, fn) { this.click = fn } }
  const motion = { matches: reduced, addEventListener(_, fn) { this.change = fn } }
  return { video, button, motion, controller: controlPreview(video, button, motion) }
}
test('background plays only while visible and preserves a manual pause', () => {
  const { video, button, controller } = setup()
  controller.visible(true)
  expect(video.paused).toBe(false)
  button.click()
  controller.visible(false)
  controller.visible(true)
  expect(video.paused).toBe(true)
})
test('reduced motion starts on a still poster but permits explicit playback', () => {
  const { video, button, controller } = setup(true)
  controller.visible(true)
  expect(video.paused).toBe(true)
  button.click()
  expect(video.paused).toBe(false)
  controller.visible(false)
  expect(video.paused).toBe(true)
})
