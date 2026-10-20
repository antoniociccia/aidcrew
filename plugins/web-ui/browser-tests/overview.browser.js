// Run with bun plugins/web-ui/browser-tests/overview.browser.js; set CHROME_PATH outside macOS.
import { strict as assert } from 'node:assert'
import { startWebUI } from '../src/index.ts'
import { puppeteer } from '../../browser-chromium/mcp/node_modules/chrome-devtools-mcp/build/src/third_party/index.js'

const agent = (id, extras = {}) => ({ id, role: id, model: 'local-fixture', status: 'idle', usage: { inputTokens: 0, outputTokens: 0 }, turns: 1, workspace: '/fixture', isolated: true, activity: [], yolo: false, behind: 0, queued: 0, task: 'replay-validation', estimated: false, ...extras })
const state = {
  sessionId: 'overview-fixture', cwd: '/fixture/aidcrew', ready: true,
  agents: ['architect', 'coder', 'reviewer', 'tester', 'tester-2', 'researcher', 'writer'].map(id => agent(id, id === 'coder' ? { status: 'working', queued: 2 } : id === 'reviewer' ? { status: 'stopped' } : {})),
  lines: [
    { agentId: 'architect', kind: 'ask', text: 'Build a reproducible simulation.' },
    { agentId: 'architect', kind: 'say', text: 'The replay design is ready for review; validation is still pending.' },
    { agentId: 'coder', kind: 'ask', text: 'Implement deterministic replay and validate saved journals.' },
    { agentId: 'coder', kind: 'tool', text: 'bash internal-tool-command-must-stay-in-activity' },
    { agentId: 'reviewer', kind: 'error', text: 'Current provider failure needs review.' },
    { agentId: 'tester', kind: 'error', text: 'Obsolete error recovered earlier.' },
    { agentId: 'tester', kind: 'say', text: 'Historical tester response belongs in the conversation.' },
    { agentId: 'writer', kind: 'note', text: '← coder: Historical received note belongs in the conversation.' },
  ],
  target: 'architect', sharedMemory: true, outstanding: 1, plugins: [], themes: [],
}
const actions = []
const server = startWebUI({ snapshot: () => state, dispatch: async action => { actions.push(action); return {} } }, { port: 0 })
const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, pipe: true, args: ['--no-first-run'] })
try {
  const page = await browser.newPage(), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewport({ width: 1440, height: 950 })
  await page.goto(server.url)
  await page.waitForSelector('.overview-agent')
  assert.equal(await page.$('.rail [data-view="activity"]'), null)
  assert.equal(await page.$eval('#activity-surface', node => node.hidden), false)
  assert.equal(await page.$eval('#overview-workspace', node => node.contains(document.querySelector('#activity-surface'))), true)
  await page.click('.overview-team > summary')
  assert.equal(await page.$$eval('.overview-agent', nodes => nodes.length), 7)
  assert.equal(await page.$$eval('.overview-agent .overview-latest,.overview-agent .overview-tool-details,.overview-agent .overview-assignment-details', nodes => nodes.length), 0)
  const crew = await page.$eval('.overview-crew', node => node.textContent)
  assert.doesNotMatch(crew, /internal-tool-command|Historical tester response|Historical received note|Obsolete error|Current provider failure/)
  assert.match(crew, /Implement deterministic replay/)
  assert.match(crew, /replay-validation/)
  assert.match(crew, /2 messages waiting/)
  assert.match(await page.$eval('.overview-context', node => node.textContent), /validation is still pending/)
  assert.equal(await page.$$eval('.overview-attention-item', nodes => nodes.length), 1)
  assert.match(await page.$eval('.overview-attention', node => node.textContent), /Current provider failure/)
  assert.doesNotMatch(await page.$$eval('.overview-status', nodes => nodes.map(node => node.textContent).join(' ')), /complete|finished|done/i)
  const heights = await page.$$eval('.overview-agent', nodes => nodes.map(node => node.getBoundingClientRect().height))
  assert.ok(heights.every(height => height <= 170), `Crew rows must stay compact: ${heights.join(', ')}`)
  assert.equal(await page.$eval('.quick-chat-launcher', node => node.disabled), false)
  await page.click('.quick-chat-launcher')
  assert.equal(await page.$eval('.quick-chat', node => node.hidden), false)
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('.quick-chat', node => node.hidden), true)
  await page.screenshot({ path: '/tmp/aidcrew-overview-distinct-desktop.png', fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: '/tmp/aidcrew-overview-distinct-mobile.png', fullPage: true })
  await page.click('[data-overview-action="agent:coder"]')
  assert.equal(await page.$eval('#recipient', node => node.textContent), 'coder')
  assert.deepEqual(errors, [])
  assert.deepEqual(actions, [])
  console.log('PASS concise overview crew, single lead context, current-only attention, quick chat, agent navigation, mobile bounds, and no unintended dispatch')
} finally {
  await browser.close()
  server.close()
}
