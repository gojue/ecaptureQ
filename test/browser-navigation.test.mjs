// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {navigateDocument} from './browser-navigation.mjs';

function browser() {
  const events=new EventEmitter(), calls=[];
  const send=async(method,params,sessionId)=>{
    calls.push({method,params,sessionId});
    return method==='Page.getFrameTree' ? {frameTree:{frame:{id:'main',loaderId:'old'}}} : {};
  };
  const lifecycle=(params={},sessionId='page')=>events.emit('Page.lifecycleEvent',{
    sessionId,params:{frameId:'main',loaderId:'new',name:'DOMContentLoaded',...params}
  });
  const navigate=trigger=>navigateDocument({send,events,sessionId:'page',trigger});
  return {send,events,calls,lifecycle,navigate};
}

test('navigation waits for the new main document in its own session',async()=>{
  const b=browser();
  let complete=false;
  const result=b.navigate(async()=>{
    b.lifecycle({loaderId:'old'}); // Delayed event from the previous document.
    b.lifecycle({frameId:'iframe'});
    b.lifecycle({},'other-page');
    b.lifecycle({name:'init'});
    b.lifecycle({loaderId:''});
  }).then(()=>{complete=true;});
  await nextTurn();
  assert.equal(complete,false);
  b.lifecycle();
  await result;
  assert.equal(complete,true);
  assert.equal(b.events.listenerCount('Page.lifecycleEvent'),0);
  assert.equal(b.events.listenerCount('Target.detachedFromTarget'),0);
});

test('cached navigation may finish before the trigger acknowledgement',async()=>{
  const b=browser();
  let acknowledge,complete=false;
  const result=b.navigate(()=>{
    assert.deepEqual(b.calls.map(call=>call.method),['Page.getFrameTree','Page.setLifecycleEventsEnabled']);
    b.lifecycle();
    return new Promise(resolve=>{acknowledge=resolve;});
  }).then(()=>{complete=true;});
  await nextTurn();
  assert.equal(complete,false,'Navigation must also await the trigger result');
  acknowledge({});
  await result;
});

test('failed navigation is not retried or hidden by an early load event',async()=>{
  for(const failure of [new Error('CDP command failed'),{errorText:'net::ERR_CONNECTION_REFUSED'}]) {
    const b=browser();
    let attempts=0;
    await assert.rejects(b.navigate(async()=>{
      attempts++;
      b.lifecycle();
      if(failure instanceof Error)throw failure;
      return failure;
    }),/CDP command failed|ERR_CONNECTION_REFUSED/);
    assert.equal(attempts,1);
    assert.equal(b.events.listenerCount('Page.lifecycleEvent'),0);
    assert.equal(b.events.listenerCount('Target.detachedFromTarget'),0);
  }
});

test('a closed target fails and removes listeners without waiting for timeout',async()=>{
  const b=browser();
  await assert.rejects(b.navigate(async()=>{
    b.events.emit('Target.detachedFromTarget',{params:{sessionId:'other-page'}});
    b.events.emit('Target.detachedFromTarget',{params:{sessionId:'page'}});
  }),/target detached/);
  assert.equal(b.events.listenerCount('Page.lifecycleEvent'),0);
  assert.equal(b.events.listenerCount('Target.detachedFromTarget'),0);
});

test('missing navigation readiness still times out and preserves other listeners',async()=>{
  const b=browser(), unrelated=()=>{};
  b.events.on('Page.lifecycleEvent',unrelated);
  await assert.rejects(navigateDocument({send:b.send,events:b.events,sessionId:'page',trigger:async()=>{},timeout:10}),/did not load within 10ms/);
  assert.deepEqual(b.events.listeners('Page.lifecycleEvent'),[unrelated]);
  assert.equal(b.events.listenerCount('Target.detachedFromTarget'),0);
});
