// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';

test('only same-origin Web auth challenges stop refresh and redirect once',async()=>{
  const originalLocation=globalThis.location, originalDispatch=globalThis.dispatchEvent;
  const redirects=[],events=[];
  globalThis.location={href:'https://example.test/ecaptureq-web/',origin:'https://example.test',protocol:'https:',replace:url=>redirects.push(url)};
  globalThis.dispatchEvent=event=>events.push(event.type);
  try {
    const {apiFetch}=await import('../frontend/api.js?auth-test');
    const plain=async()=>new Response('{}',{status:401});
    const challenge=async()=>new Response('{}',{status:401,headers:{'X-Ecaptureq-Auth':'required'}});
    await apiFetch('api/status',{},plain);
    await apiFetch('https://foreign.test/api/status',{},challenge);
    assert.equal(redirects.length,0);
    globalThis.location.protocol='wails:';
    await apiFetch('api/status',{},challenge);
    assert.equal(redirects.length,0);
    globalThis.location.protocol='https:';
    await apiFetch('api/changes',{},challenge);
    await apiFetch('api/workspace',{},challenge);
    assert.deepEqual(redirects,['https://example.test/ecaptureq-web/login']);
    assert.deepEqual(events,['ecaptureq-auth-expired']);
  } finally {
    if(originalLocation===undefined)delete globalThis.location;else globalThis.location=originalLocation;
    if(originalDispatch===undefined)delete globalThis.dispatchEvent;else globalThis.dispatchEvent=originalDispatch;
  }
});
