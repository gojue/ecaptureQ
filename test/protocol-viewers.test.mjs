// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {protocolViews} from '../frontend/protocol-viewers.js';
import {setLanguage} from '../frontend/i18n.js';

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
test('unknown directions including prototype names do not break protocol details',()=>{
  for (const language of ['en','zh-CN']) {
    setLanguage(language);
    for (const [family,tab,metadata] of [
      ['quic','overview',{kind:'stream_chunk',streamId:4,cid:'captured-id'}],
      ['redis','command',{command:'GET',args:['captured-key']}],
      ['mqtt','overview',{packetName:'PUBLISH',topic:'captured-topic'}]
    ]) {
      const record={family,metadata,sizeBytes:12};
      const fallback=protocolViews.render(record,tab,helpers);
      assert.ok(!fallback.includes('class="pv-flow"'));
      for (const direction of ['unknown','constructor','toString','__proto__']) {
        const captured={...record,direction}, original=JSON.stringify(captured);
        assert.equal(protocolViews.render(captured,tab,helpers),fallback,`${family}: ${direction}`);
        assert.equal(JSON.stringify(captured),original,'Rendering must preserve the captured direction');
      }
    }
  }
  setLanguage('en');
});
test('Redis pending and null remain different states',()=>{
  for (const [language,waiting] of [['en','No associated RESP value has been observed'],['zh-CN','尚未观察到可关联的 RESP 值']]) {
    setLanguage(language);
    const pending=protocolViews.render({family:'redis',metadata:{result:null}},'result',helpers);
    const capturedNull=protocolViews.render({family:'redis',metadata:{result:{type:'null',value:null}}},'result',helpers);
    assert.ok(pending.includes(waiting));
    assert.ok(capturedNull.includes('(nil)'));assert.ok(!capturedNull.includes(waiting));
  }
  setLanguage('en');
});
test('protocol copy switches immediately while captured content stays unchanged',()=>{
  const records = [
    {family:'quic',direction:'client_to_server',metadata:{kind:'stream_reset',errorCode:7,streamId:4,cid:'captured-id'}},
    {family:'mysql',metadata:{sql:"SELECT '响应'",capturedLength:15,originalLength:100,truncated:true}},
    {family:'redis',metadata:{command:'GET',args:['响应'],kind:'command',requestId:1,matched:false,result:{type:'map',value:[{key:{type:'bulk_string',value:'值'},value:{type:'null',value:null}}]}}},
    {family:'mqtt',metadata:{packetName:'PUBLISH',topic:'响应',qos:0,dup:true}}
  ];
  const original=JSON.stringify(records);
  for(const language of ['en','zh-CN','en']) {
    setLanguage(language);
    const tabs=records.map(record=>protocolViews.tabs(record));
    assert.equal(tabs[0][0].label,language==='en'?'Stream events':'流事件');
    for(const [index,record] of records.entries()) {
      for(const tab of tabs[index].filter(tab=>!['connection','payload'].includes(tab.id))) {
        const html=protocolViews.render(record,tab.id,helpers);
        assert.ok(html.length>30);
        if(language==='en') assert.ok(!/[\u4e00-\u9fff]/u.test(html.replaceAll('响应','').replaceAll('值','')),`Untranslated ${record.family}/${tab.id}`);
      }
    }
    assert.match(protocolViews.render(records[1],'query',helpers),/响应/);
    assert.match(protocolViews.render(records[2],'command',helpers),/响应/);
    assert.match(protocolViews.render(records[3],'overview',helpers),/class="pv-topic">响应</);
    assert.equal(JSON.stringify(records),original);
  }
});
