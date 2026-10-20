// Run with bun plugins/web-ui/browser-tests/quick-chat.browser.js; set CHROME_PATH outside macOS.
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { puppeteer } from '../../browser-chromium/mcp/node_modules/chrome-devtools-mcp/build/src/third_party/index.js'

const source = fileURLToPath(new URL('../src/', import.meta.url))
const build = await Bun.build({
  entrypoints: [join(source, 'quick-chat-client.js')],
  target: 'browser',
})
assert.equal(build.success, true, String(build.logs))
const module = await build.outputs[0].text()
const fixture = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/style.css"><style>*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;background:#0b1115;color:white;font:14px sans-serif}button,select,textarea{font:inherit}button{cursor:pointer}#launcher{padding:14px}</style><div id="launcher" class="top-actions"></div><aside id="host"></aside><script type="module">
import {initQuickChat} from '/module.js';
window.state={cwd:'/fixture/chat',sessionId:'chat-session',ready:true,target:'coder',agents:['architect','coder','reviewer'].map(id=>({id,status:'idle',queued:0})),lines:[{agentId:'architect',kind:'ask',text:'Build a test runner'},{agentId:'architect',kind:'say',text:'I will prepare the implementation'},{agentId:'architect',kind:'tool',text:'TOOL_PRIVATE'},{agentId:'architect',kind:'thinking',text:'REASONING_PRIVATE'},{agentId:'coder',kind:'say',text:'Coder answer'}]};
window.calls=[];window.chosen=[];window.cancelled=0;window.mode='success';
window.addEventListener('keydown',event=>{if(event.key==='Escape')window.cancelled++});
window.chat=initQuickChat({host:document.getElementById('host'),launcherHost:document.getElementById('launcher'),choose:id=>chosen.push(id),send:async(agent,text)=>{calls.push({agent,text});if(mode==='fail')throw new Error('Fixture send failure');if(mode==='pending')await new Promise((resolve,reject)=>window.delivery={resolve,reject});}});
chat.render(state,true);
</script>`
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const path = new URL(request.url).pathname
    if (path === '/base.css')
      return new Response(await Bun.file(join(source, 'style.css')).text(), {
        headers: { 'Content-Type': 'text/css' },
      })
    if (path === '/module.js')
      return new Response(module, { headers: { 'Content-Type': 'text/javascript' } })
    if (path === '/style.css')
      return new Response(await Bun.file(join(source, 'quick-chat.css')).text(), {
        headers: { 'Content-Type': 'text/css' },
      })
    return new Response(fixture, { headers: { 'Content-Type': 'text/html' } })
  },
})
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
  await page.setViewport({ width: 1280, height: 900 })
  await page.goto(server.url.href)
  await page.waitForSelector('.quick-chat-launcher')
  assert.equal(await page.$eval('#quick-chat', (node) => node.hidden), true)
  await page.click('.quick-chat-launcher')
  assert.equal(await page.$eval('.quick-chat-contact select', (node) => node.value), 'architect')
  assert.equal(await page.$$eval('.quick-chat-message', (nodes) => nodes.length), 2)
  assert.equal(
    await page.$eval('.quick-chat-feed', (node) =>
      /TOOL_PRIVATE|REASONING_PRIVATE|Coder answer/.test(node.textContent),
    ),
    false,
  )
  await page.type('.quick-chat-form textarea', 'Architect draft')
  await page.select('.quick-chat-contact select', 'coder')
  await page.type('.quick-chat-form textarea', 'Coder draft')
  await page.select('.quick-chat-contact select', 'architect')
  assert.equal(
    await page.$eval('.quick-chat-form textarea', (node) => node.value),
    'Architect draft',
  )
  await page.select('.quick-chat-contact select', 'coder')
  assert.equal(await page.$eval('.quick-chat-form textarea', (node) => node.value), 'Coder draft')
  await page.click('.quick-chat-form button')
  await page.waitForFunction(() => document.querySelector('.quick-chat-form textarea').value === '')
  assert.deepEqual(await page.evaluate(() => calls), [{ agent: 'coder', text: 'Coder draft' }])
  await page.evaluate(() => (mode = 'fail'))
  await page.type('.quick-chat-form textarea', 'Keep failed draft')
  await page.click('.quick-chat-form button')
  await page.waitForFunction(
    () => document.querySelector('.quick-chat-error').textContent === 'Fixture send failure',
  )
  assert.equal(
    await page.$eval('.quick-chat-form textarea', (node) => node.value),
    'Keep failed draft',
  )
  await page.evaluate(() => (mode = 'pending'))
  await page.click('.quick-chat-form button')
  await page.waitForFunction(() => Boolean(window.delivery))
  assert.equal(await page.$eval('.quick-chat-form button', (node) => node.disabled), true)
  await page.focus('.quick-chat-form textarea')
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('#quick-chat', (node) => node.hidden), true)
  assert.equal(await page.evaluate(() => cancelled), 0)
  assert.equal(await page.evaluate(() => calls.length), 3)
  await page.click('.quick-chat-launcher')
  assert.equal(await page.$eval('.quick-chat-form button', (node) => node.disabled), true)
  await page.select('.quick-chat-contact select', 'architect')
  assert.equal(
    await page.$eval('.quick-chat-form textarea', (node) => node.value),
    'Architect draft',
  )
  assert.equal(await page.$eval('.quick-chat-form button', (node) => node.disabled), false)
  await page.evaluate(() => delivery.resolve())
  await page.waitForFunction(
    () => document.querySelector('.quick-chat-form button').textContent === 'Send',
  )
  assert.deepEqual(await page.evaluate(() => calls.at(-1)), {
    agent: 'coder',
    text: 'Keep failed draft',
  })
  assert.equal(
    await page.$eval('.quick-chat-form textarea', (node) => node.value),
    'Architect draft',
  )
  await page.select('.quick-chat-contact select', 'coder')
  assert.equal(await page.$eval('.quick-chat-form textarea', (node) => node.value), '')
  await page.select('.quick-chat-contact select', 'reviewer')
  await page.focus('.quick-chat-form textarea')
  await page.keyboard.press('Escape')
  assert.equal(await page.$eval('#quick-chat', (node) => node.hidden), true)
  assert.equal(await page.evaluate(() => cancelled), 0)
  assert.equal(await page.evaluate(() => calls.length), 3)
  await page.reload()
  await page.click('.quick-chat-launcher')
  assert.equal(await page.$eval('.quick-chat-contact select', (node) => node.value), 'reviewer')
  await page.evaluate(() => {
    state = { ...state, cwd: '/fixture/other' }
    chat.render(state, true)
  })
  assert.equal(await page.$eval('.quick-chat-contact select', (node) => node.value), 'architect')
  await page.evaluate(() => {
    state = { ...state, cwd: '/fixture/chat' }
    chat.render(state, true)
  })
  assert.equal(await page.$eval('.quick-chat-contact select', (node) => node.value), 'reviewer')
  await page.click('.quick-chat-full')
  assert.deepEqual(await page.evaluate(() => chosen), ['reviewer'])
  assert.equal(await page.$eval('#quick-chat', (node) => node.hidden), true)
  await page.evaluate(() => chat.open())
  await page.type('.quick-chat-form textarea', 'Offline draft')
  await page.evaluate(() => chat.render(state, false))
  assert.equal(await page.$eval('.quick-chat-form button', (node) => node.disabled), true)
  assert.equal(await page.$eval('.quick-chat-form textarea', (node) => node.value), 'Offline draft')
  await page.evaluate(() => chat.render(state, true))
  await page.screenshot({ path: join(tmpdir(), 'aidcrew-quick-chat-desktop.png') })
  await page.setViewport({ width: 390, height: 844 })
  assert.ok(await page.$eval('.quick-chat-launcher', (node) => node.getBoundingClientRect().width) > 0)
  assert.equal(
    await page.$eval('#quick-chat', (node) => {
      const rect = node.getBoundingClientRect()
      return (
        rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
      )
    }),
    true,
  )
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({ path: join(tmpdir(), 'aidcrew-quick-chat-mobile.png') })
  assert.deepEqual(errors, [])
  console.log(
    'PASS quick chat target, workspace contact persistence, drafts, failed and in-flight sends, Escape without cancellation, message filtering and mobile bounds',
  )
} finally {
  await browser?.close()
  server.stop(true)
}
