// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// Dependency-free smoke test against a running eCaptureQ HTTP server.
// Usage: CHROME_BIN=/path/to/chrome node test/browser-smoke.mjs http://127.0.0.1:28257/
// SMOKE_SOURCE_ENDPOINT may name an unconfigured loopback ws-fixture to exercise
// real source creation; other addresses used for validation are never submitted.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
import {EventEmitter} from 'node:events';
import {navigateDocument} from './browser-navigation.mjs';

const base = new URL(process.argv[2] || 'http://127.0.0.1:28257/');
const authUser = process.env.SMOKE_AUTH_USER, authPassword = process.env.SMOKE_AUTH_PASSWORD;
let authChecked = false;
if (!base.pathname.endsWith('/')) throw new Error('Use the canonical trailing-slash URL');
const sourceFixture = process.env.SMOKE_SOURCE_ENDPOINT ? new URL(process.env.SMOKE_SOURCE_ENDPOINT) : null;
if(sourceFixture) {
  assert.equal(sourceFixture.protocol,'ws:','Source creation must use the local synthetic WebSocket fixture');
  assert.ok(['127.0.0.1','[::1]'].includes(sourceFixture.hostname),'Source creation is restricted to numeric loopback hosts');
  assert.ok(!sourceFixture.username && !sourceFixture.password,'Source fixture must not contain credentials');
}
const chrome = process.env.CHROME_BIN || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : 'google-chrome');
const profile = await mkdtemp(path.join(tmpdir(),'ecaptureq-browser-test-'));
const proc = spawn(chrome,['--headless=new','--disable-gpu','--no-first-run','--no-default-browser-check','--disable-background-networking',
  // Fresh profiles on headless Linux must not wait for an absent desktop secret
  // service before sending their first cookie-bearing request. No user profile
  // or credentials are reused; Chromium's normal process sandbox stays enabled.
  '--password-store=basic',
  '--remote-debugging-port=0','--remote-allow-origins=*','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
let stderr='',launchError;proc.stderr.on('data',data=>stderr+=data);proc.on('error',error=>launchError=error);
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Observe close from launch, including a signal exit or spawn error. Chromium's
// helper processes can keep stdio/profile files open after the parent exits.
const browserClosed=new Promise(resolve=>proc.once('close',resolve));
async function waitForBrowserClose(milliseconds) {
  let timer;
  try {
    return await Promise.race([browserClosed.then(()=>true),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);
  } finally { clearTimeout(timer); }
}
let ws,nextID=0;const pending=new Map(),events=new EventEmitter();
function send(method,params={},sessionId) {
  const id=++nextID;
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('CDP timeout: '+method));},15000);
    pending.set(id,{resolve:result=>{clearTimeout(timer);resolve(result);},reject:error=>{clearTimeout(timer);reject(new Error(`CDP ${method}: ${error.message}`,{cause:error}));}});
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
async function pointerClick(sessionId,selector) {
  const point=await evaluate(sessionId,`(()=>{
    const element=document.querySelector(${JSON.stringify(selector)});
    element.scrollIntoView({block:'nearest',inline:'nearest'});
    const r=element.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
    return {x,y,visible:r.width>0 && r.height>0,hit:element.contains(document.elementFromPoint(x,y))};
  })()`);
  assert.ok(point.visible && point.hit,'Pointer target is hidden or covered: '+selector);
  const {x,y}=point;
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y},sessionId);
  await send('Input.dispatchMouseEvent',{type:'mousePressed',x,y,button:'left',clickCount:1},sessionId);
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x,y,button:'left',clickCount:1},sessionId);
}
async function clearRecordsDialog(sessionId,accept) {
  const handled=new Promise((resolve,reject)=>{
    const onDialog=async message=>{
      if(message.sessionId!==sessionId)return;
      events.off('Page.javascriptDialogOpening',onDialog);
      try {
        await send('Page.handleJavaScriptDialog',{accept},sessionId);
        resolve(message.params.message);
      } catch(error) { reject(error); }
    };
    events.on('Page.javascriptDialogOpening',onDialog);
  });
  await pointerClick(sessionId,'#clear-records');
  return handled;
}
async function pressKey(sessionId,key,windowsVirtualKeyCode) {
  await send('Input.dispatchKeyEvent',{type:'keyDown',key,code:key,windowsVirtualKeyCode,...(key==='Enter'?{text:'\r',unmodifiedText:'\r'}:{})},sessionId);
  await send('Input.dispatchKeyEvent',{type:'keyUp',key,code:key,windowsVirtualKeyCode},sessionId);
}
async function editText(sessionId,selector,value) {
  await evaluate(sessionId,`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.focus();input.select();})()`);
  await pressKey(sessionId,'Backspace',8);
  if(value)await send('Input.insertText',{text:value},sessionId);
  assert.equal(await evaluate(sessionId,`document.querySelector(${JSON.stringify(selector)}).value`),value);
}
async function language(sessionId, value) {
  if (await evaluate(sessionId,'document.documentElement.lang') === value) return;
  await pointerClick(sessionId,'#language-toggle');
  await until(sessionId,`document.documentElement.lang===${JSON.stringify(value)}`);
}
async function theme(sessionId, value) {
  if (await evaluate(sessionId,'document.documentElement.dataset.theme') !== value) await click(sessionId,'#theme-toggle');
  assert.equal(await evaluate(sessionId,'document.documentElement.dataset.theme'),value);
}
async function screenshot(sessionId, name) {
  if (!process.env.SMOKE_ARTIFACT_DIR) return;
  await until(sessionId,"document.querySelector('#toast')?.hidden !== false");
  const file=path.join(process.env.SMOKE_ARTIFACT_DIR,name+'.png');
  await mkdir(path.dirname(file),{recursive:true});
  const shot=await send('Page.captureScreenshot',{format:'png'},sessionId);
  await writeFile(file,Buffer.from(shot.data,'base64'));
}
const uiStateExpression=`({
  selected:document.querySelector('.request-row.selected')?.dataset.request,
  process:document.querySelector('.process-item.active')?.dataset.process,
  protocol:document.querySelector('.protocol-filter.active')?.dataset.protocol,
  scope:document.querySelector('.nav-item.active')?.dataset.scope,
  filter:document.querySelector('.filter-chip.active')?.dataset.filter,
  query:document.querySelector('#request-search').value,
  bookmarks:document.querySelector('#starred-count').textContent,
  tab:document.querySelector('#detail-tabs [aria-selected=true]')?.dataset.tab,
  viewer:document.querySelector('[data-viewer].active')?.dataset.viewer,
  bodySource:document.querySelector('[data-body-source].active')?.dataset.bodySource,
  capturePressed:document.querySelector('#capture-toggle').getAttribute('aria-pressed'),
  sourceValues:[...document.querySelectorAll('#add-source-form input,#add-source-form textarea,#add-source-form select')].map(x=>x.value)
})`;
async function assertNoUIOverflow(sessionId) {
  const overflows=await evaluate(sessionId,`[...document.querySelectorAll('.application,.workspace,.requests-pane,.detail-pane,.app-header,.app-toolbar,.filter-row,.connection-fields,.source-form')].filter(x=>x.getClientRects().length && x.scrollWidth>x.clientWidth+2).map(x=>x.className)`);
  assert.deepEqual(overflows,[],'UI horizontal overflow');
}
async function assertEnglishLabels(sessionId) {
  // Called only for bundled mock views: their known generated summaries are UI
  // text. Captured payloads and the injected raw identity/security fixtures are
  // deliberately excluded from this translation check.
  const untranslated=await evaluate(sessionId,`[...document.querySelectorAll('.row-path,.pv-heading,.pv-fields dt,.pv-notice strong,.pv-footnote,.connection-heading,.detail-tabs,.section-heading,.empty-body,#mode-label,#status-message,#scope-title,.source-intro,#connection-title')].filter(x=>x.getClientRects().length && /[\\u3400-\\u9fff]/.test(x.textContent)).map(x=>x.textContent.trim())`);
  assert.deepEqual(untranslated,[],'Untranslated English UI labels');
}
async function dimensions(sessionId) {
  return evaluate(sessionId,`Object.fromEntries([['workspace','#workspace'],['sidebar','#sidebar'],['list','.requests-pane'],['detail','#detail-pane']].map(([key,selector])=>[key,document.querySelector(selector).getBoundingClientRect().width]))`);
}
async function resize(sessionId,width) {
  await send('Emulation.setDeviceMetricsOverride',{width,height:980,deviceScaleFactor:1,mobile:false},sessionId);
  await sleep(100);
}
async function reload(sessionId) {
  await evaluate(sessionId,'globalThis.__smokeReloadMarker=true');
  await navigateDocument({send,events,sessionId,trigger:()=>send('Page.reload',{},sessionId)});
  await until(sessionId,"!globalThis.__smokeReloadMarker && document.querySelector('#loading')?.hidden && document.querySelectorAll('.request-row').length > 0");
}
async function createPage(script) {
  const {targetId}=await send('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
  await send('Runtime.enable',{},sessionId);await send('Page.enable',{},sessionId);await send('Network.enable',{},sessionId);
  await send('Emulation.setDeviceMetricsOverride',{width:1440,height:980,deviceScaleFactor:1,mobile:false},sessionId);
  await send('Emulation.setLocaleOverride',{locale:'zh-CN'},sessionId);
  await send('Page.addScriptToEvaluateOnNewDocument',{source:"Object.defineProperty(navigator,'language',{value:'zh-CN'});Object.defineProperty(navigator,'languages',{value:['zh-CN','zh']});"},sessionId);
  await send('Network.setBlockedURLs',{urls:['*forbidden.invalid*']},sessionId);
  if(script)await send('Page.addScriptToEvaluateOnNewDocument',{source:script},sessionId);
  await navigateDocument({send,events,sessionId,trigger:()=>send('Page.navigate',{url:base.href},sessionId)});
  if(authUser) {
    await until(sessionId,"!!document.querySelector('#login-form') || (document.querySelector('#loading')?.hidden && document.querySelectorAll('.request-row').length > 0)");
    if(await evaluate(sessionId,"!!document.querySelector('#login-form')")) {
      assert.equal(await evaluate(sessionId,"document.querySelector('#login-form').method"),'post','Login fallback must not put credentials in the URL');
      if(!authChecked) {
        for(const route of ['api/workspace','api/record?id=missing','api/changes','api/config','api/status']) {
          const denied = await fetch(new URL(route,base));
          await denied.text(); // Release Node's HTTP response before browser cleanup.
          assert.equal(denied.status,401,'Anonymous API access: '+route);
        }
        await resize(sessionId,390);
        assert.ok(await evaluate(sessionId,'document.documentElement.scrollWidth<=innerWidth'),'Login page overflows on mobile');
        await screenshot(sessionId,'login-mobile');
        await resize(sessionId,1440);
        await editText(sessionId,'#username',authUser);
        await editText(sessionId,'#password','incorrect-synthetic-password');
        await pointerClick(sessionId,'#login-submit');
        await until(sessionId,"!document.querySelector('#login-error').hidden && !document.querySelector('#login-submit').disabled");
        assert.match(await evaluate(sessionId,"document.querySelector('#login-error').textContent"),/错误|Incorrect/);
        authChecked=true;
      }
      await editText(sessionId,'#username',authUser);
      await editText(sessionId,'#password',authPassword);
      await navigateDocument({send,events,sessionId,trigger:()=>pointerClick(sessionId,'#login-submit')});
    }
  }
  await until(sessionId,"document.querySelector('#loading')?.hidden && document.querySelectorAll('.request-row').length > 0");
  return sessionId;
}
const exceptions=[], networkDiagnostics=[];
try {
  let debug;
  // Cold CI runners can take more than ten seconds to launch Chrome. Keep this
  // readiness deadline separate from the page assertions and CDP timeouts.
  const startupTimeout=60000, startupDeadline=performance.now()+startupTimeout;
  while(performance.now()<startupDeadline) {
    if(launchError)throw launchError;
    if(proc.exitCode!==null || proc.signalCode!==null)throw new Error(`Chrome exited (code=${proc.exitCode}, signal=${proc.signalCode}): ${stderr.slice(-2000)}`);
    try {
      const candidate=(await readFile(path.join(profile,'DevToolsActivePort'),'utf8')).trim().split('\n');
      // The file can be observed before Chrome finishes writing both lines.
      if(/^\d+$/.test(candidate[0]) && candidate[1]?.startsWith('/devtools/browser/')){debug=candidate;break;}
    } catch(error) { if(error.code!=='ENOENT')throw error; }
    await sleep(100);
  }
  if(!debug)throw new Error(`Chrome did not expose DevTools within ${startupTimeout/1000}s (code=${proc.exitCode}, signal=${proc.signalCode}): ${stderr.slice(-2000) || '(no Chrome stderr)'}`);
  ws=new WebSocket(`ws://127.0.0.1:${debug[0]}${debug[1]}`);
  await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  ws.addEventListener('message',event=>{
    const message=JSON.parse(event.data);
    if(message.id){const item=pending.get(message.id);if(!item)return;pending.delete(message.id);message.error?item.reject(new Error(message.error.message)):item.resolve(message.result);}
    else {
      if(message.method==='Runtime.exceptionThrown')exceptions.push(message.params.exceptionDetails);
      if(['Network.requestWillBeSent','Network.loadingFailed','Page.frameNavigated'].includes(message.method)){networkDiagnostics.push({method:message.method,session:message.sessionId,url:message.params.request?.url || message.params.frame?.url,error:message.params.errorText});if(networkDiagnostics.length>24)networkDiagnostics.shift();}
      events.emit(message.method,message);
    }
  });
  const session=await createPage();
  assert.equal(await evaluate(session,'navigator.language'),'zh-CN');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN','First visit must follow the Chinese system language');
  assert.equal(await evaluate(session,'document.title'),'eCaptureQ — 协议检查器');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),null,'Automatic language detection must not save a manual preference');
  assert.equal(await evaluate(session,"document.querySelector('#language-menu')"),null);
  assert.equal(await evaluate(session,"document.querySelector('#language-toggle').getAttribute('aria-haspopup')"),null);
  await screenshot(session,'overview-auto-zh-light');
  const beforeExplicitLanguage=await evaluate(session,uiStateExpression);
  const unrelatedStorage=await evaluate(session,"Object.fromEntries(Object.entries(localStorage).filter(([key])=>key!=='ecaptureq-language'))");
  await pointerClick(session,'#language-toggle');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'en','One click must switch directly to English');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'en');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforeExplicitLanguage,'Language switching changed the UI state');
  assert.deepEqual(await evaluate(session,"Object.fromEntries(Object.entries(localStorage).filter(([key])=>key!=='ecaptureq-language'))"),unrelatedStorage,'Language switching changed unrelated preferences');
  await reload(session);
  assert.equal(await evaluate(session,'navigator.language'),'zh-CN');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'en','The saved English preference must override Chinese system language after reload');
  console.log('PASS initial language: Chinese system detected without saving; one-click toggle saves; manual English overrides system after refresh');
  assert.equal(await evaluate(session,'document.title'),'eCaptureQ — Protocol Inspector');
  assert.equal(await evaluate(session,"document.querySelector('#github-link').href"),'https://github.com/gojue/ecaptureQ');
  const appVersion=await evaluate(session,"(async()=>{const response=await fetch('api/version');if(!response.ok)throw new Error('Version API failed');return (await response.json()).version;})()");
  const expectedVersion=`eCaptureQ v${appVersion.replace(/^v/,'')}`;
  await until(session,`document.querySelector('#app-version').textContent===${JSON.stringify(expectedVersion)}`);
  for(const width of [1219,390]) {
    await resize(session,width);
    const position=await evaluate(session,"(()=>{const version=document.querySelector('#app-version'),r=version.getBoundingClientRect();return {text:version.textContent,left:r.left,right:r.right,width:r.width,height:r.height,center:r.left+r.width/2,viewport:innerWidth};})()");
    assert.equal(position.text,expectedVersion);
    assert.ok(position.width>0 && position.height>0 && position.left>=0 && position.right<=width,'Application version is not visible');
    assert.ok(Math.abs(position.center-position.viewport/2)<1,'Application version must remain at the viewport center');
  }
  await resize(session,1440);
  console.log('PASS footer: running version matches API and stays centered at desktop and narrow widths');
  assert.equal(await evaluate(session,"document.querySelectorAll('.request-row').length"),60);
  assert.equal(await evaluate(session,"document.querySelectorAll('.process-item').length"),9);
  assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('#detail-tabs [data-tab]')].map(x=>x.dataset.tab)"),['request','response','connection']);
  assert.ok(await evaluate(session,"document.querySelector('.brand-symbol').complete && document.querySelector('.brand-symbol').naturalWidth > 0"));
  await assertEnglishLabels(session);
  const original=await dimensions(session);
  assert.equal(original.sidebar,218);
  assert.ok(Math.abs(original.list-494*0.6)<1,JSON.stringify(original));
  assert.ok(Math.abs(original.detail-917.6)<1,JSON.stringify(original));
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-layout-v1')"),null,'Default layout must not persist a window-specific size');
  await screenshot(session,'overview-en-light');
  const beforePointerLanguage=await evaluate(session,uiStateExpression);
  await pointerClick(session,'#language-toggle');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN');
  assert.equal(await evaluate(session,"document.querySelector('#language-toggle').title"),'切换为English');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforePointerLanguage,'Pointer language switching changed the UI state');
  await pointerClick(session,'#language-toggle');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'en');
  assert.equal(await evaluate(session,"document.querySelector('#language-toggle').getAttribute('aria-label')"),'Switch to 简体中文');
  await pressKey(session,'Enter',13);
  await until(session,"document.documentElement.lang==='zh-CN'");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:' ',code:'Space',windowsVirtualKeyCode:32},session);
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:' ',code:'Space',windowsVirtualKeyCode:32},session);
  await until(session,"document.documentElement.lang==='en'");
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'en');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforePointerLanguage,'Keyboard language switching changed the UI state');
  await pressKey(session,'Tab',9);
  assert.equal(await evaluate(session,'document.activeElement.id'),'theme-toggle');
  console.log('PASS language toggle: direct Chinese/English clicks, Enter, Space, focus order and preserved UI state');
  await click(session,'[data-process="mqtt-agent"]');
  assert.equal(await evaluate(session,"document.querySelector('#active-filters').hidden"),false);
  assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('[data-protocol]')].map(x=>x.dataset.protocol)"),['mqtt']);
  await click(session,'#clear-process');
  // Exercise both locales and themes in every existing protocol viewer.
  for(const locale of ['en','zh-CN']) for(const appearance of ['light','dark']) {
    await language(session,locale);await theme(session,appearance);
    for(const protocol of ['http','http3','quic','mysql','redis','mqtt']) {
      await click(session,`[data-protocol="${protocol}"]`);
      assert.ok(await evaluate(session,"document.querySelectorAll('.request-row').length > 0"));
      assert.ok(await evaluate(session,"document.querySelector('#tab-content').textContent.length > 20"));
      if(locale==='en')await assertEnglishLabels(session);
      await assertNoUIOverflow(session);
      await screenshot(session,`protocols/${protocol}-${locale==='en'?'en':'zh'}-${appearance}`);
      if(protocol==='http') {
        const http1=await evaluate(session,"[...document.querySelectorAll('.request-row')].find(row=>row.querySelector('.inline-protocol')?.textContent==='HTTP/1.1')?.dataset.request");
        assert.ok(http1,'The mock HTTP/1.1 fixture is missing');
        await click(session,`[data-request="${http1}"]`);
        if(locale==='en')await assertEnglishLabels(session);
        await assertNoUIOverflow(session);
        await screenshot(session,`protocols/http1-${locale==='en'?'en':'zh'}-${appearance}`);
      }
      await click(session,'#clear-protocol');
    }
  }
  await language(session,'en');await theme(session,'light');
  await click(session,'[data-protocol="http"]');
  await click(session,'[data-process="checkout-api"]');
  await click(session,'#bookmark-request');
  const processID=await evaluate(session,"document.querySelector('.request-row.selected').dataset.request");
  await evaluate(session,"document.querySelector('#request-search').value='example';document.querySelector('#request-search').dispatchEvent(new Event('input',{bubbles:true}))");
  await click(session,'[data-tab="response"]');
  await click(session,'[data-viewer="hex"]');
  const preserved=await evaluate(session,uiStateExpression);
  assert.equal(preserved.selected,processID);
  assert.equal(preserved.process,'checkout-api');
  const payloadBefore=await evaluate(session,"JSON.stringify([document.querySelector('#detail-url').textContent,document.querySelector('.code-window')?.textContent])");
  await language(session,'zh-CN');
  assert.deepEqual(await evaluate(session,uiStateExpression),preserved,'Language switching changed filters, selection, bookmarks or viewer');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'zh-CN');
  assert.equal(await evaluate(session,"JSON.stringify([document.querySelector('#detail-url').textContent,document.querySelector('.code-window')?.textContent])"),payloadBefore,'Captured content was translated');
  await click(session,'[data-tab="connection"]');
  await theme(session,'dark');await screenshot(session,'connection-zh-dark');
  await language(session,'en');await theme(session,'light');
  await click(session,'#clear-filters');await click(session,'[data-scope="starred"]');
  assert.equal(await evaluate(session,"document.querySelectorAll('.request-row').length"),1);
  await click(session,'#clear-filters');
  // Connection settings are user input; collector metadata must arrive upstream.
  await click(session,'#connection-toggle');await click(session,'#add-source-toggle');
  assert.equal(await evaluate(session,"document.querySelectorAll('#source-host,#source-module,#source-command').length"),0,'Collector metadata must not be manually entered');
  assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('#add-source-form [name]')].map(input=>input.name).sort()"),['endpoint','label']);
  const requiredValidation=await evaluate(session,"(()=>{const input=document.querySelector('#source-endpoint');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return {valid:input.checkValidity(),message:input.validationMessage};})()");
  assert.equal(requiredValidation.valid,false);
  assert.match(requiredValidation.message,/WebSocket/i);
  assert.doesNotMatch(requiredValidation.message,/[\u3400-\u9fff]/,'Required endpoint validation ignored English UI language');
  const sourceFieldValues=`Object.fromEntries(['label','endpoint'].map(name=>[name,document.querySelector('#source-'+name).value]))`;
  const sourceControlGeometry=`Object.fromEntries(['label','endpoint'].map(name=>{const r=document.querySelector('#source-'+name).getBoundingClientRect();return [name,{top:r.top,height:r.height,left:r.left,right:r.right,width:r.width}];}))`;
  for(const endpoint of ['ws://192.0.2.10:28257/','ws://[2001:db8::10]:28257/','wss://collector.example.invalid/custom-subscription']) {
    await editText(session,'#source-endpoint',endpoint);
    assert.equal(await evaluate(session,"document.querySelector('#source-endpoint').checkValidity()"),true,'Valid WebSocket endpoint was rejected');
  }
  await editText(session,'#source-label','Synthetic draft');
  const formValues=await evaluate(session,uiStateExpression);
  await evaluate(session,"document.querySelector('#connection-dialog').scrollTop=0");
  await screenshot(session,'sources-en-light');
  await click(session,'#close-connection');await language(session,'zh-CN');await theme(session,'dark');
  await click(session,'#connection-toggle');
  assert.deepEqual((await evaluate(session,uiStateExpression)).sourceValues,formValues.sourceValues,'Reopening or translating cleared the source draft');
  await screenshot(session,'sources-zh-dark');await assertNoUIOverflow(session);
  const draft=await evaluate(session,sourceFieldValues);
  await pointerClick(session,'#cancel-add-source');await pointerClick(session,'#add-source-toggle');
  assert.deepEqual(await evaluate(session,sourceFieldValues),draft,'Cancel/reopen cleared the source draft');
  const invalidValidation=await evaluate(session,"(()=>{const input=document.querySelector('#source-endpoint');input.value='not-an-endpoint';input.dispatchEvent(new Event('input',{bubbles:true}));return {valid:input.checkValidity(),message:input.validationMessage};})()");
  assert.equal(invalidValidation.valid,false);
  assert.match(invalidValidation.message,/有效/,'Invalid endpoint validation ignored Chinese UI language');
  await click(session,'#close-connection');await language(session,'en');await theme(session,'light');
  await click(session,'#connection-toggle');
  const translatedValidation=await evaluate(session,"document.querySelector('#source-endpoint').validationMessage");
  assert.match(translatedValidation,/valid/i);
  assert.doesNotMatch(translatedValidation,/[\u3400-\u9fff]/,'Existing validation message did not switch language');
  await editText(session,'#source-endpoint','ws://127.0.0.1:28359/');
  for(const appearance of ['light','dark']) {
    await click(session,'#close-connection');await theme(session,appearance);await resize(session,390);
    await click(session,'#connection-toggle');
    const controls=await evaluate(session,sourceControlGeometry);
    assert.ok(Object.values(controls).every(r=>r.height>=32 && r.width>=100 && r.left>=0 && r.right<=390),'Narrow source controls are not usable');
    await assertNoUIOverflow(session);
    await evaluate(session,"document.querySelector('#connection-dialog').scrollTop=0");
    await screenshot(session,`source-form-narrow-en-${appearance}`);
    const narrowSubmit=await evaluate(session,`(()=>{const button=document.querySelector('#submit-source');button.scrollIntoView({block:'nearest'});const r=button.getBoundingClientRect();return {width:r.width,height:r.height,visible:r.top>=0 && r.bottom<=innerHeight,hit:button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)),disabled:button.disabled};})()`);
    assert.ok(narrowSubmit.width>=32 && narrowSubmit.height>=24 && narrowSubmit.visible && narrowSubmit.hit && !narrowSubmit.disabled,'Narrow form submission button is not reachable by scrolling');
    await screenshot(session,`source-form-narrow-actions-en-${appearance}`);
  }
  await click(session,'#close-connection');await resize(session,1440);await theme(session,'light');
  await click(session,'#connection-toggle');
  await evaluate(session,"document.querySelector('#add-source-form').reset()");
  assert.deepEqual(await evaluate(session,sourceFieldValues),{label:'',endpoint:''},'Reset did not clear the source draft');
  if(sourceFixture) {
    await editText(session,'#source-label','Synthetic connected source');
    await editText(session,'#source-endpoint',sourceFixture.href);
    await evaluate(session,"document.querySelector('#connection-dialog').scrollTop=0");
    await screenshot(session,'source-form-en-light');
    await pointerClick(session,'#submit-source');
    await until(session,"document.querySelector('#add-source-form').hidden");
    await until(session,`(async()=>{const status=await(await fetch('api/status')).json();return status.sources.some(source=>source.endpoint===${JSON.stringify(sourceFixture.href)} && source.state==='connected' && source.events>0);})()`);
    const addedSource=await evaluate(session,`(async()=>{const status=await(await fetch('api/status')).json();return status.sources.find(source=>source.endpoint===${JSON.stringify(sourceFixture.href)});})()`);
    assert.equal(addedSource.label,'Synthetic connected source');
    assert.equal(addedSource.endpoint,sourceFixture.href);
    await pointerClick(session,'#add-source-toggle');
    assert.deepEqual(await evaluate(session,sourceFieldValues),{label:'',endpoint:''},'Successful submission did not reset the draft');
    const card=`[data-source-id="${addedSource.id}"]`;
    await until(session,`!!document.querySelector(${JSON.stringify(card)})`);
    await click(session,card+' [data-source-details]>summary');
    assert.ok(await evaluate(session,`document.querySelector(${JSON.stringify(card+' [data-source-details]')}).open`));
    await click(session,card+' .source-menu>summary');
    await click(session,card+' [data-source-action="edit"]');
    assert.deepEqual(await evaluate(session,sourceFieldValues),{label:addedSource.label,endpoint:sourceFixture.href});
    await editText(session,'#source-label','Renamed synthetic source');
    await pointerClick(session,'#submit-source');
    await until(session,"document.querySelector('#add-source-form').hidden");
    await until(session,`document.querySelector(${JSON.stringify(card+' strong')})?.textContent==='Renamed synthetic source'`);
    const before=await evaluate(session,`(async()=>{return (await(await fetch('api/status')).json()).sources.find(s=>s.id===${JSON.stringify(addedSource.id)}).generation;})()`);
    await click(session,card+' .source-menu>summary');
    await click(session,card+' [data-source-action="reconnect"]');
    await until(session,`(async()=>{return (await(await fetch('api/status')).json()).sources.some(s=>s.id===${JSON.stringify(addedSource.id)}&&s.generation>${before});})()`);
    await click(session,card+' .source-menu>summary');
    await send('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27},session);
    assert.ok(await evaluate(session,`document.querySelector('#connection-dialog').open && !document.querySelector(${JSON.stringify(card+' .source-menu')}).open`),'Escape must close the menu before the dialog');
    const confirmation=new Promise(resolve=>events.once('Page.javascriptDialogOpening',async()=>{await send('Page.handleJavaScriptDialog',{accept:true},session);resolve();}));
    await click(session,card+' .source-menu>summary');
    await click(session,card+' [data-source-action="remove"]');
    await confirmation;
    await until(session,`!document.querySelector(${JSON.stringify(card)})`);
    assert.ok(await evaluate(session,"document.querySelectorAll('.source-card').length>0"),'Removing one source removed other sources');
    console.log('PASS source management: add, expand details, edit, reconnect, Escape menu handling, remove; other sources retained');
  }
  await evaluate(session,"document.querySelector('#add-source-form').reset()");
  await click(session,'#close-connection');
  console.log('PASS source form: required/invalid URLs, localized validation, draft persistence, reset and narrow light/dark actions');
  // A language change does not stop the simulation timer.
  await click(session,'#capture-toggle');
  const runningCount=await evaluate(session,"document.querySelectorAll('.request-row').length");
  await language(session,'zh-CN');
  assert.equal(await evaluate(session,"document.querySelector('#capture-toggle').getAttribute('aria-pressed')"),'true');
  await until(session,`document.querySelectorAll('.request-row').length>${runningCount}`);
  await click(session,'#capture-toggle');await click(session,'#reset-demo');
  await language(session,'en');
  await click(session,'[data-mode="live"]');await until(session,"document.querySelector('[data-mode=live]').getAttribute('aria-pressed')==='true'");
  await evaluate(session,`(()=>{const original=globalThis.fetch;globalThis.__workspaceFetches=0;globalThis.fetch=(url,options)=>{if(new URL(url,location.href).pathname.endsWith('/api/workspace'))globalThis.__workspaceFetches++;return original(url,options);};})()`);
  if(!process.env.SMOKE_REQUIRE_LIVE && !sourceFixture) {
    await sleep(1200);
    await evaluate(session,'globalThis.__workspaceFetches=0');
    await sleep(2200);
    assert.equal(await evaluate(session,'globalThis.__workspaceFetches'),0,'Idle live page still polls workspace');
  }
  if(process.env.SMOKE_REQUIRE_LIVE) {
    await until(session,"document.querySelectorAll('.request-row').length>0 && document.querySelector('#connection-toggle').dataset.state==='connected'");
    const firstLiveID=await evaluate(session,"document.querySelector('.request-row').dataset.request");
    await until(session,`document.querySelector('.request-row')?.dataset.request!==${JSON.stringify(firstLiveID)}`);
    const livePair=await evaluate(session,`(async()=>{
      const page=await (await fetch('api/workspace?mode=live&view=page')).json();
      for(const row of page.requests.slice(0,20)) {
        const record=await (await fetch('api/record?id='+encodeURIComponent(row.id))).json();
        if(record.request && record.response && record.processCommand && record.metadata?.tls) return record;
      }
      return null;
    })()`);
    assert.ok(livePair,'Synthetic live source did not produce a paired message with process command and TLS');
    await click(session,`[data-process="${livePair.processId}"]`);
    await until(session,`document.querySelector('.process-item.active')?.dataset.process===${JSON.stringify(livePair.processId)} && !!document.querySelector('[data-request="${livePair.id}"]')`);
    await click(session,`[data-request="${livePair.id}"]`);await click(session,'[data-tab="connection"]');
    await until(session,"!!document.querySelector('.connection-fields')");
    assert.ok(await evaluate(session,`document.querySelector('#tab-content').textContent.includes(${JSON.stringify(livePair.processCommand)})`),'Live process command was not preserved');
    assert.equal(await evaluate(session,"document.querySelector('.observed-process')"),null,'Single local process must not invent a second endpoint process');
    assert.ok(await evaluate(session,`document.querySelector('.tls-context').textContent.includes(${JSON.stringify(livePair.metadata.tls.version)})`),'Live TLS context was not preserved');
    await screenshot(session,'live-synthetic-en-light');
    for(const side of ['request','response']) {
      await click(session,`[data-tab="${side}"]`);
      const expectedHeader=livePair[side].headers.find(header=>header.name.toLowerCase()==='x-synthetic-fixture');
      assert.ok(expectedHeader,'Synthetic pairing marker is missing');
      assert.ok(await evaluate(session,`[...document.querySelectorAll('.header-pair')].some(row=>row.textContent.toLowerCase().includes('x-synthetic-fixture') && row.textContent.includes(${JSON.stringify(expectedHeader.value)}))`),`Paired ${side} did not remain available after process filtering`);
    }
  }
  await click(session,'#capture-toggle');
  assert.equal(await evaluate(session,"document.querySelector('#capture-toggle').getAttribute('aria-pressed')"),'true');
  await language(session,'zh-CN');
  assert.ok(await evaluate(session,"document.querySelector('#capture-toggle').textContent.includes('恢复刷新')"));
  assert.equal(await evaluate(session,"document.querySelector('#capture-toggle').getAttribute('aria-pressed')"),'true','Language change resumed paused live refresh');
  await language(session,'en');
  assert.ok(await evaluate(session,"/resume/i.test(document.querySelector('#capture-toggle').textContent)"));
  await sleep(1200); // Let any request already in flight at pause finish.
  await evaluate(session,'globalThis.__workspaceFetches=0');
  await sleep(2200);
  assert.equal(await evaluate(session,'globalThis.__workspaceFetches'),0,'Paused page fetched workspace');
  if(process.env.SMOKE_REQUIRE_LIVE) {
    // Exercise the real Store through the UI. Only the explicit failure case is
    // intercepted; the successful clear and subsequent ingestion use the API.
    const bookmarkedID=await evaluate(session,"document.querySelector('.request-row.selected').dataset.request");
    await click(session,'#bookmark-request');
    await until(session,`document.querySelector('#starred-count').textContent==='1' && !!document.querySelector('[data-request="${bookmarkedID}"] .row-index use[href="#i-star"]')`);
    await click(session,`[data-request="${bookmarkedID}"]`);
    await until(session,"document.querySelector('#starred-count').textContent==='1' && document.querySelector('#bookmark-request').getAttribute('aria-pressed')==='true'");
    await evaluate(session,`(()=>{
      const original=globalThis.fetch;
      globalThis.__clearRequests=[];globalThis.__rejectClear=false;
      globalThis.fetch=(url,options)=>{
        if(new URL(url,location.href).pathname.endsWith('/api/records/clear')) {
          globalThis.__clearRequests.push({method:options?.method,header:new Headers(options?.headers).get('X-Ecapture-UI')});
          if(globalThis.__rejectClear)return Promise.resolve(new Response(JSON.stringify({error:'service_stopping'}),{status:503,headers:{'Content-Type':'application/json'}}));
        }
        return original(url,options);
      };
    })()`);
    const beforeClear=await evaluate(session,`({
      ids:[...document.querySelectorAll('.request-row')].map(row=>row.dataset.request),
      selected:document.querySelector('.request-row.selected')?.dataset.request,
      bookmarks:document.querySelector('#starred-count').textContent,
      filters:[...document.querySelectorAll('[data-clear-filter]')].map(button=>button.dataset.clearFilter),
      query:document.querySelector('#request-search').value
    })`);
    assert.ok(beforeClear.ids.length>0,'Clear regression needs retained synthetic records');
    for(const width of [1440,390]) {
      await resize(session,width);
      await assertNoUIOverflow(session);
      assert.ok(await evaluate(session,"(()=>{const button=document.querySelector('#clear-records'),r=button.getBoundingClientRect();return !button.hidden && !button.disabled && r.width>=20 && r.height>=20 && r.left>=0 && r.right<=innerWidth && button.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));})()"),'Clear action is unavailable at width '+width);
    }
    await language(session,'zh-CN');
    assert.match(await evaluate(session,"document.querySelector('#clear-records').getAttribute('aria-label')"),/清空/);
    const canceledMessage=await clearRecordsDialog(session,false);
    assert.match(canceledMessage,/清空/);
    assert.equal(await evaluate(session,'globalThis.__clearRequests.length'),0,'Cancel sent a clear request');
    assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('.request-row')].map(row=>row.dataset.request)"),beforeClear.ids,'Cancel changed the retained view');
    await language(session,'en');
    assert.match(await evaluate(session,"document.querySelector('#clear-records').getAttribute('aria-label')"),/clear/i);
    await evaluate(session,'globalThis.__rejectClear=true');
    const failedMessage=await clearRecordsDialog(session,true);
    assert.match(failedMessage,/clear/i);
    await until(session,"globalThis.__clearRequests.length===1 && !document.querySelector('#clear-records').disabled && !document.querySelector('#toast').hidden");
    assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('.request-row')].map(row=>row.dataset.request)"),beforeClear.ids,'Failed clear discarded the displayed records');
    assert.equal(await evaluate(session,"document.querySelector('.request-row.selected')?.dataset.request"),beforeClear.selected,'Failed clear discarded the selection');
    assert.equal(await evaluate(session,"document.querySelector('#starred-count').textContent"),beforeClear.bookmarks,'Failed clear discarded bookmarks');
    await resize(session,1440);
    const retainedBefore=await evaluate(session,"(async()=>{const workspace=await(await fetch('api/workspace?mode=live')).json();return {ids:workspace.requests.map(row=>row.id),sources:workspace.status.sources.map(source=>({id:source.id,endpoint:source.endpoint})),artifacts:(workspace.status.artifacts||[]).map(artifact=>artifact.id)};})()");
    await evaluate(session,'globalThis.__rejectClear=false');
    await clearRecordsDialog(session,true);
    await until(session,"globalThis.__clearRequests.length===2 && document.querySelectorAll('.request-row').length===0 && document.querySelector('#detail-view').hidden && document.querySelector('#starred-count').textContent==='0'");
    assert.deepEqual(await evaluate(session,'globalThis.__clearRequests'),[{method:'POST',header:'1'},{method:'POST',header:'1'}]);
    assert.equal(await evaluate(session,"document.querySelector('#capture-toggle').getAttribute('aria-pressed')"),'true','Clear resumed a paused page');
    assert.equal(await evaluate(session,"document.querySelector('#page-prev').disabled"),true,'Clear kept the old page index');
    assert.equal(await evaluate(session,"document.querySelector('#request-search').value"),beforeClear.query,'Clear changed the search');
    assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('[data-clear-filter]')].map(button=>button.dataset.clearFilter)"),beforeClear.filters,'Clear changed filters');
    const afterClear=await evaluate(session,`(async()=>{
      const workspace=await(await fetch('api/workspace?mode=live')).json();
      const oldIDs=${JSON.stringify(retainedBefore.ids)};
      return {oldRetained:workspace.requests.filter(row=>oldIDs.includes(row.id)).map(row=>row.id),
        detailStatus:(await fetch('api/record?id='+encodeURIComponent(${JSON.stringify(beforeClear.selected)}))).status,
        sources:workspace.status.sources.map(source=>({id:source.id,endpoint:source.endpoint})),
        artifacts:(workspace.status.artifacts||[]).map(artifact=>artifact.id)};
    })()`);
    assert.deepEqual(afterClear.oldRetained,[],'Clear only hid records or applied the current filter');
    assert.equal(afterClear.detailStatus,404,'Cleared record detail is still retrievable');
    assert.deepEqual(afterClear.sources,retainedBefore.sources,'Clear changed source connections');
    assert.ok(retainedBefore.artifacts.every(id=>afterClear.artifacts.includes(id)),'Clear removed native files');
    await until(session,"(async()=>{const page=await(await fetch('api/workspace?mode=live&view=page')).json();return page.requests.length>0 && page.status.sources.some(source=>source.state==='connected');})()");
    assert.equal(await evaluate(session,"document.querySelectorAll('.request-row').length"),0,'New data appeared while the cleared page was paused');
    await evaluate(session,'globalThis.__workspaceFetches=0');
    console.log('PASS clear records: wide/narrow action, translations, cancel, failure retention, full Store clear, detail 404, paused view, sources/native files retained and continued ingestion');
  }
  await click(session,'#capture-toggle');
  await until(session,'globalThis.__workspaceFetches>0');
  if(process.env.SMOKE_REQUIRE_LIVE)await until(session,"document.querySelectorAll('.request-row').length>0");
  console.log('PASS changes: idle/paused pages avoid workspace polling; resume fetches current page');
  await click(session,'[data-mode="mock"]');await until(session,"document.querySelectorAll('.request-row').length===60");
  assert.equal(await evaluate(session,"document.querySelector('#clear-records').hidden"),true,'Demo mode exposes the live clear action');

  // Real pointer/keyboard input, resize, reload and persisted layout behavior.
  await resize(session,1920);
  const wideDefault=await dimensions(session);
  assert.equal(wideDefault.sidebar,232);
  assert.ok(Math.abs(wideDefault.list-960*0.6)<1);
  await resize(session,1100);
  const compactDefault=await dimensions(session);
  assert.equal(compactDefault.sidebar,186);
  assert.ok(Math.abs(compactDefault.list-240)<1,'A compact window must preserve the minimum usable list width');
  await assertNoUIOverflow(session);
  await resize(session,1440);
  assert.ok(Math.abs((await dimensions(session)).list-original.list)<1);
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-layout-v1')"),null);
  const separator=await evaluate(session,"(()=>{const r=document.querySelector('#detail-splitter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+100};})()");
  await send('Input.dispatchMouseEvent',{type:'mousePressed',...separator,button:'left',clickCount:1},session);
  await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:separator.x-200,y:separator.y,button:'left',buttons:1},session);
  await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:separator.x-200,y:separator.y,button:'left',clickCount:1},session);
  const dragged=await dimensions(session);
  assert.ok(dragged.list>=239 && dragged.list<=241,JSON.stringify(dragged));
  assert.ok(dragged.detail>original.detail);
  await evaluate(session,"document.querySelector('#detail-splitter').focus()");
  await send('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},session);
  await send('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39},session);
  const keyboard=await dimensions(session);
  assert.ok(Math.abs(keyboard.list-dragged.list-12)<1);
  const saved=await evaluate(session,"localStorage.getItem('ecaptureq-layout-v1')");assert.ok(saved);
  await language(session,'zh-CN');await reload(session);
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN','Language choice did not survive reload');
  assert.ok(Math.abs((await dimensions(session)).list-keyboard.list)<1);
  await resize(session,800);await assertNoUIOverflow(session);
  assert.equal((await dimensions(session)).sidebar,0);
  await resize(session,390);await assertNoUIOverflow(session);
  await screenshot(session,'narrow-zh-light');
  assert.ok(await evaluate(session,"(()=>{const r=document.querySelector('#request-search').getBoundingClientRect();return r.width>50 && r.right<=innerWidth;})()"));
  assert.ok(await evaluate(session,"['#language-toggle','#theme-toggle','#export-data','#capture-toggle','#toggle-processes'].every(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return r.width>=20 && r.height>=20 && r.left>=0 && r.right<=innerWidth;})"),'A primary narrow-window control is unavailable');
  await click(session,'.request-row');await screenshot(session,'narrow-detail-zh-light');await assertNoUIOverflow(session);
  await click(session,'#back-to-list');
  await resize(session,1440);await reload(session);
  assert.ok(Math.abs((await dimensions(session)).list-keyboard.list)<1,'Resize/reload repeatedly reduced the middle width');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-layout-v1')"),saved);
  await language(session,'en');await theme(session,'light');
  await evaluate(session,"localStorage.removeItem('ecaptureq-layout-v1')");await reload(session);
  assert.ok(Math.abs((await dimensions(session)).list-original.list)<1);
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

  if (process.env.SMOKE_NATIVE === '1') {
    // These artifacts must come through the actual WS receiver and Store. This
    // branch intentionally has no fetch override or browser-injected fixtures.
    const native = await createPage();
    await language(native,'en');
    await click(native,'[data-mode="live"]');
    await until(native,`(async()=>{const s=await(await fetch('api/status')).json();return ['keylog','pcapng'].every(format=>s.artifacts?.some(a=>a.format===format&&a.state==='complete')&&s.artifacts?.some(a=>a.format===format&&a.state==='partial'));})()`);
    await until(native,"!document.querySelector('#native-artifacts').hidden");
    assert.ok(await evaluate(native,"document.querySelector('#native-artifacts').closest('button')?.id==='connection-toggle' && !document.querySelector('.app-toolbar #native-artifacts')"),'Native files must share the header source entry');
    await click(native,'#connection-toggle');
    await until(native,"document.querySelectorAll('[data-artifact-id]').length>=4");
    const artifacts = await evaluate(native,"(async()=>{return (await(await fetch('api/status')).json()).artifacts;})()");
    assert.ok(await evaluate(native,"[...document.querySelectorAll('[data-artifact-id]')].every(file=>file.closest('[data-source-id]'))"),'Files must belong to source cards');
    const fileSources=new Set(artifacts.map(a=>a.sourceId)).size;
    assert.match(await evaluate(native,"document.querySelector('#native-artifacts').textContent"),new RegExp(String(fileSources)+'$'));
    await evaluate(native,"document.querySelectorAll('.native-history').forEach(history=>history.open=true)");
    for(const appearance of ['light','dark']) {
      await click(native,'#close-connection');await theme(native,appearance);await resize(native,390);
      await click(native,'#connection-toggle');
      await assertNoUIOverflow(native);
      const layout=await evaluate(native,"(()=>{const b=document.querySelector('.native-export');b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect(),style=getComputedStyle(b);return {width:r.width,height:r.height,left:r.left,right:r.right,background:style.backgroundColor,color:style.color,brand:getComputedStyle(document.documentElement).getPropertyValue('--brand').trim()};})()");
      assert.ok(layout.width>=100 && layout.height>=36 && layout.left>=0 && layout.right<=390,'Export action is not reachable on narrow screens');
      assert.notEqual(layout.background,layout.color,'Export button contrast missing');
      await screenshot(native,`native-sources-narrow-${appearance}`);
    }
    await click(native,'#close-connection');await resize(native,1440);await theme(native,'light');await click(native,'#connection-toggle');
    await evaluate(native,"document.querySelectorAll('.native-history').forEach(history=>history.open=true)");
    const nativeDownloads=path.join(profile,'native-downloads');await mkdir(nativeDownloads);
    await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:nativeDownloads});
    for(const format of ['keylog','pcapng']) for(const state of ['complete','partial']) {
      const artifact=artifacts.filter(a=>a.format===format&&a.state===state).at(-1);
      assert.ok(artifact.bytes>0 && artifact.bytes<=1<<20,'Native browser fixtures must be nonempty and bounded');
      assert.ok(artifact.module,'Fixture upstream module must reach the UI');
      assert.equal(artifact.filename.endsWith('.partial'),state==='partial');
      const selector=`[data-artifact-id="${artifact.id}"]`;
      await until(native,`!!document.querySelector(${JSON.stringify(selector)})`);
      assert.ok((await evaluate(native,`document.querySelector(${JSON.stringify(selector)}).textContent`)).includes(artifact.module));
      const fromAPI=await evaluate(native,`(async()=>{const r=await fetch('api/artifacts/download?'+new URLSearchParams({session:${JSON.stringify(artifact.session)},id:${JSON.stringify(artifact.id)}}));if(!r.ok)throw Error('artifact download '+r.status);return Array.from(new Uint8Array(await r.arrayBuffer()));})()`);
      assert.equal(fromAPI.length,artifact.bytes);
      await click(native,selector+' [data-export-artifact]');
      let downloaded;
      for(let i=0;i<100;i++){try{downloaded=await readFile(path.join(nativeDownloads,artifact.filename));break;}catch{}await sleep(100);}
      assert.deepEqual(downloaded,Buffer.from(fromAPI),'UI download altered native bytes');
      await until(native,`!document.querySelector(${JSON.stringify(selector+' [data-export-artifact]')}).disabled`);
      if(format==='pcapng')assert.equal(downloaded.readUInt32LE(0),0x0a0d0d0a,'pcapng lacks an SHB');
      else assert.match(downloaded.toString('ascii'),/CLIENT_RANDOM|TRAFFIC_SECRET/,'keylog lacks NSS secrets');
    }
    const perSource=new Map();
    for(const a of artifacts){if(!perSource.has(a.sourceId))perSource.set(a.sourceId,new Set());perSource.get(a.sourceId).add(a.generation);}
    assert.ok([...perSource.values()].some(generations=>generations.size>1),'Reconnect must create distinct native generations');
    await click(native,'#close-connection');
    await until(native,"document.querySelectorAll('.request-row').length>0");
    const records=await evaluate(native,"(async()=>{return (await(await fetch('api/workspace?mode=live')).json()).requests;})()");
    assert.ok(records.some(r=>r.family==='http'&&r.metadata?.module),'Formatted TEXT must still become HTTP records with upstream module');
    assert.ok(records.every(r=>!/(?:KEYLOG|PCAPNG)$/.test(r.metadata?.captureFormat || '')),'Native fragments entered record JSON');
    console.log('PASS native: real receiver to status/UI/download, KEYLOG+PCAPNG complete/partial bytes, generations, TEXT separation at '+base.pathname);
  }

  const fixture=JSON.parse(await readFile(new URL('../frontend/mock-data.json',import.meta.url),'utf8'));
  const identityFixture=structuredClone(fixture);
  const identityBase=fixture.requests.find(record=>record.protocol==='HTTP/1.1');
  const rawID='4321-7-demo-client/192.0.2.10:45626--192.0.2.20:443/tcp#3557';
  const ipv6ID='4321-7-demo-client/2001:db8::2:45626--2001:db8::1:443/tcp#3558';
  const identityRecord=(id,connectionId,extra={})=>({...structuredClone(identityBase),id,connectionId,
    real:true,sourceId:'synthetic-identity',processPid:4321,processCommand:'synthetic-client --fixture',transport:'tcp',
    sourceAddress:'192.0.2.10:45626',destinationAddress:'192.0.2.20:443',direction:'client_to_server',
    metadata:{event:{uuid:connectionId},tls:{version:'TLS 1.3',server_name:'synthetic.example.test'}},...extra});
  identityFixture.requests=[
    identityRecord('identity-request',rawID),
    identityRecord('identity-response',rawID,{direction:'server_to_client',sourceAddress:'192.0.2.20:443',destinationAddress:'192.0.2.10:45626'}),
    identityRecord('identity-ipv6',ipv6ID),
    identityRecord('identity-unknown','opaque-custom-key-with-dashes'),
    identityRecord('identity-migration','4321-7-demo-client/192.0.2.10:45626--192.0.2.20:443/udp#3560',{
      family:'http',protocol:'HTTP/3',transport:'udp',streamId:'12',sourceAddress:'198.51.100.10:45627',
      metadata:{quicVersion:'v1',cid:'synthetic-cid',alpn:'h3',qpack:'decoded',tls:{version:'TLS 1.3'}}})
  ];
  const identity=await createPage(`window.__ECAPTURE_MOCK__=${JSON.stringify(identityFixture)};`);
  await language(identity,'zh-CN');
  const connectionFields="(()=>{const dl=document.querySelectorAll('.connection-content > .connection-fields')[1];return {labels:[...dl.querySelectorAll('dt')].map(x=>x.textContent),values:[...dl.querySelectorAll('dd')].map(x=>x.textContent)};})()";
  for(const [id,expected,transport] of [
    ['identity-request','192.0.2.10:45626--192.0.2.20:443/tcp#3557','TCP · HTTP/1.1'],
    ['identity-response','192.0.2.10:45626--192.0.2.20:443/tcp#3557','TCP · HTTP/1.1'],
    ['identity-ipv6','[2001:db8::2]:45626--[2001:db8::1]:443/tcp#3558','TCP · HTTP/1.1'],
    ['identity-unknown','opaque-custom-key-with-dashes','TCP · HTTP/1.1'],
    ['identity-migration','192.0.2.10:45626--192.0.2.20:443/udp#3560','UDP · HTTP/3']
  ]) {
    await click(identity,`[data-request="${id}"]`);await click(identity,'[data-tab="connection"]');
    const fields=await evaluate(identity,connectionFields);
    assert.deepEqual(fields.labels,['上游模块','连接标识','消息方向','传输协议','采集时间']);
    assert.equal(fields.values[1],expected);assert.equal(fields.values[3],transport);
    assert.equal(fields.values[2],id==='identity-response'?'服务端 → 客户端':'客户端 → 服务端');
    const record=identityFixture.requests.find(value=>value.id===id);
    assert.ok(await evaluate(identity,`document.querySelector('.event-metadata pre').textContent.includes(${JSON.stringify(record.connectionId)})`),'Raw diagnostic identifier was lost');
    await assertNoUIOverflow(identity);
  }
  assert.ok(await evaluate(identity,"document.querySelector('#tab-content').textContent.includes('Stream ID') && document.querySelector('#tab-content').textContent.includes('synthetic-cid')"),'QUIC stream and connection context was lost');
  await click(identity,`[data-process="${identityBase.processId}"]`);
  assert.equal(await evaluate(identity,"document.querySelectorAll('.request-row').length"),5,'Connection display affected process filtering');
  await click(identity,'[data-request="identity-ipv6"]');await click(identity,'[data-tab="connection"]');
  await theme(identity,'dark');await screenshot(identity,'connection-ipv6-zh-dark');
  await resize(identity,390);await assertNoUIOverflow(identity);await screenshot(identity,'connection-ipv6-narrow-zh-dark');
  await resize(identity,1440);await language(identity,'en');await theme(identity,'light');
  const identityDownloads=path.join(profile,'identity-downloads');await mkdir(identityDownloads);
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:identityDownloads});
  await click(identity,'#export-data');
  let identityExport;
  for(let i=0;i<100;i++){try{identityExport=JSON.parse(await readFile(path.join(identityDownloads,'ecaptureq-demo-session.json'),'utf8'));break;}catch{}await sleep(100);}
  assert.deepEqual(identityExport?.requests,identityFixture.requests,'Export altered raw identities or capture data');
  console.log('PASS display: known UUIDs, IPv6, stable response identity, unknown fallback, QUIC migration context, original JSON export');
  // Source-only status changes must update the selected connection without
  // replacing captured content or applying a new generation to an old record.
  const collectorFixture=structuredClone(identityFixture);
  collectorFixture.mode='mock';
  collectorFixture.requests=[{...collectorFixture.requests[0],sourceId:'source-1',captureGeneration:1,
    responseProcess:{id:'source-1:202:synthetic-server',pid:202,name:'synthetic-server',command:'synthetic-server --port 443'}}];
  collectorFixture.status={session:'collector-ui-fixture',revision:1,recordsRevision:0,state:'connected',sources:[{id:'source-1',label:'Synthetic collector',endpoint:'ws://127.0.0.1:1/',state:'connected',generation:1}]};
  const collectorPage=await createPage(`{const fixture=globalThis.__collectorFixture=${JSON.stringify(collectorFixture)};const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{const path=new URL(url,location.href).pathname;if(path.endsWith('/api/workspace'))return Promise.resolve(new Response(JSON.stringify(fixture)));if(path.endsWith('/api/status')||path.endsWith('/api/changes'))return Promise.resolve(new Response(JSON.stringify(fixture.status)));return originalFetch(url,options);};}`);
  await language(collectorPage,'en');await click(collectorPage,'[data-tab="connection"]');
  assert.equal(await evaluate(collectorPage,"document.querySelector('.observed-process').open"),false,'Additional observed process must be collapsed by default');
  const originalScroll=await evaluate(collectorPage,"(()=>{const peer=document.querySelector('.observed-process');peer.open=true;globalThis.__capturedProcessNode=document.querySelector('.connection-content > .connection-fields');document.querySelector('#tab-content').scrollTop=80;return document.querySelector('#tab-content').scrollTop;})()");
  await evaluate(collectorPage,`(()=>{const status=globalThis.__collectorFixture.status;status.revision++;status.sources[0].collector={version:'synthetic-collector-v1',argv:['ecapture','<script>globalThis.__collectorExecuted=true</script>'],buildTime:'2026-11-21T01:02:03Z',decryptorVersion:'synthetic-decryptor'};})()`);
  await until(collectorPage,"document.querySelector('.connection-source-metadata').textContent.includes('synthetic-collector-v1')");
  assert.ok(await evaluate(collectorPage,"document.querySelector('.connection-content > .connection-fields')===globalThis.__capturedProcessNode && document.querySelector('.observed-process').open"),'Source metadata refresh replaced captured content or closed its disclosure');
  assert.equal(await evaluate(collectorPage,"document.querySelector('#tab-content').scrollTop"),originalScroll,'Source metadata refresh moved the detail scroll position');
  assert.equal(await evaluate(collectorPage,"document.querySelector('.connection-source-metadata script')"),null,'Collector-supplied command became markup');
  assert.equal(await evaluate(collectorPage,'globalThis.__collectorExecuted'),undefined);
  await evaluate(collectorPage,"globalThis.__collectorFixture.status.revision++;globalThis.__collectorFixture.status.sources[0].generation=2;globalThis.__collectorFixture.status.sources[0].collector.version='synthetic-collector-v2'");
  await until(collectorPage,"!document.querySelector('.connection-source-metadata').textContent.includes('synthetic-collector-v1')");
  assert.ok(await evaluate(collectorPage,"!document.querySelector('.connection-source-metadata').textContent.includes('synthetic-collector-v2') && document.querySelector('.connection-source-metadata .source-intro')"),'Reconnection metadata was applied to a retained old-generation record');
  console.log('PASS collector metadata: source-only updates, escaped argv, preserved content/disclosure/scroll and reconnect generation isolation');
  const malicious='<img src="https://forbidden.invalid/pixel" onerror="parent.__captureExecuted=true"><script>parent.__captureExecuted=true</script>';
  const template=fixture.requests.find(r=>r.family==='http' || !r.family);
  const makeRecord=(id,contentType,body)=>({...structuredClone(template),id,path:'/'+id,host:'forbidden.invalid',durationMs:malicious,
    response:{headers:[{name:'Content-Type',value:contentType},{name:'X-Untrusted',value:malicious}],body,bodyEncoding:'utf8',byteLength:Buffer.byteLength(body)},state:'complete',status:200});
  fixture.processes[0].name=malicious;
  fixture.requests=[
    makeRecord('security-html','text/html',`<meta http-equiv="refresh" content="0;url=https://forbidden.invalid/refresh"><style>a{pointer-events:auto}body{background:url(https://forbidden.invalid/css)}</style>${malicious}<a href="https://forbidden.invalid/link">External link</a>`),
    makeRecord('security-svg','image/svg+xml','<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>parent.__captureExecuted=true</script><image href="https://forbidden.invalid/svg"/><rect width="10" height="10" fill="green"/></svg>')
  ];
  fixture.status={artifacts:[{id:'0123456789abcdef0123456789abcdef',session:'synthetic',sourceId:'source-1',sourceLabel:malicious,module:malicious,format:'pcapng',bytes:42,generation:1,state:'partial',error:malicious,filename:'synthetic.pcapng.partial'}],sources:[{id:'source-1',label:'Synthetic source',endpoint:'ws://127.0.0.1:1',state:'connected'}],logs:Array.from({length:100},(_,index)=>({sourceId:'source-1',message:(index===99 ? malicious+'\n' : '')+'SYNTHETIC operational log '+String(index).padStart(3,'0')})),state:'connected'};
  fixture.mode='mock';
  const script=`{const fixture=${JSON.stringify(fixture)};globalThis.__logFixture=fixture;const originalFetch=globalThis.fetch;globalThis.fetch=(url,options)=>{const path=new URL(url,location.href).pathname;if(path.endsWith('/api/workspace'))return Promise.resolve(new Response(JSON.stringify(fixture)));if(path.endsWith('/api/status') || path.endsWith('/api/changes'))return Promise.resolve(new Response(JSON.stringify(fixture.status)));return originalFetch(url,options);};}`;
  const blockedRequests=[];
  events.on('Network.requestWillBeSent',message=>{if(message.params.request.url.includes('forbidden.invalid'))blockedRequests.push(message.params.request.url);});
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
  assert.equal(await evaluate(security,"document.querySelectorAll('.source-logs>div').length"),100,'Log viewer discarded retained entries');
  assert.match(await evaluate(security,"document.querySelector('.source-logs>div:first-child code').textContent"),/SYNTHETIC operational log 099$/);
  assert.equal(await evaluate(security,"document.querySelector('.source-logs>div:last-child code').textContent"),'SYNTHETIC operational log 000');
  assert.match(await evaluate(security,"document.querySelector('#source-log-title').textContent"),/100/);
  const logScroll=await evaluate(security,"(()=>{const panel=document.querySelector('.source-logs');panel.scrollIntoView({block:'nearest'});panel.scrollTop=panel.scrollHeight;const oldest=panel.lastElementChild.getBoundingClientRect(),bounds=panel.getBoundingClientRect();return {top:panel.scrollTop,scrollable:panel.scrollHeight>panel.clientHeight,oldestVisible:oldest.top>=bounds.top && oldest.bottom<=bounds.bottom};})()");
  assert.ok(logScroll.scrollable && logScroll.top>0 && logScroll.oldestVisible,'Oldest retained log cannot be reached by scrolling');
  await sleep(1200);
  assert.ok(await evaluate(security,"document.querySelector('#source-log-details').open"));
  assert.equal(await evaluate(security,"document.querySelector('.source-logs').scrollTop"),logScroll.top,'Polling moved the log scroll position');
  await evaluate(security,"(()=>{const logs=globalThis.__logFixture.status.logs;logs.shift();logs.push({sourceId:'source-1',message:'SYNTHETIC operational log 100'});document.querySelector('.source-logs').scrollTop=80;})()");
  await until(security,"document.querySelector('.source-logs>div:first-child code').textContent==='SYNTHETIC operational log 100'");
  assert.equal(await evaluate(security,"document.querySelectorAll('.source-logs>div').length"),100);
  assert.equal(await evaluate(security,"document.querySelector('.source-logs>div:last-child code').textContent"),'SYNTHETIC operational log 001');
  assert.equal(await evaluate(security,"document.querySelector('.source-logs').scrollTop"),80,'New logs reset the scroll position');
  await evaluate(security,"globalThis.__logFixture.status.logs.shift()");
  await until(security,"document.querySelectorAll('.source-logs>div').length===99 && document.querySelector('#source-log-title').textContent.includes('99')");
  await click(security,'#close-connection');await language(security,'en');await click(security,'#connection-toggle');
  assert.equal(await evaluate(security,"document.querySelector('#source-log-title').textContent"),'Runtime logs (99)');
  await click(security,'#close-connection');await language(security,'zh-CN');await click(security,'#connection-toggle');
  assert.equal(await evaluate(security,"document.querySelector('#source-log-title').textContent"),'运行日志（99 条）');
  assert.ok(await evaluate(security,"document.querySelector('#source-log-details').open"));
  assert.equal(await evaluate(security,"document.querySelector('.source-logs').querySelector('img,script')"),null);
  assert.equal(await evaluate(security,"document.querySelector('.native-session').querySelector('img,script')"),null,'Native captured fields must remain escaped');
  await evaluate(security,"globalThis.__logFixture.status.sources=[]");
  await until(security,"document.querySelector('.source-card [data-state=removed]') && document.querySelector('.native-session')");
  assert.equal(await evaluate(security,"document.querySelector('.source-card').querySelector('img,script,.source-menu')"),null,'Removed source files must remain escaped and have no live controls');
  await evaluate(security,"globalThis.__logFixture.status.artifacts=[]");
  await until(security,"document.querySelector('#native-artifacts').hidden && !document.querySelector('.native-session')");
  assert.equal(await evaluate(security,'globalThis.__captureExecuted'),undefined);
  assert.deepEqual(blockedRequests,[],'Preview initiated an external request');
  assert.deepEqual(exceptions,[],'Unhandled browser exception');
  console.log('PASS security: escaped fields/logs, inert sandbox HTML, local SVG image, no captured URL requests, all 100 retained logs scrollable with live translated counts and preserved polling position');
  if(authUser) {
    assert.equal(await evaluate(session,"document.querySelector('#logout').hidden"),false);
    assert.ok(await evaluate(session,"!document.cookie.includes('ecaptureq_session_')"),'Session cookie is accessible to JavaScript');
    await navigateDocument({send,events,sessionId:session,trigger:()=>pointerClick(session,'#logout')});
    await until(session,"!!document.querySelector('#login-form')");
    assert.equal(await evaluate(session,"(async()=>{return (await fetch('api/workspace')).status})()"),401);
    console.log('PASS auth: protected APIs, wrong-password error, login cookie, mobile login, authenticated workflow and logout');
  } else {
    assert.equal(await evaluate(session,"document.querySelector('#logout').hidden"),true,'Unauthenticated mode exposed sign-out control');
  }
  assert.deepEqual(exceptions,[],'Unhandled browser exception after auth transitions');
} catch(error) {
  console.error('Browser diagnostic stderr:',stderr.slice(-8000));
  console.error('Recent browser navigation:',JSON.stringify(networkDiagnostics));
  throw error;
} finally {
  if(ws?.readyState===WebSocket.OPEN){try{await send('Browser.close');}catch{}ws.close();}
  if(!await waitForBrowserClose(3000)) {
    proc.kill('SIGTERM');
    if(!await waitForBrowserClose(3000)){proc.kill('SIGKILL');await waitForBrowserClose(3000);}
  }
  // A Chrome helper may inherit stderr after the browser itself has exited.
  // Release our pipe so that helper cannot keep the Node test process alive.
  if(proc.exitCode!==null || proc.signalCode!==null)proc.stderr.destroy();
  // Chromium may finish a profile write as it shuts down. Retry only the
  // filesystem's transient removal errors; persistent cleanup failures fail CI.
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
