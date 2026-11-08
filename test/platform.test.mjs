// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {createPlatformAdapter,fetchWithTimeout} from '../frontend/platform.js';
import {setLanguage} from '../frontend/i18n.js';

const json = (value,status=200) => new Response(JSON.stringify(value),{status});
test('desktop exports, clipboard and links use native same-origin APIs',async () => {
  const calls=[];
  const platform=createPlatformAdapter({fetch:async (url,options) => {
    calls.push({url,options});
    if(url==='api/platform')return json({desktop:true});
    return json(url.endsWith('/export')?{cancelled:true}:{ok:true});
  }});
  assert.deepEqual(await platform.exportJSON('test.json','{}'),{cancelled:true});
  await platform.copyText('captured <script> text');
  await platform.openExternal('https://ecapture.cc/');
  assert.equal(calls.filter(c=>c.url==='api/platform').length,1);
  assert.deepEqual(calls.slice(1).map(c=>c.url),['api/platform/export','api/platform/clipboard','api/platform/open-url']);
  for(const call of calls.slice(1)) {
    assert.equal(call.options.headers['X-Ecapture-UI'],'1');
    assert.equal(call.options.headers['Content-Type'],'application/json');
  }
  assert.deepEqual(JSON.parse(calls[1].options.body),{filename:'test.json',content:'{}',locale:'en'});
  assert.equal(JSON.parse(calls[2].options.body).text,'captured <script> text');
});
test('desktop save dialogs receive the selected locale without changing export data',async()=>{
  const exports=[];
  const platform=createPlatformAdapter({fetch:async(url,options)=>{
    if(url==='api/platform')return json({desktop:true});
    exports.push(JSON.parse(options.body));
    return json({saved:true});
  }});
  try {
    for(const language of ['zh-CN','en']) {
      setLanguage(language);
      await platform.exportJSON('capture.json','{"captured":"响应"}');
    }
    assert.deepEqual(exports,[
      {filename:'capture.json',content:'{"captured":"响应"}',locale:'zh-CN'},
      {filename:'capture.json',content:'{"captured":"响应"}',locale:'en'}
    ]);
  } finally { setLanguage('en'); }
});
test('desktop failures never silently become browser downloads',async () => {
  for (const location of [{protocol:'wails:',hostname:'localhost'},{protocol:'http:',hostname:'wails.localhost'}]) {
    const platform=createPlatformAdapter({location,fetch:async()=>json({},404)});
    await assert.rejects(platform.exportJSON('test.json','{}'),/Native capabilities are unavailable/);
  }
  const platform=createPlatformAdapter({fetch:async url=>url==='api/platform'?json({desktop:true}):json({error:'export_too_large'},413)});
  await assert.rejects(platform.exportJSON('test.json','{}'),/export_too_large/);
});
test('native error descriptions use the selected language at invocation time',async () => {
  const platform=createPlatformAdapter({fetch:async url=>url==='api/platform'?json({desktop:true}):json({error:'clipboard_failed'},500)});
  for(const [language,message] of [['en',/Could not write to the system clipboard/],['zh-CN',/无法写入系统剪贴板/],['en',/Could not write to the system clipboard/]]) {
    setLanguage(language);
    await assert.rejects(platform.copyText('响应'),message);
  }
});
test('external URL adapters reject executable URL schemes',async () => {
  const platform=createPlatformAdapter({fetch:async()=>json({desktop:true})});
  await assert.rejects(platform.openExternal('javascript:alert(1)'),/HTTP/);
  await assert.rejects(platform.openExternal('file:///etc/passwd'),/HTTP/);
});
test('browser clipboard falls back when Clipboard API is unavailable',async () => {
  let selected=false,removed=false,focused=false,appended;
  const input={style:{},setAttribute(){},select(){selected=true;},remove(){removed=true;}};
  const document={activeElement:{focus(){focused=true;}},createElement:()=>input,body:{appendChild(node){appended=node;}},execCommand(action){assert.equal(action,'copy');return true;}};
  const platform=createPlatformAdapter({fetch:async()=>json({desktop:false}),document,navigator:{}});
  await platform.copyText('<img src=not-fetched>');
  assert.equal(appended,input);assert.equal(input.value,'<img src=not-fetched>');
  assert.ok(selected&&removed&&focused);
});
test('fetch timeout works without AbortSignal.timeout',async () => {
  await assert.rejects(fetchWithTimeout('api/record',{},1,(_url,{signal})=>new Promise((_resolve,reject)=>{
    signal.addEventListener('abort',()=>reject(new DOMException('timeout','AbortError')),{once:true});
  })),{name:'AbortError'});
});
