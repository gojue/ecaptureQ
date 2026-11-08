// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// Dependency-free smoke test against a running eCaptureQ HTTP server.
// Usage: CHROME_BIN=/path/to/chrome node test/browser-smoke.mjs http://127.0.0.1:28257/
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

const base = new URL(process.argv[2] || 'http://127.0.0.1:28257/');
if (!base.pathname.endsWith('/')) throw new Error('Use the canonical trailing-slash URL');
const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const profile = await mkdtemp(path.join(tmpdir(),'ecaptureq-browser-test-'));
const proc = spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  '--remote-debugging-port=0','--remote-allow-origins=*','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='',launchError;proc.stderr.on('data',data=>stderr+=data);proc.on('error',error=>launchError=error);
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
let ws,nextID=0;const pending=new Map(),listeners=new Map();
function send(method,params={},sessionId) {
  const id=++nextID;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
    pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(error);}});
    ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));
  });
}
async function evaluate(sessionId,expression) {
  const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},sessionId);
  if(result.exceptionDetails)throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function until(sessionId,expression) {
  for(let i=0;i<100;i++){if(await evaluate(sessionId,expression))return;await sleep(100);}
  throw new Error('Browser condition not reached: '+expression);
}
async function click(sessionId,selector){await evaluate(sessionId,`document.querySelector(${JSON.stringify(selector)}).click()`);}
async function createPage(script) {
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);await send('Network.enable',{},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Network.setBlockedURLs',{urls:['*forbidden.invalid*']},sessionId);
  if(script)await send('Page.addScriptToEvaluateOnNewDocument',{source:script},sessionId);
  await send('Page.navigate',{url:base.href},sessionId);
  await until(sessionId,"document.querySelector('#loading')?.hidden && document.querySelectorAll('.request-row').length > 0");
  return sessionId;
}
const exceptions=[];
try {
  let debug;
  for(let i=0;i<100;i++) {
    if(launchError)throw launchError;
    try{debug=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');break;}catch{}
    if(proc.exitCode!==null)throw new Error('Chrome exited: '+stderr.slice(-2000));
    await sleep(100);
  }
  if(!debug)throw new Error('Chrome did not expose DevTools: '+stderr.slice(-2000));
  ws=new WebSocket(`ws://127.0.0.1:${debug[0]}${debug[1]}`);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}
    else {
      if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails);
      listeners.get(message.method)?.(message);
    }
  });
  const session=await createPage();
  assert.equal(await evaluate(session,'document.title'),'eCaptureQ — Protocol Inspector');
  assert.equal(await evaluate(session,"document.querySelector('#github-link').href"),'https://github.com/gojue/ecaptureQ');
  assert.equal(await evaluate(session,"document.querySelectorAll('.request-row').length"),60);
  assert.equal(await evaluate(session,"document.querySelectorAll('.process-item').length"),9);
  assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('#detail-tabs [data-tab]')].map(x=>x.dataset.tab)"),['request','response','connection']);
  assert.ok(await evaluate(session,"document.querySelector('.brand-symbol').complete && document.querySelector('.brand-symbol').naturalWidth > 0"));
  assert.equal(await evaluate(session,"document.querySelector('#detail-splitter').getAttribute('aria-valuenow')"),await evaluate(session,"document.querySelector('#detail-splitter').getAttribute('aria-valuemax')"));
  await click(session,'[data-process="mqtt-agent"]');
  assert.equal(await evaluate(session,"document.querySelector('#active-filters').hidden"),false);
  assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('[data-protocol]')].map(x=>x.dataset.protocol)"),['mqtt']);
  await click(session,'#clear-process');
  for(const protocol of ['http','http3','quic','mysql','redis','mqtt']) {
    await click(session,`[data-protocol="${protocol}"]`);
    assert.ok(await evaluate(session,"document.querySelectorAll('.request-row').length > 0"));
    assert.ok(await evaluate(session,"document.querySelector('#tab-content').textContent.length > 20"));
    await click(session,'#clear-protocol');
  }
  await click(session,'#bookmark-request');await click(session,'[data-scope="starred"]');
  assert.equal(await evaluate(session,"document.querySelectorAll('.request-row').length"),1);
  await click(session,'#clear-filters');
  await click(session,'#theme-toggle');assert.equal(await evaluate(session,'document.documentElement.dataset.theme'),'dark');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-theme')"),'dark');
  await click(session,'#theme-toggle');
  await click(session,'[data-mode="live"]');await until(session,"document.querySelector('[data-mode=live]').getAttribute('aria-pressed')==='true'");
  await click(session,'#capture-toggle');assert.ok(await evaluate(session,"document.querySelector('#capture-toggle').textContent.includes('恢复刷新')"));
  await click(session,'[data-mode="mock"]');await until(session,"document.querySelectorAll('.request-row').length===60");
  const downloads=path.join(profile,'downloads');await mkdir(downloads);
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  await click(session,'#export-data');
  let exported;
  for(let i=0;i<100;i++){try{exported=JSON.parse(await readFile(path.join(downloads,'ecaptureq-demo-session.json'),'utf8'));break;}catch{}await sleep(100);}
  assert.equal(exported?.requests.length,60,'Browser download did not contain the current mock selection');
  const compressed=gzipSync('shared decompression fallback');
  const encoded={headers:[{name:'Content-Encoding',value:'gzip'}],body:compressed.toString('hex'),bodyEncoding:'hex',byteLength:compressed.length};
  const decoded=await evaluate(session,`(async()=>{const mod=await import(new URL('http-body.js',location.href));const native=globalThis.DecompressionStream;globalThis.DecompressionStream=undefined;try{const result=await mod.decodeHTTPBody(${JSON.stringify(encoded)},{fallback:mod.serverInflate});return {state:result.state,body:result.message?.body};}finally{globalThis.DecompressionStream=native;}})()`);
  assert.deepEqual(decoded,{state:'decoded',body:'shared decompression fallback'});
  if(process.env.SMOKE_SCREENSHOT) {
    await mkdir(path.dirname(process.env.SMOKE_SCREENSHOT),{recursive:true});
    const screenshot=await send('Page.captureScreenshot',{format:'png'},session);
    await writeFile(process.env.SMOKE_SCREENSHOT,Buffer.from(screenshot.data,'base64'));
  }
  console.log('PASS UI: mock/live, seven protocol views, filters, bookmarks, theme, logo, default splitter, JSON download, Go decompression fallback, relative resources at '+base.pathname);

  const fixture=JSON.parse(await readFile(new URL('../frontend/mock-data.json',import.meta.url),'utf8'));
  const malicious='<img src="https://forbidden.invalid/pixel" onerror="parent.__captureExecuted=true"><script>parent.__captureExecuted=true</script>';
  const template=fixture.requests.find(r=>r.family==='http' || !r.family);
  const makeRecord=(id,contentType,body)=>({...structuredClone(template),id,path:'/'+id,host:'forbidden.invalid',durationMs:malicious,
    response:{headers:[{name:'Content-Type',value:contentType},{name:'X-Untrusted',value:malicious}],body,bodyEncoding:'utf8',byteLength:Buffer.byteLength(body)},state:'complete',status:200});
  fixture.processes[0].name=malicious;
  fixture.requests=[
    makeRecord('security-html','text/html',`<meta http-equiv="refresh" content="0;url=https://forbidden.invalid/refresh"><style>a{pointer-events:auto}body{background:url(https://forbidden.invalid/css)}</style>${malicious}<a href="https://forbidden.invalid/link">External link</a>`),
    makeRecord('security-svg','image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>parent.__captureExecuted=true</script><image href="https://forbidden.invalid/svg"/><rect width="10" height="10" fill="green"/></svg>')
  ];
  fixture.status={sources:[{id:'source-1',label:'Synthetic source',endpoint:'ws://127.0.0.1:1',state:'connected'}],logs:[{sourceId:'source-1',message:malicious}],state:'connected'};
  fixture.mode='mock';
  const script=`{const fixture=${JSON.stringify(fixture)};const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{const path=new URL(url,location.href).pathname;if(path.endsWith('/api/workspace'))return Promise.resolve(new Response(JSON.stringify(fixture)));if(path.endsWith('/api/status'))return Promise.resolve(new Response(JSON.stringify(fixture.status)));return originalFetch(url,options);};}`;
  const blockedRequests=[];
  listeners.set('Network.requestWillBeSent',message=>{if(message.params.request.url.includes('forbidden.invalid'))blockedRequests.push(message.params.request.url);});
  const security=await createPage(script);
  await click(security,'[data-tab="response"]');
  await until(security,"!!document.querySelector('iframe.preview-frame')");
  assert.equal(await evaluate(security,"document.querySelector('iframe').getAttribute('sandbox')"),'');
  assert.ok(await evaluate(security,"document.querySelector('iframe').inert && getComputedStyle(document.querySelector('iframe')).pointerEvents==='none'"));
  assert.equal(await evaluate(security,"document.querySelector('.header-table').querySelector('img,script')"),null);
  assert.equal(await evaluate(security,'globalThis.__captureExecuted'),undefined);
  await sleep(300);
  await click(security,'[data-request="security-svg"]');await click(security,'[data-tab="response"]');
  await until(security,"document.querySelector('.image-preview img')?.complete");
  assert.ok(await evaluate(security,"document.querySelector('.image-preview img').src.startsWith('blob:')"));
  assert.ok(await evaluate(security,"document.querySelector('.image-preview img').naturalWidth===10"));
  assert.equal(await evaluate(security,"document.querySelector('.image-preview svg')"),null);
  await click(security,'#connection-toggle');
  await evaluate(security,"document.querySelector('#source-log-details').open=true");
  await sleep(1200);
  assert.ok(await evaluate(security,"document.querySelector('#source-log-details').open"));
  assert.equal(await evaluate(security,"document.querySelector('.source-logs').querySelector('img,script')"),null);
  assert.equal(await evaluate(security,'globalThis.__captureExecuted'),undefined);
  assert.deepEqual(blockedRequests,[],'Preview initiated an external request');
  assert.deepEqual(exceptions,[],'Unhandled browser exception');
  console.log('PASS security: escaped fields/logs, inert sandbox HTML, local SVG image, no captured URL requests, logs stay expanded during polling');
} finally {
  if(ws?.readyState===WebSocket.OPEN){try{await send('Browser.close');}catch{}ws.close();}
  proc.kill('SIGTERM');
  if(proc.exitCode===null)await Promise.race([new Promise(resolve=>proc.once('exit',resolve)),sleep(3000)]);
  await rm(profile,{recursive:true,force:true});
}
