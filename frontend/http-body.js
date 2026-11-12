// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// Decode only the selected HTTP body; captured bytes remain unchanged.
import {apiFetch as fetch} from './api.js';
export const maxDecodedBodyBytes = 2 * 1024 * 1024;
const formats = {gzip:'gzip','x-gzip':'gzip',deflate:'deflate',br:'brotli'};

export function contentCodings(message) {
  return (message.headers || []).filter(h => h.name.toLowerCase() === 'content-encoding')
    .flatMap(h => h.value.toLowerCase().split(',')).map(value => value.trim()).filter(value => value && value !== 'identity');
}

function toBase64(data) {
  let result = '';
  for (let i=0;i<data.length;i+=16384) result += String.fromCharCode(...data.subarray(i,i+16384));
  return btoa(result);
}

// Shared Go decoding keeps gzip/deflate/Brotli available in older WebViews.
// The endpoint never fetches a URL; it receives only the selected captured bytes.
export async function serverInflate(data,format,maxBytes,deadline,signal) {
  const controller = new AbortController(), cancel = () => controller.abort();
  let timedOut = false;
  if (signal?.aborted) throw new Error('cancelled');
  if (Date.now() >= deadline) throw new Error('timeout');
  signal?.addEventListener('abort',cancel,{once:true});
  const timeout = setTimeout(() => { timedOut=true;controller.abort(); },deadline-Date.now());
  try {
    const response = await fetch('api/decode-body',{method:'POST',headers:{'Content-Type':'application/json','X-Ecapture-UI':'1'},
      body:JSON.stringify({encoding:format === 'brotli' ? 'br' : format,body:toBase64(data),maxBytes}),signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'invalid');
    if (typeof result.body !== 'string' || result.body.length > Math.ceil(maxBytes/3)*4) throw new Error('limit');
    const decoded = Uint8Array.from(atob(result.body),char => char.charCodeAt(0));
    if (decoded.length > maxBytes) throw new Error('limit');
    return decoded;
  } catch (error) {
    if (signal?.aborted) throw new Error('cancelled');
    if (timedOut) throw new Error('timeout');
    throw error;
  } finally { clearTimeout(timeout);signal?.removeEventListener('abort',cancel); }
}

async function inflate(data, format, maxBytes, deadline, signal, fallback) {
  if (signal?.aborted) throw new Error('cancelled');
  if (Date.now() >= deadline) throw new Error('timeout');
  let decoder;
  try {
    if (typeof Blob === 'undefined' || typeof Blob.prototype.stream !== 'function') throw new Error('unsupported');
    decoder = new DecompressionStream(format);
  } catch {
    if (fallback) return fallback(data,format,maxBytes,deadline,signal);
    throw new Error('unsupported');
  }
  const reader = new Blob([data]).stream().pipeThrough(decoder).getReader();
  const chunks = [];
  let length = 0, timedOut = false;
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort',cancel,{once:true});
  const timeout = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); },deadline-Date.now());
  try {
    for (;;) {
      const {value,done} = await reader.read();
      if (signal?.aborted) throw new Error('cancelled');
      if (timedOut) throw new Error('timeout');
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) throw new Error('limit');
      chunks.push(value);
    }
    const result = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk,offset); offset += chunk.length; }
    return result;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort',cancel);
    void reader.cancel().catch(() => {});
  }
}

export async function decodeHTTPBody(message, {maxBytes = maxDecodedBodyBytes, timeoutMs = 5000, signal, fallback} = {}) {
  const codings = contentCodings(message);
  if (!codings.length || !message.body) return {state:'identity',message,codings};
  if (message.truncated) return {state:'truncated',codings};
  if (codings.length > 4 || codings.some(coding => !formats[coding])) return {state:'unsupported',codings};
  try {
    let data;
    if (message.bodyEncoding === 'hex') {
      if (!/^(?:[a-f\d]{2})*$/i.test(message.body)) return {state:'invalid',codings};
      data = Uint8Array.from(message.body.match(/../g) || [],value => parseInt(value,16));
    } else data = new TextEncoder().encode(message.body);
    const encodedBytes = data.length, deadline = Date.now()+timeoutMs;
    if (message.byteLength > encodedBytes) return {state:'truncated',codings};
    for (const coding of [...codings].reverse()) {
      // HTTP deflate normally wraps zlib. Some servers send raw DEFLATE.
      const zlibHeader = data.length >= 2 && (data[0] & 15) === 8 && (data[0] >> 4) <= 7 && ((data[0] << 8)+data[1]) % 31 === 0;
      const format = coding === 'deflate' && !zlibHeader ? 'deflate-raw' : formats[coding];
      data = await inflate(data,format,maxBytes,deadline,signal,fallback);
    }
    const contentType = (message.headers || []).find(h => h.name.toLowerCase() === 'content-type')?.value || '';
    const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(contentType)?.[1] || 'utf-8';
    let body, bodyEncoding = 'utf8';
    try {
      body = new TextDecoder(charset,{fatal:true}).decode(data);
      if (body.includes('\0')) throw new Error('binary');
    } catch {
      body = Array.from(data,value => value.toString(16).padStart(2,'0')).join('');
      bodyEncoding = 'hex';
    }
    return {state:'decoded',codings,encodedBytes,message:{...message,body,bodyEncoding,byteLength:data.length,decodedBytes:data,textEncoding:charset,truncated:false}};
  } catch (error) {
    return {state:['limit','timeout','unsupported','cancelled'].includes(error.message) ? error.message : 'invalid',codings};
  }
}
