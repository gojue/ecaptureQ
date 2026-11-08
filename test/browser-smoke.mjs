// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// Dependency-free smoke test against a running eCaptureQ HTTP server.
// Usage: CHROME_BIN=/path/to/chrome node test/browser-smoke.mjs http://127.0.0.1:28257/
// SMOKE_SOURCE_ENDPOINT may name an unconfigured loopback ws-fixture to exercise
// real source creation; addresses used only for form inference are never submitted.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';

const base = new URL(process.argv[2] || 'http://127.0.0.1:28257/');
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
async function selectValue(sessionId,selector,value) {
  await evaluate(sessionId,`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(value)};input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
}
async function language(sessionId, value) {
  if (await evaluate(sessionId,"document.querySelector('#language-menu [aria-checked=true]')?.dataset.language") === value) return;
  await pointerClick(sessionId,'#language-toggle');
  await pointerClick(sessionId,`#language-menu [data-language="${value}"]`);
  await until(sessionId,`document.documentElement.lang===${JSON.stringify(value)} && document.querySelector('#language-menu [data-language="${value}"]').getAttribute('aria-checked')==='true'`);
  assert.equal(await evaluate(sessionId,`document.querySelector('#language-menu [data-language="${value}"]').getAttribute('aria-checked')`),'true');
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
  await send('Page.reload',{},sessionId);
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
  assert.equal(await evaluate(session,'navigator.language'),'zh-CN');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN','First visit must follow the Chinese system language');
  assert.equal(await evaluate(session,'document.title'),'eCaptureQ — 协议检查器');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),null,'Automatic language detection must not save a manual preference');
  assert.equal(await evaluate(session,"document.querySelector('#language-menu [data-language=\"zh-CN\"]').getAttribute('aria-checked')"),'true');
  assert.deepEqual(await evaluate(session,"[...document.querySelectorAll('#language-menu [data-language]')].map(option=>option.dataset.language)"),['en','zh-CN']);
  await screenshot(session,'overview-auto-zh-light');
  const beforeExplicitLanguage=await evaluate(session,uiStateExpression);
  const unrelatedStorage=await evaluate(session,"Object.fromEntries(Object.entries(localStorage).filter(([key])=>key!=='ecaptureq-language'))");
  await pointerClick(session,'#language-toggle');await screenshot(session,'language-menu-auto-zh-light');
  // Explicitly click the already checked language: automatic selection must
  // still become a saved preference even though the rendered locale is unchanged.
  await pointerClick(session,'#language-menu [data-language="zh-CN"]');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'zh-CN','Clicking the automatically checked language must save the manual choice');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforeExplicitLanguage,'Explicitly selecting the current language changed the UI state');
  assert.deepEqual(await evaluate(session,"Object.fromEntries(Object.entries(localStorage).filter(([key])=>key!=='ecaptureq-language'))"),unrelatedStorage,'Language selection changed unrelated preferences');
  await language(session,'en');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'en');
  await reload(session);
  assert.equal(await evaluate(session,'navigator.language'),'zh-CN');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'en','The saved English preference must override Chinese system language after reload');
  console.log('PASS initial language: Chinese system detected without saving; explicit current-language selection saves; manual English overrides system after refresh');
  assert.equal(await evaluate(session,'document.title'),'eCaptureQ — Protocol Inspector');
  assert.equal(await evaluate(session,"document.querySelector('#github-link').href"),'https://github.com/gojue/ecaptureQ');
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
  await pointerClick(session,'#language-toggle');
  assert.equal(await evaluate(session,"document.querySelector('#language-toggle').getAttribute('aria-expanded')"),'true');
  await screenshot(session,'language-menu-en-light');
  await pointerClick(session,'#language-toggle');
  assert.ok(await evaluate(session,"document.querySelector('#language-menu').hidden"),'A second pointer click must close the language menu');
  assert.equal(await evaluate(session,"document.querySelector('#language-toggle').getAttribute('aria-expanded')"),'false');
  const beforePointerLanguage=await evaluate(session,uiStateExpression);
  await pointerClick(session,'#language-toggle');
  // WebKit does not necessarily focus a button on mouse press. Reproduce its
  // null-relatedTarget focusout before the genuine mouseup/click, without
  // cancelling mouse defaults or dispatching the option's click ourselves.
  await evaluate(session,`(()=>{
    const picker=document.querySelector('.language-picker');
    const focused=document.activeElement;
    if(!focused.matches('#language-menu [aria-checked=true]'))throw new Error('Opening the menu did not focus its current option');
    globalThis.__smokeLanguagePointer={trusted:false,nullFocusout:false};
    picker.addEventListener('focusout',event=>{
      globalThis.__smokeLanguagePointer.nullFocusout=event.target===focused && event.relatedTarget===null;
    },{capture:true,once:true});
    document.querySelector('#language-menu [data-language="zh-CN"]').addEventListener('mousedown',event=>{
      globalThis.__smokeLanguagePointer.trusted=event.isTrusted && !event.defaultPrevented;
      focused.blur();
    },{capture:true,once:true});
  })()`);
  await pointerClick(session,'#language-menu [data-language="zh-CN"]');
  assert.deepEqual(await evaluate(session,'globalThis.__smokeLanguagePointer'),{trusted:true,nullFocusout:true},'The WebKit focusout sequence was not exercised');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN','Null-relatedTarget focusout must not hide an option before its pointer click selects the language');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'zh-CN');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforePointerLanguage,'Pointer language switching changed the current UI state');
  assert.ok(await evaluate(session,"document.querySelector('#language-menu').hidden && document.activeElement===document.querySelector('#language-toggle')"),'Language selection must close the menu and return focus');
  await language(session,'en');
  await pointerClick(session,'#language-toggle');
  await pointerClick(session,'.brand strong');
  assert.ok(await evaluate(session,"document.querySelector('#language-menu').hidden"),'An outside pointer click must close the language menu');
  await pointerClick(session,'#language-toggle');
  await pressKey(session,'Home',36);
  assert.equal(await evaluate(session,'document.activeElement.dataset.language'),'en');
  await pressKey(session,'ArrowDown',40);
  assert.equal(await evaluate(session,'document.activeElement.dataset.language'),'zh-CN');
  await pressKey(session,'ArrowDown',40);
  assert.equal(await evaluate(session,'document.activeElement.dataset.language'),'en','ArrowDown must wrap across both options');
  await pressKey(session,'ArrowUp',38);
  assert.equal(await evaluate(session,'document.activeElement.dataset.language'),'zh-CN','ArrowUp must wrap across both options');
  await pressKey(session,'Home',36);
  await pressKey(session,'End',35);
  assert.equal(await evaluate(session,'document.activeElement.dataset.language'),'zh-CN');
  await evaluate(session,"document.querySelector('#language-menu [data-language=\"zh-CN\"]').addEventListener('click',event=>{globalThis.__smokeKeyboardSelection={trusted:event.isTrusted,detail:event.detail};},{once:true})");
  await pressKey(session,'Enter',13);
  await until(session,"document.querySelector('#language-menu').hidden && document.querySelector('#language-menu [aria-checked=true]').dataset.language==='zh-CN'");
  assert.deepEqual(await evaluate(session,'globalThis.__smokeKeyboardSelection'),{trusted:true,detail:0},'Enter must activate the option through a trusted keyboard click');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'zh-CN');
  assert.equal(await evaluate(session,"localStorage.getItem('ecaptureq-language')"),'zh-CN');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforePointerLanguage,'Keyboard language selection changed the current UI state');
  await language(session,'en');
  await pointerClick(session,'#language-toggle');
  await pressKey(session,'Tab',9);
  assert.ok(await evaluate(session,"!document.querySelector('#language-menu').hidden && document.activeElement.dataset.language==='zh-CN'"),'Tab inside the menu must retain it');
  await pressKey(session,'Tab',9);
  assert.ok(await evaluate(session,"document.querySelector('#language-menu').hidden && document.activeElement.id==='theme-toggle'"),'Tab to an outside control must close the language menu');
  await pointerClick(session,'#language-toggle');
  await pressKey(session,'Escape',27);
  assert.ok(await evaluate(session,"document.querySelector('#language-menu').hidden && document.activeElement.id==='language-toggle'"),'Escape must close the language menu and restore toggle focus');
  assert.equal(await evaluate(session,'document.documentElement.lang'),'en','Dismissing the menu must not select a language');
  assert.equal(await evaluate(session,"document.querySelector('#language-menu [aria-checked=true]').dataset.language"),'en','Dismissing the menu must retain the selected language');
  assert.deepEqual(await evaluate(session,uiStateExpression),beforePointerLanguage,'Menu dismissal changed the current UI state');
  console.log('PASS language menu: real pointer clicks, null-relatedTarget focusout, two-option keyboard traversal, Enter, toggle, outside click, Tab and Escape');
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
  // Inference follows parent fields until the user edits the derived field.
  await click(session,'#connection-toggle');await click(session,'#add-source-toggle');
  const requiredValidation=await evaluate(session,"(()=>{const input=document.querySelector('#source-endpoint');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));return {valid:input.checkValidity(),message:input.validationMessage};})()");
  assert.equal(requiredValidation.valid,false);
  assert.match(requiredValidation.message,/WebSocket/i);
  assert.doesNotMatch(requiredValidation.message,/[\u3400-\u9fff]/,'Required endpoint validation ignored English UI language');
  await pointerClick(session,'#add-source-form details summary');
  const sourceFieldValues=`Object.fromEntries(['endpoint','host','module','command'].map(name=>[name,document.querySelector('#source-'+name).value]))`;
  const sourceControlGeometry=`Object.fromEntries(['host','module'].map(name=>{const r=document.querySelector('#source-'+name).getBoundingClientRect();return [name,{top:r.top,height:r.height,left:r.left,right:r.right,width:r.width}];}))`;
  for(const [endpoint,host] of [
    ['ws://192.0.2.10:28257/','192.0.2.10'],
    ['ws://[2001:db8::10]:28257/','2001:db8::10'],
    ['wss://collector.example.invalid/events','collector.example.invalid'],
    ['ws://',''],
  ]) {
    await editText(session,'#source-endpoint',endpoint);
    assert.equal((await evaluate(session,sourceFieldValues)).host,host,'Automatic host did not follow the WebSocket URL');
  }
  await editText(session,'#source-host','Synthetic manual host');
  await editText(session,'#source-endpoint','ws://192.0.2.20:28257/');
  assert.equal((await evaluate(session,sourceFieldValues)).host,'Synthetic manual host','URL edit replaced a manual capture host');
  await editText(session,'#source-host','');
  await editText(session,'#source-endpoint','ws://192.0.2.30:28257/');
  assert.equal((await evaluate(session,sourceFieldValues)).host,'','Explicitly cleared host was treated as automatic');
  for(const [command,module] of [
    ['ecapture tls','tls'],
    ['./ecapture gotls','gotls'],
    ['sudo /opt/ecapture/ecapture gnutls','gnutls'],
    ['curl --data tls https://example.invalid/',''],
    ['ecapture',''],
    ['ecapture tls','tls'],
    ['ecapture --log-file gotls',''],
  ]) {
    await editText(session,'#source-command',command);
    assert.equal((await evaluate(session,sourceFieldValues)).module,module,'Automatic module did not follow the actual ecapture subcommand');
  }
  await selectValue(session,'#source-module','gnutls');
  await editText(session,'#source-command','ecapture tls');
  assert.equal((await evaluate(session,sourceFieldValues)).module,'gnutls','Command edit replaced a manual module');
  await editText(session,'#source-command','not-ecapture --option gotls');
  assert.equal((await evaluate(session,sourceFieldValues)).module,'gnutls','Unknown command cleared a manual module');
  await selectValue(session,'#source-module','');
  await editText(session,'#source-command','ecapture tls');
  assert.equal((await evaluate(session,sourceFieldValues)).module,'','Explicitly cleared module was treated as automatic');
  await editText(session,'#source-label','Synthetic draft');
  await editText(session,'#source-host','Synthetic manual host');
  await selectValue(session,'#source-module','gnutls');
  const desktopControls=await evaluate(session,sourceControlGeometry);
  assert.ok(Math.abs(desktopControls.host.top-desktopControls.module.top)<1,'Desktop host and module controls must share a row');
  assert.ok(Math.abs(desktopControls.host.height-desktopControls.module.height)<1,'Capture input and select heights differ');
  const formValues=await evaluate(session,uiStateExpression);
  await evaluate(session,"document.querySelector('#connection-dialog').scrollTop=0");
  await screenshot(session,'sources-en-light');
  await click(session,'#close-connection');await language(session,'zh-CN');await theme(session,'dark');
  await click(session,'#connection-toggle');
  assert.deepEqual((await evaluate(session,uiStateExpression)).sourceValues,formValues.sourceValues);
  await screenshot(session,'sources-zh-dark');await assertNoUIOverflow(session);
  await editText(session,'#source-endpoint','ws://192.0.2.40:28257/');
  await editText(session,'#source-command','ecapture gotls');
  assert.equal((await evaluate(session,sourceFieldValues)).host,'Synthetic manual host','Reopening or translating a draft lost its manual host override');
  assert.equal((await evaluate(session,sourceFieldValues)).module,'gnutls','Reopening or translating a draft lost its manual module override');
  await pointerClick(session,'#cancel-add-source');await pointerClick(session,'#add-source-toggle');
  assert.equal((await evaluate(session,sourceFieldValues)).host,'Synthetic manual host','Cancel/reopen cleared the source draft');
  assert.equal((await evaluate(session,sourceFieldValues)).module,'gnutls','Cancel/reopen cleared the module override');
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
    assert.ok(Math.abs(controls.host.height-controls.module.height)<1,'Narrow input and select heights differ');
    assert.ok(Object.values(controls).every(r=>r.height>=32 && r.width>=100 && r.left>=0 && r.right<=390),'Narrow capture controls are not usable');
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
  await editText(session,'#source-endpoint','ws://192.0.2.50:28257/');
  await editText(session,'#source-command','ecapture tls');
  assert.equal((await evaluate(session,sourceFieldValues)).host,'192.0.2.50','Reset did not restore automatic host inference');
  assert.equal((await evaluate(session,sourceFieldValues)).module,'tls','Reset did not restore automatic module inference');
  if(sourceFixture) {
    await editText(session,'#source-label','Synthetic inferred source');
    await editText(session,'#source-endpoint',sourceFixture.href);
    await editText(session,'#source-command','./ecapture gotls');
    await evaluate(session,"document.querySelector('#connection-dialog').scrollTop=0");
    await screenshot(session,'source-form-inferred-en-light');
    await pointerClick(session,'#submit-source');
    await until(session,"document.querySelector('#add-source-form').hidden");
    await until(session,`(async()=>{const status=await(await fetch('api/status')).json();return status.sources.some(source=>source.endpoint===${JSON.stringify(sourceFixture.href)} && source.state==='connected' && source.events>0);})()`);
    const addedSource=await evaluate(session,`(async()=>{const status=await(await fetch('api/status')).json();return status.sources.find(source=>source.endpoint===${JSON.stringify(sourceFixture.href)});})()`);
    assert.equal(addedSource.label,'Synthetic inferred source');
    assert.equal(addedSource.capture.host,sourceFixture.hostname.replace(/^\[|\]$/g,''));
    assert.equal(addedSource.capture.module,'gotls');
    assert.equal(addedSource.capture.command,'./ecapture gotls','Launch command metadata changed in transit');
    await pointerClick(session,'#add-source-toggle');
    assert.deepEqual(await evaluate(session,sourceFieldValues),{endpoint:'',host:'',module:'',command:''},'Successful submission did not reset the draft');
    await editText(session,'#source-endpoint','ws://192.0.2.60:28257/');
    await editText(session,'#source-command','ecapture gnutls');
    assert.equal((await evaluate(session,sourceFieldValues)).host,'192.0.2.60','Successful submission did not reset automatic host tracking');
    assert.equal((await evaluate(session,sourceFieldValues)).module,'gnutls','Successful submission did not reset automatic module tracking');
    console.log('PASS source submission: inferred metadata sent to a loopback synthetic fixture and connected; successful reset restored inference');
  }
  await evaluate(session,"document.querySelector('#add-source-form').reset()");
  await click(session,'#close-connection');
  console.log('PASS source form: URL/module inference, explicit overrides and clears, draft persistence, reset, equal-height controls, narrow light/dark layouts');
  // A language change does not stop the simulation timer.
  await click(session,'#capture-toggle');
  const runningCount=await evaluate(session,"document.querySelectorAll('.request-row').length");
  await language(session,'zh-CN');
  assert.equal(await evaluate(session,"document.querySelector('#capture-toggle').getAttribute('aria-pressed')"),'true');
  await until(session,`document.querySelectorAll('.request-row').length>${runningCount}`);
  await click(session,'#capture-toggle');await click(session,'#reset-demo');
  await language(session,'en');
  await click(session,'[data-mode="live"]');await until(session,"document.querySelector('[data-mode=live]').getAttribute('aria-pressed')==='true'");
  if(process.env.SMOKE_REQUIRE_LIVE) {
    await until(session,"document.querySelectorAll('.request-row').length>0 && document.querySelector('#connection-toggle').dataset.state==='connected'");
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
  await click(session,'[data-mode="mock"]');await until(session,"document.querySelectorAll('.request-row').length===60");

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
    assert.deepEqual(fields.labels,['连接标识','消息方向','传输协议','采集时间']);
    assert.equal(fields.values[0],expected);assert.equal(fields.values[2],transport);
    assert.equal(fields.values[1],id==='identity-response'?'服务端 → 客户端':'客户端 → 服务端');
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
  if(!await waitForBrowserClose(3000)) {
    proc.kill('SIGTERM');
    if(!await waitForBrowserClose(3000)){proc.kill('SIGKILL');await waitForBrowserClose(3000);}
  }
  // Chromium may finish a profile write as it shuts down. Retry only the
  // filesystem's transient removal errors; persistent cleanup failures fail CI.
  await rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
