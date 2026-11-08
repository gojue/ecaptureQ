// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {setLanguage} from '../frontend/i18n.js';
import {presentationNote, processName, recordPlaceholderTitle, recordPlaceholderHost} from '../frontend/presentation.js';

test('known demo notes translate without changing captured or unknown notes', () => {
  const fixture=JSON.parse(readFileSync(new URL('../frontend/mock-data.json',import.meta.url),'utf8'));
  const original=JSON.stringify(fixture);
  setLanguage('en');
  for (const record of fixture.requests.filter(record=>record.note)) {
    assert.ok(!/[\u4e00-\u9fff]/.test(presentationNote(record)),record.note);
    assert.equal(presentationNote({...record,real:true}),record.note,'live capture is not a demo');
  }
  for (const real of [true,false]) {
    for (const note of ['响应','constructor','<img onerror=alert(1)>']) assert.equal(presentationNote({real,note}),note);
    assert.equal(presentationNote({real,metadata:{parseError:'invalid or unsupported RESP value'}}),'invalid or unsupported RESP value');
  }
  assert.equal(JSON.stringify(fixture),original);
});

test('only known mapper notes receive Chinese descriptions', () => {
  setLanguage('zh-CN');
  const note='Request was not observed; response is not assigned to another command.';
  assert.equal(presentationNote({real:true,note}),'未观测到请求；此响应不会分配给其他命令。');
  assert.equal(presentationNote({real:false,note}),note);
  assert.equal(presentationNote({real:true,note:'Request was not observed; server is still working.'}),'Request was not observed; server is still working.');
  setLanguage('en');
  assert.equal(presentationNote({real:true,note}),note);
});

test('an actual process sharing the placeholder name is preserved', () => {
  setLanguage('en');
  const unknown={id:'source-1:unknown',source:'source-1',pid:null,name:'未知进程'};
  assert.equal(processName(unknown),'Unknown process');
  for (const process of [{...unknown,pid:42},{...unknown,id:'source-1:0:未知进程'},{...unknown,source:'source-2'},{name:'未知进程',pid:null},{...unknown,name:'decryptor'}]) {
    assert.equal(processName(process),process.name);
  }
  setLanguage('zh-CN');
  assert.equal(processName(unknown),'未知进程');
  assert.equal(unknown.name,'未知进程');
});

test('placeholder titles and hosts require confirming record metadata', () => {
  setLanguage('zh-CN');
  const response={real:true,family:'http',hasRequest:false,path:'(request not observed)'};
  const endpoint={real:true,host:'Unknown endpoint',metadata:{hostSource:'unknown'}};
  assert.equal(recordPlaceholderTitle(response),'未捕获请求路径');
  assert.equal(recordPlaceholderTitle({...response,hasRequest:true}),null);
  assert.equal(recordPlaceholderTitle({...response,real:false}),null);
  assert.equal(recordPlaceholderHost(endpoint),'未知端点');
  assert.equal(recordPlaceholderHost({...endpoint,metadata:{hostSource:'host_header'}}),null);
  assert.equal(recordPlaceholderHost({...endpoint,host:'unknown.example'}),null);
  assert.equal(recordPlaceholderTitle({real:true,family:'raw',protocol:'RAW',operation:'EVENT',summary:'Captured event'}),'已捕获事件');
  assert.equal(recordPlaceholderTitle({real:true,family:'http',path:'Captured event',summary:'Captured event'}),null);
  assert.equal(recordPlaceholderTitle({real:true,family:'raw',protocol:'KEYLOG',summary:'Captured KEYLOG event',metadata:{captureFormat:'CAPTURE_FORMAT_KEYLOG'}}),'已捕获 KEYLOG 事件');
  assert.equal(recordPlaceholderTitle({real:true,family:'raw',protocol:'KEYLOG',summary:'Captured KEYLOG event'}),null);
  setLanguage('en');
});

// Mock summaries are authored UI descriptions; capture summaries remain literal.
test('known mock summaries translate while capture and raw summaries do not', () => {
  setLanguage('en');
  const demo = {family:'quic',summary:'Stream 4 · 连续字节'};
  assert.equal(recordPlaceholderTitle(demo),'Stream 4 · Contiguous bytes');
  assert.equal(recordPlaceholderTitle({...demo,real:true}),null);
  assert.equal(recordPlaceholderTitle({family:'mysql',summary:'SELECT 未提供 FROM captured'}),null);
  assert.equal(demo.summary,'Stream 4 · 连续字节');
  setLanguage('zh-CN');
  assert.equal(recordPlaceholderTitle(demo),demo.summary);
});
