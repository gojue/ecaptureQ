// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

// Exercise the actual page loop without loading DOM rendering or native APIs.
const app = readFileSync(new URL('../frontend/app.js', import.meta.url),'utf8');
const loop = app.slice(app.indexOf('async function pollChanges()'),app.indexOf('function updateLanguageControls()'));
function setup() {
  const cursor = {session:'session-a',revision:1,recordsRevision:1};
  const calls = {fetch:[],refresh:0,updates:0,timers:[]};
  const context = vm.createContext({
    pageClosed:false,window:{},loadGeneration:1,changeController:null,pollTimer:null,
    serverStatus:{...cursor},workspace:{status:{...cursor}},state:{mode:'live',paused:false},serviceError:'',
    AbortController,URLSearchParams,
    fetchWithTimeout:async (...args)=>{calls.fetch.push(args);return new Response(null,{status:204});},
    refreshLive:async ()=>{calls.refresh++;},updateCaptureControls:()=>{calls.updates++;},
    setTimeout:(fn,delay)=>{calls.timers.push({fn,delay});return calls.timers.length;},
  });
  vm.runInContext(loop,context);
  return {context,calls,cursor};
}

test('idle waits use the current cursor and do not fetch workspace',async()=>{
  const {context,calls} = setup();
  await context.pollChanges();
  assert.equal(calls.fetch[0][0],'api/changes?session=session-a&revision=1');
  assert.equal(calls.fetch[0][2],15000);
  assert.equal(calls.refresh,0);
  assert.equal(calls.timers.length,1);
});

test('status-only changes update controls, record changes refresh once, pause/mock suppress pages',async()=>{
  for(const kind of ['status','records','paused','mock','restart']) {
    const {context,calls,cursor} = setup();
    const next = {...cursor,revision:2,recordsRevision:kind==='status'?1:2};
    if(kind==='paused') context.state.paused=true;
    if(kind==='mock') context.state.mode='mock';
    if(kind==='restart') Object.assign(next,{session:'session-b',revision:1,recordsRevision:1});
    context.fetchWithTimeout=async()=>Response.json(next);
    await context.pollChanges();
    assert.deepEqual(context.serverStatus,next);
    assert.equal(calls.updates,1);
    assert.equal(calls.refresh,['records','restart'].includes(kind)?1:0,kind);
    assert.equal(calls.timers[0].delay,1000,'continuous changes are rate limited');
  }
});

test('a failed page refresh remains dirty even after an unchanged wait timeout',async()=>{
  const {context,calls} = setup();
  context.serverStatus.recordsRevision=2;
  await context.pollChanges();
  await context.pollChanges();
  assert.equal(calls.refresh,2);
});

test('stale mode responses and closed pages cannot apply results',async()=>{
  for(const close of [false,true]) {
    const {context,calls,cursor} = setup();
    context.fetchWithTimeout=async()=>{
      if(close) context.pageClosed=true; else context.loadGeneration++;
      return Response.json({...cursor,revision:2,recordsRevision:2});
    };
    await context.pollChanges();
    assert.equal(calls.refresh,0);
    assert.equal(calls.updates,0);
    assert.equal(context.serverStatus.revision,1);
    assert.equal(calls.timers.length,close?0:1);
  }
});

test('errors back off without advancing the cursor; aborted waits are silent',async()=>{
  for(const abort of [false,true]) {
    const {context,calls} = setup();
    context.fetchWithTimeout=async()=>{
      if(abort) context.changeController.abort();
      throw new Error('offline');
    };
    await context.pollChanges();
    assert.equal(context.serverStatus.revision,1);
    assert.equal(calls.timers[0].delay,abort?1000:5000);
    assert.equal(Boolean(context.serviceError),!abort);
  }
});

test('snapshots and closed pages start no requests or timers',async()=>{
  for(const key of ['__ECAPTURE_CAPTURE__','__ECAPTURE_MOCK__','closed']) {
    const {context,calls} = setup();
    if(key==='closed') context.pageClosed=true; else context.window[key]={};
    await context.pollChanges();
    assert.equal(calls.fetch.length,0);
    assert.equal(calls.timers.length,0);
  }
});

test('initial workspace failures retry at a bounded rate',async()=>{
  const {context,calls} = setup();
  context.workspace=undefined;
  context.loadWorkspace=async()=>{context.loadGeneration++;context.changeController.abort();throw new Error('offline');};
  await context.pollChanges();
  assert.equal(calls.fetch.length,0);
  assert.equal(calls.timers[0].delay,5000);
});
