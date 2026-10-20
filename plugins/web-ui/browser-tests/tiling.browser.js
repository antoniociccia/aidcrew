// Run with bun plugins/web-ui/browser-tests/tiling.browser.js; set CHROME_PATH outside macOS.
import { strict as assert } from 'node:assert'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { puppeteer } from '../../browser-chromium/mcp/node_modules/chrome-devtools-mcp/build/src/third_party/index.js'
const root = fileURLToPath(new URL('../src/', import.meta.url))
const build=await Bun.build({entrypoints:[root+'tiling-client.js'],target:'browser'})
assert.equal(build.success,true,String(build.logs))
const js=await build.outputs[0].text()
const server=Bun.serve({port:0,hostname:'127.0.0.1',async fetch(req){const path=new URL(req.url).pathname;if(path==='/module.js')return new Response(js,{headers:{'Content-Type':'text/javascript'}});if(path==='/style.css')return new Response(await Bun.file(root+'tiling.css').text(),{headers:{'Content-Type':'text/css'}});return new Response(`<link rel="stylesheet" href="/style.css"><style>body{margin:0;background:#0b1115;color:white;font:14px sans-serif}#host{height:95vh}</style><div id="host"></div><script type="module">import{initTiling}from'/module.js';window.state={cwd:'/fixture',ready:true,agents:['architect','coder','tester','reviewer'].map(id=>({id,role:id,status:'working',queued:0})),lines:Array.from({length:100},(_,i)=>({agentId:'coder',kind:i%2?'tool':'say',text:'line '+i})),};window.sent=[];window.ui=initTiling({host:document.getElementById('host'),avatar:()=>document.createElement('i'),choose:id=>window.chosen=id,send:async(id,text)=>sent.push({id,text})});ui.render(state,true,'coder');</script>`,{headers:{'Content-Type':'text/html'}})}})
const browser=await puppeteer.launch({executablePath:process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,pipe:true,args:['--no-first-run']})
try{const page=await browser.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));await page.setViewport({width:1400,height:900});await page.goto(server.url.href);await page.waitForSelector('.tile-pane');assert.equal(await page.$$eval('.tile-pane',nodes=>nodes.length),4);assert.equal(await page.$eval('[data-agent="coder"] .tile-transcript',node=>node.textContent.includes('line 99')),true);
assert.equal(await page.$eval('[data-agent="coder"] .tile-transcript',node=>node.scrollHeight-node.clientHeight-node.scrollTop<4),true);
const sep=await page.$('[role=separator]'),before=await sep.evaluate(node=>Number(node.getAttribute('aria-valuenow')));await sep.focus();await page.keyboard.press(await sep.evaluate(node=>node.getAttribute('aria-orientation')==='vertical'?'ArrowRight':'ArrowDown'));assert.notEqual(await sep.evaluate(node=>Number(node.getAttribute('aria-valuenow'))),before);
const a=await page.$eval('[data-agent="architect"] .tile-drag',node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}),b=await page.$eval('[data-agent="coder"]',node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}});await page.mouse.move(a.x,a.y);await page.mouse.down();await page.mouse.move(b.x,b.y,{steps:8});await page.waitForSelector('.tile-drop-preview');await page.mouse.up();const stored=await page.evaluate(()=>localStorage.getItem('aidcrew:tiles:v1:/fixture'));assert.ok(stored);await page.reload();await page.waitForSelector('.tile-pane');assert.equal(await page.evaluate(()=>localStorage.getItem('aidcrew:tiles:v1:/fixture')),stored);
await page.$eval('[data-agent="coder"] textarea',node=>node.value='Ship it');await page.focus('[data-agent="coder"] textarea');await page.keyboard.down('Control');await page.keyboard.press('Enter');await page.keyboard.up('Control');await page.waitForFunction(()=>sent.length===1);assert.deepEqual(await page.evaluate(()=>sent[0]),{id:'coder',text:'Ship it'});

// Reading history, filter and focused draft survive live updates.
await page.$eval('[data-agent="coder"] .tile-transcript',node=>node.scrollTop=40);
await page.waitForFunction(()=>document.querySelector('[data-agent="coder"] .tile-transcript').scrollTop===40);
await page.focus('[data-agent="coder"] textarea');await page.type('[data-agent="coder"] textarea','draft stays');
await page.evaluate(()=>{state.lines.push({agentId:'coder',kind:'say',text:'new live update'});ui.render(state,true,'coder')});
assert.equal(await page.$eval('[data-agent="coder"] .tile-transcript',node=>node.scrollTop),40);
assert.equal(await page.$eval('[data-agent="coder"] textarea',node=>node.value),'draft stays');
// Resize with a real pointer and keep DOM ownership while live state changes.
const separator=await page.$('[role=separator]'),box=await separator.boundingBox();
const old=await separator.evaluate(node=>Number(node.getAttribute('aria-valuenow')));
await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
await page.evaluate(()=>{window.held=document.querySelector('[data-agent="coder"]');state.lines.push({agentId:'tester',kind:'say',text:'during resize'});ui.render(state,true,'coder');});
await page.mouse.move(box.x+box.width/2+70,box.y+box.height/2+70,{steps:8});await page.mouse.up();
assert.equal(await page.evaluate(()=>held===document.querySelector('[data-agent="coder"]')),true);
assert.notEqual(await separator.evaluate(node=>Number(node.getAttribute('aria-valuenow'))),old);
await page.click('[data-agent="coder"] .tile-maximize');assert.equal(await page.$$eval('.tiling-stage .tile-pane',nodes=>nodes.length),1);await page.click('[data-agent="coder"] .tile-maximize');assert.equal(await page.$$eval('.tiling-stage .tile-pane',nodes=>nodes.length),4);

const sourceRect=await page.$eval('[data-agent="architect"] .tile-drag',node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}}),targetRect=await page.$eval('[data-agent="reviewer"]',node=>{const r=node.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+5}});
await page.mouse.move(sourceRect.x,sourceRect.y);await page.mouse.down();await page.mouse.move(targetRect.x,targetRect.y,{steps:8});await page.waitForSelector('.tile-drop-preview.top');await page.mouse.up();
assert.equal(await page.evaluate(()=>{const a=document.querySelector('[data-agent="architect"]').getBoundingClientRect(),b=document.querySelector('[data-agent="reviewer"]').getBoundingClientRect();return a.bottom<=b.top}),true);
await page.click('[data-agent="architect"] .tile-menu summary');await page.select('[data-agent="architect"] .tile-menu select[aria-label="Target agent"]','tester');await page.select('[data-agent="architect"] .tile-menu select[aria-label="Dock position"]','center');await page.$eval('[data-agent="architect"] .tile-menu button',button=>button.click());
await page.evaluate(()=>{state.agents.push({id:'researcher',status:'idle',queued:0});ui.render(state,true,'coder')});assert.equal(await page.$$eval('.tile-pane',nodes=>nodes.length),5);
await page.evaluate(()=>{state.agents=state.agents.filter(agent=>agent.id!=='researcher');ui.render(state,true,'coder')});assert.equal(await page.$$eval('.tile-pane',nodes=>nodes.length),4);

const customLayout=await page.evaluate(()=>localStorage.getItem('aidcrew:tiles:v1:/fixture'));
await page.click('[data-agent="coder"] .tile-maximize');
await page.click('.tiling-balance');
assert.equal(await page.$eval('.tiling-balance',node=>node.textContent),'Restore layout');
assert.equal(await page.$$eval('.tiling-stage .tile-pane',nodes=>nodes.length),4);
assert.equal(await page.$eval('[data-agent="coder"] textarea',node=>node.value),'draft stays');
const restoredLayout=await page.evaluate(()=>localStorage.getItem('aidcrew:tiles:v1:/fixture'));
assert.notEqual(restoredLayout,customLayout);
assert.equal(await page.$$eval('.tile-pane',nodes=>nodes.every(node=>{const r=node.getBoundingClientRect();return r.width>=249 && r.height>=199})),true);
await page.reload();await page.waitForSelector('.tile-pane');assert.equal(await page.evaluate(()=>localStorage.getItem('aidcrew:tiles:v1:/fixture')),restoredLayout);
await page.screenshot({path:join(tmpdir(),'aidcrew-tiling-desktop.png')});await page.setViewport({width:390,height:844});await page.waitForFunction(()=>document.querySelector('.tile-pane').getBoundingClientRect().height>=190);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.click('.tiling-balance');assert.equal(await page.$$eval('.tile-pane',nodes=>new Set(nodes.map(node=>Math.round(node.getBoundingClientRect().x))).size),1);assert.deepEqual(errors,[]);console.log('tiling browser checks passed')
}finally{await browser.close();server.stop(true)}
