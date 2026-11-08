// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {messages,setLanguage,getLanguage,t} from '../frontend/i18n.js';

const storageKey='ecaptureq-language';
let instance=0;
const freshModule=()=>import(new URL(`../frontend/i18n.js?i18n-test=${++instance}`,import.meta.url));
const memoryStorage=initial=>{
  const values=new Map(initial===undefined?[]:[[storageKey,initial]]);
  const writes=[];
  return {writes,getItem:key=>values.get(key)??null,setItem:(key,value)=>{writes.push([key,String(value)]);values.set(key,String(value));}};
};
async function withGlobals(overrides,run) {
  const descriptors=new Map(Object.keys(overrides).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  const previousLanguage=getLanguage();
  try {
    for(const [key,value] of Object.entries(overrides)) Object.defineProperty(globalThis,key,{configurable:true,writable:true,value});
    return await run();
  } finally {
    setLanguage(previousLanguage);
    for(const [key,descriptor] of descriptors) {
      if(descriptor)Object.defineProperty(globalThis,key,descriptor);
      else delete globalThis[key];
    }
  }
}

test('first visit follows the primary system language without saving an automatic preference',async()=>{
  for(const [navigator,expected] of [
    [{language:'en-US',languages:['zh-CN','en-US']},'zh-CN'],
    [{language:'zh-TW',languages:['zh-TW','en']},'zh-CN'],
    [{language:'en',languages:['zh-Hant-HK']},'zh-CN'],
    [{language:'zh',languages:[]},'zh-CN'],
    [{language:'ZH-cn'},'zh-CN'],
    [{language:'zh-CN',languages:['en-US','zh-CN']},'en'],
    [{language:'en-GB'},'en'],
    [{language:'zh-CN',languages:['fr-FR','zh-CN']},'en'],
    [{language:'de-DE'},'en'],
    [{language:'zh_invalid'},'en'],
    [{language:'zhx'},'en'],
    [{language:'zh-'},'en'],
    [{},'en'],
    [undefined,'en']
  ]) {
    const storage=memoryStorage();
    await withGlobals({localStorage:storage,navigator},async()=>{
      const fresh=await freshModule();
      assert.equal(fresh.getLanguage(),expected,JSON.stringify(navigator));
      assert.equal(fresh.t('请求'),expected==='en'?'Request':'请求');
      assert.equal(storage.getItem(storageKey),null);
      assert.deepEqual(storage.writes,[],'Automatic language detection must not save a manual preference');
    });
  }
});

test('manual language preference overrides the system and persists across a fresh module load',async()=>{
  const storage=memoryStorage();
  const navigator={language:'en-US',languages:['en-US']};
  await withGlobals({localStorage:storage,navigator},async()=>{
    const first=await freshModule();
    assert.equal(first.getLanguage(),'en');
    assert.equal(first.setLanguage('zh-CN'),'zh-CN');
    assert.equal(storage.getItem(storageKey),'zh-CN');
    const refreshed=await freshModule();
    assert.equal(refreshed.getLanguage(),'zh-CN');
    assert.equal(refreshed.t('请求'),'请求');
    navigator.language='zh-CN';navigator.languages=['zh-CN'];
    refreshed.setLanguage('en');
    assert.equal(storage.getItem(storageKey),'en');
    assert.equal((await freshModule()).getLanguage(),'en');
  });
});

test('without a manual selection each fresh load follows the current system language',async()=>{
  const storage=memoryStorage();
  const navigator={language:'zh-Hans-CN',languages:['zh-Hans-CN','en-CN']};
  await withGlobals({localStorage:storage,navigator},async()=>{
    assert.equal((await freshModule()).getLanguage(),'zh-CN');
    navigator.languages=['en-GB'];navigator.language='en-GB';
    assert.equal((await freshModule()).getLanguage(),'en');
    navigator.languages=['zh-TW'];navigator.language='zh-TW';
    assert.equal((await freshModule()).getLanguage(),'zh-CN');
    assert.equal(storage.getItem(storageKey),null);
    assert.deepEqual(storage.writes,[]);
  });
});

test('explicitly choosing the current automatic language still saves the manual preference',async()=>{
  for(const [systemLanguage,selected,nextSystemLanguage] of [['zh-CN','zh-CN','en-US'],['en-US','en','zh-CN']]) {
    const storage=memoryStorage();
    const navigator={language:systemLanguage,languages:[systemLanguage]};
    await withGlobals({localStorage:storage,navigator},async()=>{
      const first=await freshModule();
      assert.equal(first.getLanguage(),selected);
      assert.equal(storage.getItem(storageKey),null);
      assert.equal(first.setLanguage(selected),selected);
      assert.equal(storage.getItem(storageKey),selected);
      assert.deepEqual(storage.writes,[[storageKey,selected]]);
      navigator.language=nextSystemLanguage;navigator.languages=[nextSystemLanguage];
      assert.equal((await freshModule()).getLanguage(),selected);
    });
  }
});

test('invalid saved preferences fall back to the system while invalid manual selections use English',async()=>{
  for(const saved of ['zh','fr','EN','constructor','']) {
    for(const [systemLanguage,expected] of [['zh-CN','zh-CN'],['en-US','en']]) {
      const storage=memoryStorage(saved);
      await withGlobals({localStorage:storage,navigator:{language:systemLanguage}},async()=>{
        const fresh=await freshModule();
        assert.equal(fresh.getLanguage(),expected);
        assert.equal(storage.getItem(storageKey),saved,'Automatic fallback must not overwrite an existing value');
        assert.deepEqual(storage.writes,[]);
        fresh.setLanguage('zh-CN');
        assert.equal(fresh.setLanguage(saved),'en');
      });
    }
  }
});

test('system language detection and manual selection work when storage is unavailable or throws',async()=>{
  for(const localStorage of [undefined,{getItem(){throw new Error('denied');},setItem(){throw new Error('denied');}}]) {
    for(const [systemLanguage,expected] of [['zh-CN','zh-CN'],['en-US','en']]) {
      await withGlobals({localStorage,navigator:{language:systemLanguage}},async()=>{
        const fresh=await freshModule();
        assert.equal(fresh.getLanguage(),expected);
        assert.equal(fresh.setLanguage('zh-CN'),'zh-CN');
        assert.equal(fresh.t('请求'),'请求');
        assert.equal(fresh.setLanguage('en'),'en');
      });
    }
  }
  await withGlobals({localStorage:undefined,navigator:{language:'zh-CN'}},async()=>{
    Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('storage access denied');}});
    const fresh=await freshModule();
    assert.equal(fresh.getLanguage(),'zh-CN');
    assert.equal(fresh.setLanguage('zh-CN'),'zh-CN');
    assert.equal(fresh.t('请求'),'请求');
  });
});

test('interpolation preserves replacement characters and never reinterprets values',async()=>{
  await withGlobals({localStorage:memoryStorage()},()=>{
    for(const language of ['en','zh-CN']) {
      setLanguage(language);
      const value='$& <img src="captured"> {x} $1';
      assert.equal(t('当前语言：{language}',{language:value,x:'must not be substituted'}),
        language==='en'?`Current language: ${value}`:`当前语言：${value}`);
      assert.equal(t('{first}|{second}',{first:'{second}',second:'$&'}),'{second}|$&');
      assert.equal(t('{missing}',{}),'{missing}');
      assert.equal(t('{constructor}',{}),'{constructor}');
      assert.equal(t('{value}',Object.create({value:'inherited'})),'{value}');
    }
  });
});

test('unknown keys including object prototype names remain literal',async()=>{
  await withGlobals({localStorage:memoryStorage()},()=>{
    for(const language of ['en','zh-CN']) {
      setLanguage(language);
      for(const key of ['constructor','toString','__proto__','unknown-ui-key']) assert.equal(t(key),key);
      assert.equal(t(null),'');
      assert.equal(t(undefined),'');
    }
  });
});

test('catalog entries are nonempty and keep the same interpolation parameters',()=>{
  assert.ok(Object.keys(messages).length>0);
  const placeholders=value=>[...value.matchAll(/\{(\w+)\}/g)].map(match=>match[1]).sort();
  for(const [key,value] of Object.entries(messages)) {
    assert.ok(key.trim(), 'Empty source key');
    assert.equal(typeof value,'string',key);
    assert.ok(value.trim(),`Empty English translation: ${key}`);
    assert.deepEqual(placeholders(value),placeholders(key),`Changed parameters: ${key}`);
  }
});

test('static labels, literal translation calls and known dynamic message maps have catalog entries',async()=>{
  const quoted=/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g;
  const unescape=value=>value.replace(/\\(['"\\])/g,'$1').replace(/\\n/g,'\n');
  const requireKey=(key,file)=>assert.ok(Object.hasOwn(messages,key),`${file}: missing translation for ${key}`);
  for(const file of ['app.js','protocol-viewers.js','platform.js']) {
    const source=await readFile(new URL(`../frontend/${file}`,import.meta.url),'utf8');
    const calls=/\bt\(\s*(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")/g;
    for(const match of source.matchAll(calls)) requireKey(unescape(match[1]??match[2]),file);
    for(const match of source.matchAll(/\bconst\s+(?:connectionStates|sourceErrors|nativeErrors|directions|statusNames)\s*=\s*\{([\s\S]*?)\};/g)) {
      for(const literal of match[1].matchAll(quoted)) {
        const key=unescape(literal[1]??literal[2]);
        if(/[\u3400-\u9fff]/u.test(key))requireKey(key,file);
      }
    }
  }
  const html=await readFile(new URL('../frontend/index.html',import.meta.url),'utf8');
  const entities={'&amp;':'&','&quot;':'"','&#39;':"'",'&lt;':'<','&gt;':'>'};
  for(const match of html.matchAll(/\bdata-i18n(?:-(?:aria-label|title|placeholder|content))?="([^"]*)"/g)) {
    requireKey(match[1].replace(/&(?:amp|quot|lt|gt);|&#39;/g,entity=>entities[entity]),'index.html');
  }
  for(const key of ['此记录已超出保留范围，请刷新列表。','详情暂时不可用。','详情读取超时，请重试。','服务暂不可用']) requireKey(key,'detail errors');
});
