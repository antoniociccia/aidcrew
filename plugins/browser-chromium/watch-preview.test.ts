import { expect, test } from 'bun:test'
import { isPreviewPage, refreshPreview } from './watch-preview.ts'

test('refreshes only local preview tabs, preserving unrelated pages', async () => {
  const pages = [
    { type: 'page', url: 'http://localhost:8787/' },
    { type: 'page', url: 'http://127.0.0.1:8787/game' },
    { type: 'page', url: 'http://localhost:3000/' },
    { type: 'page', url: 'https://example.com:8787/' },
    { type: 'service_worker', url: 'http://localhost:8787/' },
  ]
  const navigated: string[] = []
  expect(
    await refreshPreview(pages, pages[0]!.url, async (page) => {
      navigated.push(page.url)
    }),
  ).toBe(true)
  expect(navigated).toEqual(pages.slice(0, 2).map((page) => page.url))
  expect(isPreviewPage({ type: 'page', url: 'about:blank' }, pages[0]!.url)).toBe(false)
})

test('does not report success without a tab or after a failed navigation', async () => {
  expect(await refreshPreview([], 'http://localhost:8787/')).toBe(false)
  expect(
    await refreshPreview(
      [{ type: 'page', url: 'http://localhost:8787/' }],
      'http://localhost:8787/',
      async () => {
        throw new Error('disconnected')
      },
    ),
  ).toBe(false)
})
