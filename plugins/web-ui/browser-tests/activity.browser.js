// Run with bun plugins/web-ui/browser-tests/activity.browser.js; set CHROME_PATH outside macOS.
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startWebUI } from '../src/index.ts'
import { puppeteer } from '../../browser-chromium/mcp/node_modules/chrome-devtools-mcp/build/src/third_party/index.js'
const agent=id=>({id,role:id,status:'idle',queued:0,model:'fixture',usage:{inputTokens:0,outputTokens:0},turns:1,workspace:'/fixture',isolated:true,activity:[],yolo:false,behind:0,task:'sample',estimated:false})
const lines=Array.from({length:70},(_,index)=>({agentId:index%2?'coder':'architect',kind:index%3?'say':'tool',text:`Recorded event ${index}: ${index%3?'A public update about the assigned work.':'read src/evidence.ts'}`}))
lines.push({agentId:'architect',kind:'note',text:'→ coder: Verify the boundary'},{agentId:'coder',kind:'note',text:'← architect: Verify the boundary\nPreserve the full evidence log.'},{agentId:'coder',kind:'error',text:'Synthetic verification failed'},{agentId:'coder',kind:'thinking',text:'PRIVATE_REASONING_MUST_NOT_RENDER'})
const state={sessionId:'activity-fixture',cwd:'/fixture',ready:true,agents:['architect','coder'].map(agent),lines,target:'architect',sharedMemory:true,outstanding:0,plugins:[],themes:[]}
const server=startWebUI({snapshot:()=>state,dispatch:async()=>({})},{port:0})
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,pipe:true,args:['--no-first-run']})
try{
 const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message))
 await page.setViewport({width:1440,height:900});await page.goto(server.url);await page.waitForSelector('.activity-log-row')
 assert.equal(await page.$eval('.activity-log-controls select',node=>node.value),'')
 assert.equal(await page.$$eval('.activity-log-row',nodes=>nodes.length),72)
 assert.equal(await page.$eval('.activity-log',node=>node.textContent.includes('PRIVATE_REASONING_MUST_NOT_RENDER')),false)
 await page.click('.activity-log-filters [data-filter="handoffs"]')
 assert.equal(await page.$$eval('.activity-log-row',nodes=>nodes.length),1)
 await page.click('.activity-log-row summary')
 assert.match(await page.$eval('.activity-log-detail',node=>node.textContent),/Preserve the full evidence log/)
 await page.select('.activity-log-controls select','coder');assert.equal(await page.$$eval('.activity-log-row',nodes=>nodes.length),1)
 await page.focus('.activity-log-row summary')
 state.lines.push({agentId:'architect',kind:'say',text:'A fresh public update'})
 await new Promise(resolve=>setTimeout(resolve,750))
 assert.equal(await page.$eval('.activity-log-controls select',node=>node.value),'coder')
 assert.equal(await page.$eval('.activity-log-row',node=>node.open),true)
 assert.equal(await page.$eval('.activity-log-row summary',node=>node===document.activeElement),true)
 await page.click('.activity-log-filters [data-filter="errors"]');assert.equal(await page.$$eval('.activity-log-row',nodes=>nodes.length),1)
 await page.type('.activity-log-controls input','absent');assert.match(await page.$eval('.activity-log-empty',node=>node.textContent),/No events match/)
 await page.$eval('.activity-log-controls input',node=>{node.value='';node.dispatchEvent(new Event('input'))})
 await page.select('.activity-log-controls select','');await page.click('.activity-log-filters [data-filter="all"]')
 await page.$eval('.activity-log-viewport',node=>{node.scrollTop=80;node.dispatchEvent(new Event('scroll'))})
 const scroll=await page.$eval('.activity-log-viewport',node=>node.scrollTop)
 assert.ok(scroll>0,'The event viewport must scroll independently')
 state.lines.push({agentId:'coder',kind:'say',text:'Appended while reading earlier rows'})
 await page.waitForFunction(()=>document.querySelector('.activity-log').textContent.includes('Appended while reading earlier rows'))
 assert.equal(await page.$eval('.activity-log-viewport',node=>node.scrollTop),scroll)
 await page.screenshot({path:join(tmpdir(),'aidcrew-activity-desktop.png'),fullPage:true})
 await page.setViewport({width:390,height:844});await page.waitForFunction(()=>innerWidth===390)
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
 await page.click('.activity-log-filters [data-filter="handoffs"]');await page.click('.activity-log-row summary')
 await page.screenshot({path:join(tmpdir(),'aidcrew-activity-mobile.png'),fullPage:true})
 assert.deepEqual(errors,[])
 console.log('PASS Activity chronological log, filters, full handoff, private reasoning excluded, live focus/scroll persistence, desktop/mobile')
}finally{await browser.close();server.close()}
