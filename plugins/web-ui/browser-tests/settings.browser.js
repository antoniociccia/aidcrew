// Run with bun plugins/web-ui/browser-tests/settings.browser.js; set CHROME_PATH outside macOS.
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebUI } from '../src/index.ts'
import { puppeteer } from '../../browser-chromium/mcp/node_modules/chrome-devtools-mcp/build/src/third_party/index.js'

const agent = {
  id: 'coder',
  role: 'coder',
  model: 'fixture-model',
  provider: 'claude-code',
  status: 'idle',
  usage: { inputTokens: 0, outputTokens: 0 },
  turns: 0,
  workspace: '/fixture',
  isolated: true,
  activity: [],
  yolo: false,
  behind: 0,
  queued: 2,
  permissionOwner: 'provider',
}
const state = {
  sessionId: 'settings-fixture',
  cwd: '/fixture/project',
  ready: true,
  agents: [agent],
  lines: [],
  target: 'coder',
  sharedMemory: true,
  outstanding: 0,
  plugins: [{ name: 'fixture-tools', version: '1.0', tools: ['read', 'write'] }],
  themes: ['night', 'day'],
}
const inspection = {
  tasks: [],
  definitions: [
    { id: 'coder', description: 'Build features', systemPrompt: 'Fixture instructions' },
  ],
  sources: [
    { label: 'instructions', paths: ['AGENTS.md'] },
    { label: 'skills', paths: [] },
  ],
  credentials: [{ scope: 'provider:openrouter', hint: '…abcd' }],
  defaults: { provider: 'openrouter', model: 'saved-model' },
  fill: 'hairline',
  hidePaths: true,
}
const actions = []
const server = startWebUI(
  {
    snapshot: () => state,
    dispatch: async (action) => {
      actions.push(action)
      if (action.type === 'inspect') return inspection
      if (action.type === 'appearance') Object.assign(inspection, action)
      if (action.type === 'models') return ['fixture-model']
      if (action.type === 'default') inspection.defaults[action.setting] = action.value
      if (action.type === 'yolo') agent.yolo = action.on
      return undefined
    },
  },
  { port: 0 },
)
let browser
try {
  browser = await puppeteer.launch({
    executablePath:
      process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    headless: true,
    pipe: true,
    args: ['--no-first-run'],
  })
  const page = await browser.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.setViewport({ width: 1440, height: 950 })
  await page.goto(server.url)
  await page.waitForSelector('.overview-agent')
  await page.click('[data-view="settings"]')
  await page.waitForSelector('.settings-section', { timeout: 3000 })
  assert.equal(await page.$$eval('.settings-section', (nodes) => nodes.length), 7)
  assert.equal(
    await page.$$eval('.settings-page [role=tabpanel]:not([hidden])', (nodes) => nodes.length),
    1,
  )
  await page.focus('[data-settings-tab="agents"]')
  await page.keyboard.press('ArrowRight')
  assert.equal(
    await page.$eval(
      '.settings-page [role=tab][aria-selected=true]',
      (node) => node.dataset.settingsTab,
    ),
    'defaults',
  )
  assert.equal(await page.$$eval('.settings-page [role=tab]', (nodes) => nodes.length), 7)
  await page.click('[data-settings-tab="credentials"]')
  assert.equal(
    await page.$eval('[data-settings-section="credentials"]', (node) => {
      const r = node.getBoundingClientRect()
      return r.top >= 0 && r.top < innerHeight
    }),
    true,
  )
  assert.equal(
    await page.$eval('[data-settings-section="agents"]', (node) =>
      node.textContent.includes('2 queued'),
    ),
    true,
  )
  assert.equal(
    await page.$eval('[data-settings-section="defaults"]', (node) =>
      node.textContent.includes('saved-model'),
    ),
    true,
  )
  assert.equal(
    await page.$eval('[data-settings-section="sources"]', (node) =>
      node.textContent.includes('AGENTS.md'),
    ),
    true,
  )
  assert.equal(
    await page.$eval('[data-settings-action="fill-hairline"]', (node) =>
      node.getAttribute('aria-pressed'),
    ),
    'true',
  )
  await page.click('[data-settings-tab="terminal"]')
  await page.click('[data-settings-action="fill-solid"]')
  await page.waitForFunction(
    () =>
      document.querySelector('[data-settings-action="fill-solid"]').getAttribute('aria-pressed') ===
      'true',
  )
  assert.ok(actions.some((action) => action.type === 'appearance' && action.fill === 'solid'))
  await page.click('[data-settings-tab="agents"]')
  await page.click('[data-settings-action="clear-coder"]')
  await page.waitForNetworkIdle({ idleTime: 100 })
  assert.ok(actions.some((action) => action.type === 'clearQueue' && action.agent === 'coder'))
  await page.click('[data-settings-tab="agents"]')
  await page.click('[data-settings-action="autonomy-coder"]')
  assert.equal(await page.$eval('#modal-title', (node) => node.textContent), 'Agent autonomy')
  assert.equal(
    actions.some((action) => action.type === 'yolo'),
    false,
  )
  await page.click('#modal-submit')
  await page.waitForFunction(() => !document.querySelector('#modal').open)
  assert.ok(
    actions.some(
      (action) => action.type === 'yolo' && action.agent === 'coder' && action.on === true,
    ),
  )
  await page.click('[data-settings-tab="credentials"]')
  await page.click('[data-settings-action="save-key"]')
  assert.equal(await page.$eval('#modal input[name=key]', (node) => node.type), 'password')
  await page.type('#modal input[name=key]', 'fixture-secret-value')
  await page.click('#modal-submit')
  await page.waitForFunction(() => !document.querySelector('#modal').open)
  assert.ok(
    actions.some(
      (action) =>
        action.type === 'credentials' &&
        action.scope === 'provider:openrouter' &&
        action.key === 'fixture-secret-value',
    ),
  )
  assert.equal(
    await page.$eval('#details', (node) => node.textContent.includes('fixture-secret-value')),
    false,
  )
  await page.click('[data-settings-tab="sources"]')
  await page.click('[data-settings-action="sources-instructions"]')
  await page.waitForSelector('#modal textarea[name=paths]', { timeout: 2000 })
  assert.equal(await page.$eval('#modal textarea[name=paths]', (node) => node.value), 'AGENTS.md')
  await page.$eval('#modal textarea[name=paths]', (node) => (node.value = 'AGENTS.md\nCLAUDE.md'))
  await page.click('#modal-submit')
  await page.waitForFunction(() => !document.querySelector('#modal').open)
  assert.ok(
    actions.some(
      (action) =>
        action.type === 'sources' && action.kind === 'instructions' && action.paths.length === 2,
    ),
  )
  await page.click('[data-settings-tab="defaults"]')
  await page.click('[data-settings-action="defaults"]')
  await page.$eval('#modal input[name=model]', (node) => (node.value = 'updated-model'))
  await page.click('#modal-submit')
  await page.waitForFunction(() => !document.querySelector('#modal').open)
  assert.ok(
    actions.some(
      (action) =>
        action.type === 'default' && action.setting === 'model' && action.value === 'updated-model',
    ),
  )
  await page.click('[data-settings-tab="agents"]')
  await page.click('[data-settings-agent="coder"] summary')
  await page.click('[data-settings-tab="agents"]')
  await page.click('[data-settings-action="reset-coder"]')
  assert.equal(
    actions.some((action) => action.type === 'forget'),
    false,
  )
  await page.click('#modal-close')
  await page.click('[data-settings-tab="terminal"]')
  await page.click('[data-settings-action="fill-hairline"]')
  await page.waitForFunction(
    () =>
      document
        .querySelector('[data-settings-action="fill-hairline"]')
        .getAttribute('aria-pressed') === 'true',
  )
  assert.equal(await page.$eval('[data-settings-agent="coder"] details', (node) => node.open), true)
  assert.equal(
    await page.evaluate(() => document.activeElement.dataset.settingsAction),
    'fill-hairline',
  )
  await page.click('[data-settings-tab="agents"]')
  await page.click('[data-settings-action="model-coder"]')
  assert.equal(await page.$eval('#modal input[name=provider]', (node) => node.value), 'claude-code')
  await page.click('#modal-close')
  await page.click('[data-settings-tab="roles"]')
  await page.click('[data-settings-action="role-coder"]')
  assert.equal(
    await page.$eval('#modal textarea[name=systemPrompt]', (node) => node.value),
    'Fixture instructions',
  )
  await page.click('#modal-close')
  await page.click('[data-settings-tab="terminal"]')
  await page.click('[data-settings-action="theme-night"]')
  await page.waitForNetworkIdle({ idleTime: 100 })
  assert.ok(actions.some((action) => action.type === 'theme' && action.name === 'night'))
  await page.$eval('#details', (node) => (node.scrollTop = 500))
  const scrollBefore = await page.$eval('#details', (node) => node.scrollTop)
  await page.$eval('[data-settings-action="fill-solid"]', (node) => node.click())
  await page.waitForFunction(
    () =>
      document.querySelector('[data-settings-action="fill-solid"]').getAttribute('aria-pressed') ===
      'true',
  )
  assert.equal(await page.$eval('#details', (node) => node.scrollTop), scrollBefore)
  assert.equal(
    await page.$eval(
      '.settings-page [role=tab][aria-selected=true]',
      (node) => node.dataset.settingsTab,
    ),
    'terminal',
  )
  assert.equal(
    await page.$$eval('.settings-page [role=tabpanel]:not([hidden])', (nodes) => nodes.length),
    1,
  )
  assert.equal(await page.$eval('[data-settings-agent="coder"] details', (node) => node.open), true)
  await page.$eval('#details', (node) => (node.scrollTop = 0))
  await page.screenshot({ path: join(tmpdir(), 'aidcrew-settings-desktop.png'), fullPage: true })
  await page.setViewport({ width: 390, height: 844 })
  assert.equal(
    await page.$eval('#details', (node) => node.getBoundingClientRect().bottom > innerHeight - 80),
    true,
  )
  await page.waitForFunction(() => {
    const tab = document
      .querySelector('.settings-page [role=tab][aria-selected=true]')
      .getBoundingClientRect()
    const nav = document.querySelector('.settings-navigation').getBoundingClientRect()
    return tab.left >= nav.left - 1 && tab.right <= nav.right + 1
  })
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  assert.equal(
    await page.$$eval('.settings-section', (nodes) =>
      nodes
        .filter((node) => !node.hidden)
        .every((node) => {
          const r = node.getBoundingClientRect()
          return r.left >= 0 && r.right <= innerWidth
        }),
    ),
    true,
  )
  await page.$eval('#details', (node) => (node.scrollTop = 0))
  await page.screenshot({ path: join(tmpdir(), 'aidcrew-settings-mobile.png'), fullPage: true })
  await page.focus('[data-settings-tab="terminal"]')
  await page.keyboard.press('Home')
  assert.equal(
    await page.$eval(
      '.settings-page [role=tab][aria-selected=true]',
      (node) => node.dataset.settingsTab,
    ),
    'agents',
  )
  await page.keyboard.press('End')
  assert.equal(
    await page.$eval(
      '.settings-page [role=tab][aria-selected=true]',
      (node) => node.dataset.settingsTab,
    ),
    'terminal',
  )
  await page.keyboard.press('ArrowRight')
  assert.equal(
    await page.$eval(
      '.settings-page [role=tab][aria-selected=true]',
      (node) => node.dataset.settingsTab,
    ),
    'agents',
  )
  await page.click('[data-settings-tab="credentials"]')
  state.cwd = '/fixture/another-project'
  await page.waitForFunction(() =>
    document.querySelector('.settings-project').textContent.includes('another-project'),
  )
  assert.equal(
    await page.$eval(
      '.settings-page [role=tab][aria-selected=true]',
      (node) => node.dataset.settingsTab,
    ),
    'agents',
  )
  assert.equal(
    await page.$$eval('.settings-page [role=tabpanel]:not([hidden])', (nodes) => nodes.length),
    1,
  )
  assert.deepEqual(errors, [])
  console.log(
    'PASS settings tabs, keyboard navigation, polling persistence, workspace reset, truthful state, scoped actions, confirmation, credential password input, defaults, sources and mobile bounds',
  )
} finally {
  await browser?.close()
  server.close()
}
