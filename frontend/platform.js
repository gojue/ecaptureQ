// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// Native facilities are deliberately separate from capture and presentation.
const nativeErrors = {
  export_failed:'无法保存文件，请检查目标目录权限',
  clipboard_failed:'无法写入系统剪贴板',
  open_url_failed:'无法打开系统浏览器',
  export_dialog_already_open:'已有一个保存窗口，请先完成或取消',
  export_exceeds_64_mib:'导出内容超过 64 MiB，请缩小筛选范围后重试',
  clipboard_exceeds_4_mib:'复制内容超过 4 MiB，请使用文件导出',
  payload_too_large:'内容超过当前操作的大小限制',
  invalid_filename:'导出文件名无效',
  invalid_external_url:'只允许打开有效的 HTTP(S) 外链',
  origin_rejected:'请求来源校验失败，请在当前 eCaptureQ 窗口重试'
};

export function createPlatformAdapter({fetch: request = globalThis.fetch, document: doc = globalThis.document,
  navigator: nav = globalThis.navigator, URL: urls = globalThis.URL, Blob: BlobType = globalThis.Blob,
  location: loc = globalThis.location, open = (...args) => globalThis.open(...args)} = {}) {
  let capabilities, readiness;
  const nativeOrigin = () => loc?.hostname === 'wails.localhost' || loc?.protocol === 'wails:';
  async function init() {
    if (!readiness) readiness = (async () => {
      const controller = new AbortController(), timeout = setTimeout(() => controller.abort(),5000);
      try {
        const response = await request('api/platform',{cache:'no-store',signal:controller.signal});
        if (!response.ok) throw new Error('platform_unavailable');
        capabilities = await response.json();
        return capabilities;
      } catch (error) {
        if (nativeOrigin()) throw new Error('桌面能力接口不可用，请重启应用');
        return capabilities = {desktop:false};
      } finally { clearTimeout(timeout); }
    })();
    return readiness;
  }
  async function invoke(action,payload) {
    const response = await request('api/platform/'+action,{method:'POST',headers:{'Content-Type':'application/json','X-Ecapture-UI':'1'},body:JSON.stringify(payload)});
    const result = await response.json();
    if (!response.ok) throw new Error(nativeErrors[result.error] || result.error || '桌面操作失败');
    return result;
  }
  async function copyText(text) {
    const mode = await init();
    if (mode.desktop) return invoke('clipboard',{text});
    try {
      if (!nav?.clipboard?.writeText) throw new Error('clipboard_unavailable');
      await nav.clipboard.writeText(text);
    } catch {
      // HTTP deployments may not be secure contexts. Selection is only a local
      // clipboard fallback; captured content is never interpreted as markup.
      const selection = doc.activeElement, input = doc.createElement('textarea');
      input.value = text; input.setAttribute('readonly','');
      Object.assign(input.style,{position:'fixed',left:'-9999px',top:'0'});
      doc.body.appendChild(input); input.select();
      try { if (!doc.execCommand('copy')) throw new Error('复制未获允许，请选择正文复制'); }
      finally { input.remove(); selection?.focus(); }
    }
  }
  async function exportJSON(filename,content) {
    const mode = await init();
    if (mode.desktop) return invoke('export',{filename,content});
    if (!BlobType || !urls?.createObjectURL) throw new Error('当前浏览器不支持文件下载');
    const url = urls.createObjectURL(new BlobType([content],{type:'application/json'})), link = doc.createElement('a');
    link.href = url; link.download = filename; link.hidden = true;
    doc.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => urls.revokeObjectURL(url),60000).unref?.();
    return {saved:true,cancelled:false};
  }
  async function openExternal(url) {
    const parsed = new urls(url);
    if (!['http:','https:'].includes(parsed.protocol)) throw new Error('只允许打开 HTTP(S) 外链');
    const mode = await init();
    if (mode.desktop) return invoke('open-url',{url:parsed.href});
    open(parsed.href,'_blank','noopener,noreferrer');
    return {ok:true};
  }
  return {init,copyText,exportJSON,openExternal,get desktop() { return capabilities?.desktop || nativeOrigin(); }};
}

// AbortSignal.timeout is absent in some supported system WebView versions.
export async function fetchWithTimeout(url,options = {},timeoutMs = 15000,request = globalThis.fetch) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(),timeoutMs);
  const cancel = () => controller.abort();
  options.signal?.addEventListener('abort',cancel,{once:true});
  if (options.signal?.aborted) controller.abort();
  try { return await request(url,{...options,signal:controller.signal}); }
  finally { clearTimeout(timer); options.signal?.removeEventListener('abort',cancel); }
}

export const platform = createPlatformAdapter();
