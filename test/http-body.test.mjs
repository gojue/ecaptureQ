// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {gzipSync,deflateSync,deflateRawSync,brotliCompressSync} from 'node:zlib';
import {decodeHTTPBody,serverInflate,contentCodings,maxDecodedBodyBytes} from '../frontend/http-body.js';

function message(data, coding, type = 'application/json; charset=utf-8') {
  return {headers:[{name:'Content-Encoding',value:coding},{name:'Content-Type',value:type}],body:data.toString('hex'),bodyEncoding:'hex',byteLength:data.length,truncated:false};
}
const text = '{"message":"可读的响应正文","ok":true}';
for (const [coding,compress] of [['gzip',gzipSync],['deflate',deflateSync],['deflate',deflateRawSync],['br',brotliCompressSync]]) {
  test(`decodes ${coding} with ${compress.name} and preserves captured bytes`,async () => {
    const original = message(compress(Buffer.from(text)),coding), before = JSON.stringify(original);
    const result = await decodeHTTPBody(original);
    assert.equal(result.state,'decoded'); assert.equal(result.message.body,text);
    assert.deepEqual(Buffer.from(result.message.decodedBytes),Buffer.from(text));
    assert.equal(result.message.byteLength,Buffer.byteLength(text));
    assert.equal(JSON.stringify(original),before);
  });
}
test('reverses multiple Content-Encoding layers across repeated headers',async () => {
  const input = message(brotliCompressSync(gzipSync(Buffer.from(text))),'GZip');
  input.headers.push({name:'content-encoding',value:'identity, br'});
  assert.deepEqual(contentCodings(input),['gzip','br']);
  assert.equal((await decodeHTTPBody(input)).message.body,text);
});
test('rejects checksum corruption instead of displaying unverified output',async () => {
  const data=gzipSync(Buffer.from(text));data[data.length-8]^=0xff;
  assert.equal((await decodeHTTPBody(message(data,'gzip'))).state,'invalid');
});
test('does not attempt to decode truncated capture prefixes',async () => {
  const input=message(gzipSync(Buffer.from(text)),'gzip');input.truncated=true;
  assert.equal((await decodeHTTPBody(input)).state,'truncated');
  input.truncated=false;input.byteLength++;
  assert.equal((await decodeHTTPBody(input)).state,'truncated');
});
test('stops expanding payloads at the configured byte limit',async () => {
  const input=message(gzipSync(Buffer.alloc(maxDecodedBodyBytes+1,65)),'gzip');
  assert.equal((await decodeHTTPBody(input)).state,'limit');
});
test('reports unsupported encoding and excessive layers without changing data',async () => {
  const input=message(Buffer.from('payload'),'snappy');
  assert.equal((await decodeHTTPBody(input)).state,'unsupported');
  input.headers[0].value='gzip,gzip,gzip,gzip,gzip';
  assert.equal((await decodeHTTPBody(input)).state,'unsupported');
});
test('preserves binary decoded bytes and the declared text charset',async () => {
  const binary=Buffer.from([0,255,13,10]);
  const decoded=await decodeHTTPBody(message(gzipSync(binary),'gzip','application/octet-stream'));
  assert.equal(decoded.message.bodyEncoding,'hex'); assert.equal(decoded.message.body,binary.toString('hex'));
  const latin1=Buffer.from([99,97,102,233]);
  const decodedText=await decodeHTTPBody(message(gzipSync(latin1),'gzip','text/plain; charset=iso-8859-1'));
  assert.equal(decodedText.message.body,'café');assert.deepEqual(Buffer.from(decodedText.message.decodedBytes),latin1);
});
test('empty and uncompressed bodies remain untouched',async () => {
  const empty=message(Buffer.alloc(0),'gzip');assert.equal((await decodeHTTPBody(empty)).message,empty);
  const plain={body:text,headers:[]};assert.equal((await decodeHTTPBody(plain)).message,plain);
});
test('rejects malformed hex, respects cancellation and applies timeout',async () => {
  const input=message(gzipSync(Buffer.from(text)),'gzip');
  assert.equal((await decodeHTTPBody({...input,body:'0xz1'})).state,'invalid');
  const controller=new AbortController();controller.abort();
  assert.equal((await decodeHTTPBody(input,{signal:controller.signal})).state,'cancelled');
  assert.equal((await decodeHTTPBody(input,{timeoutMs:0})).state,'timeout');
});

test('reports a browser without native decompression support',async () => {
  const native = globalThis.DecompressionStream;
  try {
    globalThis.DecompressionStream = undefined;
    assert.equal((await decodeHTTPBody(message(gzipSync(Buffer.from(text)),'gzip'))).state,'unsupported');
  } finally { globalThis.DecompressionStream = native; }
});

test('unsupported native formats use the shared decoder without changing captured bytes',async () => {
  const native=globalThis.DecompressionStream, originalFetch=globalThis.fetch;
  const input=message(brotliCompressSync(Buffer.from(text)),'br'), before=JSON.stringify(input);
  let call;
  try {
    globalThis.DecompressionStream=undefined;
    globalThis.fetch=async (url,options)=>{
      call={url,options};
      return new Response(JSON.stringify({body:Buffer.from(text).toString('base64')}));
    };
    const result=await decodeHTTPBody(input,{fallback:serverInflate});
    assert.equal(result.state,'decoded');assert.equal(result.message.body,text);
    assert.equal(JSON.stringify(input),before);
    assert.equal(call.url,'api/decode-body');
    assert.equal(call.options.headers['X-Ecapture-UI'],'1');
    assert.deepEqual(JSON.parse(call.options.body),{encoding:'br',body:Buffer.from(input.body,'hex').toString('base64'),maxBytes:maxDecodedBodyBytes});
  } finally {globalThis.DecompressionStream=native;globalThis.fetch=originalFetch;}
});
test('shared decoder respects size limits and cancellation',async () => {
  const originalFetch=globalThis.fetch;
  try {
    globalThis.fetch=async()=>new Response(JSON.stringify({body:Buffer.alloc(9).toString('base64')}));
    await assert.rejects(serverInflate(new Uint8Array(),'gzip',8,Date.now()+1000),/limit/);
    const controller=new AbortController();controller.abort();
    await assert.rejects(serverInflate(new Uint8Array(),'gzip',8,Date.now()+1000,controller.signal),/cancelled/);
    await assert.rejects(serverInflate(new Uint8Array(),'gzip',8,Date.now()-1),/timeout/);
  } finally {globalThis.fetch=originalFetch;}
});

test('a WebView without Blob streams uses the shared decoder',async () => {
  const nativeStream=Blob.prototype.stream;
  try {
    Blob.prototype.stream=undefined;
    let called=false;
    const result=await decodeHTTPBody(message(gzipSync(Buffer.from(text)),'gzip'),{fallback:async()=>{called=true;return new TextEncoder().encode(text);}});
    assert.ok(called);assert.equal(result.message.body,text);
  } finally {Blob.prototype.stream=nativeStream;}
});
