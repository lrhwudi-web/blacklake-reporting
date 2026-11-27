// Run explicitly with node; real Chromium layout + wheel input, fictional read-only API.
const { chromium } = require('C:/Users/LRH/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const { createServer } = require('node:http');
const { readFile, mkdir, writeFile } = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');

const admin = process.env.ADMIN_SOURCE_ROOT ? path.resolve(process.env.ADMIN_SOURCE_ROOT) : path.resolve(__dirname, '..');
const output = path.resolve(__dirname, '../../../artifacts/task-recovery-scroll-20261106');
const rows = Array.from({length:35}, (_, i) => ({
  id:`scroll-${i}`, operatorName:`隔离员工${i + 1}`, blacklakeOperatorId:1000+i,
  projectCode:`QA-${i + 1}`, processName:'隔离工序', status:'IN_PROGRESS',
  machineId:'B-01', flags:[], publishedAt:'2026-11-06 08:00:00', startedAt:'2026-11-06 08:01:00'
}));
let shortList = false;
const nonGet = [], errors = [], checks = [];
const json = (res, value) => {res.setHeader('Content-Type','application/json'); res.end(JSON.stringify(value));};
const server = createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    res.setHeader('Cache-Control','no-store');
    if(req.method !== 'GET') {nonGet.push(req.method+' '+url.pathname); res.writeHead(405).end(); return;}
    if(url.pathname === '/api/me') return json(res,{user:{name:'隔离滚动验证'}});
    if(url.pathname === '/v1/admin/assignments') return json(res,{assignments:[], workOrders:[]});
    if(url.pathname === '/v1/admin/task-recovery') {
      const offset = Number(url.searchParams.get('offset') || 0), limit = Number(url.searchParams.get('limit') || 30);
      const list = shortList ? rows.slice(0,3) : rows;
      return json(res,{assignments:list.slice(offset,offset+limit),total:list.length,offset,limit,
        summary:{IN_PROGRESS:list.length},serverTime:'2026-11-06 08:31:09'});
    }
    if(url.pathname.startsWith('/v1/admin/task-recovery/assignments/')) {
      const row=rows.find(r=>r.id === url.pathname.split('/').at(-1));
      return json(res,{assignment:row.id==='scroll-0'?{...row,status:'CANCELLED',endedAt:'2026-11-06 08:31:09'}:{...row,canFinish:true},events:[],eventsTotal:0});
    }
    if(url.pathname === '/v1/admin/operators') return json(res,{operators:[]});
    if(url.pathname.startsWith('/v1/')) return json(res,{});
    const relative = url.pathname.replace(/^\/admin\/?/,'') || 'index.html';
    const file = path.resolve(admin,relative);
    if(!file.startsWith(admin+path.sep)) {res.writeHead(404).end(); return;}
    const data = await readFile(file);
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html':'application/octet-stream');
    res.end(data);
  } catch {res.writeHead(404).end();}
});

(async()=>{
  await mkdir(output,{recursive:true});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const metric=page=>page.locator('#task-recovery').evaluate(el=>({top:el.scrollTop,client:el.clientHeight,scroll:el.scrollHeight,
    overflow:getComputedStyle(el).overflowY,bottom:el.getBoundingClientRect().bottom,viewport:innerHeight,
    docWidth:document.documentElement.scrollWidth,width:innerWidth}));
  const wheel=async(page,dy)=>{
    const box=await page.locator('#task-recovery').boundingBox();
    await page.mouse.move(box.x+Math.min(120,box.width/2),150);
    await page.mouse.wheel(0,dy);
  };
  try {
    for(const [width,height] of [[1440,900],[1280,720],[390,844],[320,640]]) {
      shortList=false;
      const page=await browser.newPage({viewport:{width,height}});
      page.on('pageerror',err=>errors.push(err.message));
      await page.goto(base+'/admin?view=task-recovery');
      await page.locator('.tr-table tbody tr').nth(29).waitFor();
      const before=await metric(page);
      await wheel(page,700);
      let didScroll=true;
      try {await page.waitForFunction(()=>document.querySelector('#task-recovery').scrollTop>0,{},{timeout:1500});}
      catch {didScroll=false;}
      if(!didScroll) {
        await page.screenshot({path:path.join(output,'before-failure-'+width+'.png')});
        await writeFile(path.join(output,'before-failure.json'),JSON.stringify({width,height,before,after:await metric(page)},null,2));
      }
      assert.ok(didScroll,'wheel must scroll the task page: '+JSON.stringify(before));
      await wheel(page,20000);
      await page.waitForFunction(()=>{const el=document.querySelector('#task-recovery');return el.scrollTop+el.clientHeight>=el.scrollHeight-2;});
      await page.locator('[data-tr="next"]').click();
      await page.waitForFunction(()=>document.querySelector('.tr-pagination').textContent.includes('第 2 页'));
      await page.locator('[data-tr="previous"]').click();
      await page.waitForFunction(()=>document.querySelectorAll('.tr-table tbody tr').length===30);
      // Match the screenshot: only three remaining tasks, with a cancelled detail retained below.
      shortList=true;
      await page.locator('[data-tr="refresh"]').click();
      await page.waitForFunction(()=>document.querySelectorAll('.tr-table tbody tr').length===3);
      await page.locator('[data-id="scroll-0"]').click();
      await page.locator('#tr-detail h2').waitFor();
      await wheel(page,20000);
      await page.waitForFunction(()=>{const el=document.querySelector('#task-recovery');return el.scrollTop+el.clientHeight>=el.scrollHeight-2;});
      const bottom=await metric(page);
      const binding=await page.locator('#tr-binding').boundingBox();
      assert.ok(binding.y>=0 && binding.y+binding.height<=height+1,'bottom section must be reachable');
      assert.equal(bottom.docWidth,width,'page must not overflow horizontally');
      assert.ok(bottom.bottom<=height+1,'scroll area must fit the stage');
      await page.screenshot({path:path.join(output,'after-bottom-'+width+'.png')});
      await wheel(page,-20000);
      await page.waitForFunction(()=>document.querySelector('#task-recovery').scrollTop===0);
      const heading=await page.locator('.tr-heading').boundingBox();
      assert.ok(heading.y>=0,'heading must remain reachable after viewing detail');
      await page.locator('[data-id="scroll-1"]').click();
      await page.locator('[data-tr="finish"]').click();
      await page.locator('#tr-reason').fill('隔离检查：不提交处置');
      await page.locator('[data-tr="close-modal"]').click();
      await wheel(page,-20000);
      await page.waitForFunction(()=>document.querySelector('#task-recovery').scrollTop===0);
      await wheel(page,20000);
      await page.waitForFunction(()=>document.querySelector('#task-recovery').scrollTop>0);
      checks.push({width,height,before,bottom,passed:['wheel down/up','long list bottom','list next/previous','three rows + cancelled detail','bottom binding section','no page horizontal overflow','scroll after closing action dialog, no submit']});
      await page.close();
    }
    assert.deepEqual(errors,[]);
    assert.deepEqual(nonGet,[]);
    await writeFile(path.join(output,'browser-qa.json'),JSON.stringify({checks,errors,nonGet,scope:'Current local UI, fictional read-only API, Chromium wheel input; not production acceptance'},null,2));
    console.log('Task recovery scrolling: 4 viewport scenarios passed');
  } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);server.close();process.exitCode=1;});
