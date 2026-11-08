// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolViews} from '../frontend/protocol-viewers.js';

const attack='<img src="https://invalid.test/" onerror="alert(1)"><script>alert(1)</script>';
const escapeHTML=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const helpers={escapeHTML,icon:()=>'<svg></svg>',bytes:n=>String(n)};
for(const [family,tab,metadata] of [
  ['quic','overview',{kind:attack,streamId:attack,cid:attack,errorCode:attack}],
  ['mysql','query',{query:attack,sql:attack}],
  ['redis','command',{command:attack,args:[attack],requestId:attack}],
  ['redis','result',{result:{type:'bulk_string',value:attack},error:attack}],
  ['mqtt','overview',{packetName:attack,topic:attack,clientId:attack,topics:[{topic:attack,qos:attack}],username:attack}]
]) {
  test(`${family}/${tab} escapes captured text`,()=>{
    const html=protocolViews.render({family,metadata,payload:attack,operation:attack,sizeBytes:12},tab,helpers);
    assert.ok(!html.includes('<img '));assert.ok(!html.includes('<script>'));
    assert.ok(html.includes('&lt;'));
  });
}
test('Redis pending and null remain different states',()=>{
  const pending=protocolViews.render({family:'redis',metadata:{result:null}},'result',helpers);
  const capturedNull=protocolViews.render({family:'redis',metadata:{result:{type:'null',value:null}}},'result',helpers);
  assert.ok(pending.includes('尚未观察到可关联的 RESP 值'));
  assert.ok(capturedNull.includes('(nil)'));assert.ok(!capturedNull.includes('尚未观察到可关联的 RESP 值'));
});
