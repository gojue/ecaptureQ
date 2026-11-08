import { t, getLanguage, setLanguage, translateStatic, sourceMessage } from './i18n.js';
import { presentationNote, processName, recordPlaceholderTitle, recordPlaceholderHost } from './presentation.js';
import { displayConnectionId } from './connection-display.js';
import { initLayout } from './layout.js';
import { initSourceMetadata } from './source-form.js';
import { protocolViews } from './protocol-viewers.js';
import { contentCodings, decodeHTTPBody, serverInflate, maxDecodedBodyBytes } from './http-body.js';
import { platform, fetchWithTimeout } from './platform.js';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icon = (name, className = 'icon') => `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const safeClass = value => String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g,'');
const bytes = (n = 0) => !Number.isFinite(n) || n < 0 ? '—' : n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
const duration = (n) => !Number.isFinite(n) || n < 0 ? '—' : n >= 1000 ? `${(n / 1000).toFixed(2)} s` : `${n} ms`;
const statusNames = {200:'成功',201:'已创建',204:'无内容',304:'未修改',400:'无效请求',401:'未经授权',403:'禁止访问',404:'未找到',429:'请求过多',500:'服务器内部错误',502:'网关错误',503:'服务不可用'};
const protocolFilters = [{id:'http',label:'HTTP/1 · 2'},{id:'http3',label:'HTTP/3'},{id:'quic',label:'QUIC'},{id:'mysql',label:'MySQL'},{id:'redis',label:'Redis'},{id:'mqtt',label:'MQTT'},{id:'raw',get label() { return t("其他 / 原始"); }}];
const state = {scope:'all',process:null,protocol:null,domain:null,filter:'all',query:'',selected:null,tab:'request',viewer:'pretty',bodySource:'decoded',wrap:true,bookmarks:new Set(),running:false,mode:'mock',paused:false};
let workspace, requests = [], seeds = [], timer, toastTimer, sequence = 0, pollTimer, loadController, loadGeneration = 0, revision = null, serverStatus = {}, serviceError = '';

let toastMessage;
function toast(message, params = {}) {
  const element = $('#toast');
  toastMessage = () => t(sourceMessage(message),typeof params === 'function' ? params() : params);
  element.textContent = toastMessage();
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 2600);
}

function processFor(id) { return workspace.processes.find(p => p.id === id) || {id,name:t("未知进程"),pid:null,kind:t("未提供"),command:''}; }
function processLabel(process) { return process.pid > 0 ? String(process.pid) : t("PID 未提供"); }
function processAppearance(id) {
  const appearances = {'checkout-api':['go','Go'],'h3-client':['go','H3'],'edge-tunnel':['quic','Q'],'mysqld':['mysql','My'],'redis-worker':['redis','R'],'mqtt-agent':['mqtt','M'],'nginx':['nginx','N'],'python':['python','Py']};
  return appearances[id] || ['curl','>_'];
}
function avatar(process) {
  const [kind, label] = processAppearance(process.id);
  return `<span class="process-avatar ${kind}" aria-hidden="true">${label}</span>`;
}
function family(record) { return record.family || 'http'; }
function isHTTP(record) { return family(record) === 'http'; }
function hasHTTPURL(record) { return isHTTP(record) && record.hasRequest !== false && (!record.real || ['host_header','authority_metadata'].includes(record.metadata?.hostSource)); }
function protocolKey(record) { return isHTTP(record) ? record.protocol === 'HTTP/3' ? 'http3' : 'http' : family(record); }
function operation(record) { return (isHTTP(record) ? record.method : record.operation) || record.protocol || 'EVENT'; }
function recordTitle(record) { return recordPlaceholderTitle(record) || (isHTTP(record) ? record.path : record.summary) || record.summary || t("未捕获请求路径"); }
function isError(record) { return (isHTTP(record) && record.status >= 400) || record.state === 'failed' || record.outcome === 'error'; }
function needsAttention(record) { return isError(record) || record.state === 'partial'; }
function header(message, name) { return message?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''; }
function hasJSON(record) {
  if (isHTTP(record)) return header(record.response,'content-type').includes('json');
  if (record.payloadEncoding === 'hex' || !record.payload) return false;
  try { JSON.parse(record.payload); return true; } catch { return false; }
}
function shortStatus(record) {
  if (record.state === 'pending') return t("未配对");
  if (record.state === 'partial') return t("截断");
  if (record.state === 'failed') return t("失败");
  if (isHTTP(record)) return record.status || t("观测");
  if (isError(record)) return t("异常");
  if (record.metadata?.kind === 'push') return t("推送");
  if (record.metadata?.kind === 'stream_reset') return t("重置");
  return t("观测");
}
const recordDetails = new Map();
let pageIndex = 0, pageTimer, detailController, detailLoading = '';
function isPaged() { return state.mode === 'live' && !!workspace?.page; }
function liveFilters() { return {process:state.process || '',protocol:state.protocol || '',domain:state.domain || '',scope:state.scope,filter:state.filter,q:state.query.trim(),bookmarks:[...state.bookmarks].join(',')}; }
function filterKey() { return JSON.stringify(liveFilters()); }
function selected() {
  const row = requests.find(r => r.id === state.selected), cached = row && recordDetails.get(row.id);
  return isPaged() && cached && cached.version === row?.detailVersion && cached.record ? cached.record : row;
}
function schedulePage() { clearTimeout(pageTimer);pageTimer=setTimeout(()=>refreshLive(true),180); }
async function loadRecordDetail(row) {
  const key=row.id+':'+row.detailVersion;
  if(detailLoading===key)return;
  detailController?.abort();
  const controller=new AbortController();detailController=controller;detailLoading=key;
  let timedOut=false;
  const timeout=setTimeout(()=>{timedOut=true;controller.abort();},15000);
  try {
    const response=await fetch('api/record?id='+encodeURIComponent(row.id),{cache:'no-store',signal:controller.signal});
    if(!response.ok)throw Object.assign(new Error(response.status===404?"此记录已超出保留范围，请刷新列表。":"详情暂时不可用。"),{uiMessage:true});
    const record=await response.json();
    recordDetails.set(row.id,{version:row.detailVersion,record});
  } catch(error) {
    if(error.name==='AbortError' && !timedOut)return;
    recordDetails.set(row.id,{version:row.detailVersion,error:timedOut?"详情读取超时，请重试。":error.uiMessage ? error.message : "详情暂时不可用。"});
  } finally { clearTimeout(timeout);if(detailLoading===key)detailLoading=''; }
  while(recordDetails.size>4)recordDetails.delete(recordDetails.keys().next().value);
  if(isPaged()&&state.selected===row.id&&requests.find(r=>r.id===row.id)?.detailVersion===row.detailVersion)renderDetail();
}
function matchesProcess(record, id) {
  return record.processId === id || record.responseProcess?.id === id;
}
function baseRequests({ignoreProtocol = false, ignoreProcess = false} = {}) {
  return requests.filter(r => (ignoreProcess || !state.process || matchesProcess(r, state.process)) && (ignoreProtocol || !state.protocol || protocolKey(r) === state.protocol) && (state.scope !== 'starred' || state.bookmarks.has(r.id)));
}
function filteredRequests({ignoreProtocol = false} = {}) {
  if (isPaged()) return requests;
  const query = state.query.trim().toLowerCase();
  return baseRequests({ignoreProtocol}).filter(r => {
    if (state.domain && r.host !== state.domain) return false;
    if (state.filter === 'errors' && !needsAttention(r)) return false;
    if (state.filter === 'pending' && r.state !== 'pending') return false;
    if (state.filter === 'json' && !hasJSON(r)) return false;
    if (!query) return true;
    const process = processFor(r.processId);
    return [r.method,r.operation,r.host,r.path,r.summary,r.status,r.protocol,process.name,process.pid,r.responseProcess?.name,r.responseProcess?.pid,r.processCommand,r.responseProcess?.command,r.request?.body,r.response?.body,r.payload,JSON.stringify(r.metadata || {}),
      ...(r.request?.headers || []).flatMap(h => [h.name,h.value]),...(r.response?.headers || []).flatMap(h => [h.name,h.value])].join(' ').toLowerCase().includes(query);
  });
}

function renderSidebar() {
  $('#all-count').textContent = workspace.page?.retained ?? requests.length;
  $('#starred-count').textContent = state.bookmarks.size;
  $('#process-count').textContent = workspace.processes.length;
  $('#clear-process').hidden = !state.process;
  $$('[data-scope]').forEach(button => {
    const active = state.scope === button.dataset.scope && !state.process;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  });
  const protocolCounts = new Map(isPaged() ? Object.entries(workspace.page.protocolCounts) : []);
  if (!isPaged()) filteredRequests({ignoreProtocol:true}).forEach(record => protocolCounts.set(protocolKey(record),(protocolCounts.get(protocolKey(record)) || 0)+1));
  const availableProtocols = protocolFilters.filter(protocol => protocolCounts.get(protocol.id) > 0);
  $('#protocol-section').hidden = availableProtocols.length === 0;
  $('#protocol-list').innerHTML = availableProtocols.map(protocol => `<button class="protocol-filter ${state.protocol === protocol.id ? 'active' : ''}" data-protocol="${protocol.id}" aria-pressed="${state.protocol === protocol.id}"><span>${protocol.label}</span><span>${protocolCounts.get(protocol.id)}</span></button>`).join('');
  $('#clear-protocol').hidden = !state.protocol;
  $('#process-list').innerHTML = workspace.processes.map(process => {
    const count = isPaged() ? (workspace.page.processCounts[process.id] || 0) : baseRequests({ignoreProcess:true}).filter(r => matchesProcess(r, process.id)).length;
    return `<button class="process-item ${state.process === process.id ? 'active' : ''} ${count === 0 ? 'no-matches' : ''}" data-process="${escapeHTML(process.id)}" aria-pressed="${state.process === process.id}" aria-label="${escapeHTML(t("筛选 {name}，{pid}",{name:processName(process),pid:processLabel(process)}))}">${avatar(process)}<span class="process-info"><span class="process-name">${escapeHTML(processName(process))}</span><span class="process-meta">${escapeHTML(processLabel(process))} · ${escapeHTML(process.kind || process.source || '')}</span></span><span class="process-count">${count}</span></button>`;
  }).join('');
  const domains = new Map(isPaged() ? Object.entries(workspace.page.domains) : []);
  if (!isPaged()) baseRequests().forEach(r => domains.set(r.host,(domains.get(r.host) || 0) + 1));
  $('#domain-list').innerHTML = [...domains].sort((a,b) => b[1]-a[1]).map(([host,count]) => `<button class="domain-item ${state.domain === host ? 'active' : ''}" data-domain="${escapeHTML(host)}" aria-pressed="${state.domain === host}" title="${escapeHTML(host)}">${icon('chevron')}<span>${escapeHTML(host)}</span><span>${count}</span></button>`).join('');
  $('#clear-domain').hidden = !state.domain;
}

function renderList({scrollToSelected = false, preserveDetail = false} = {}) {
  const previousSelected = state.selected;
  const focusedRequest = document.activeElement?.dataset.request;
  const list = filteredRequests();
  if (!list.some(r => r.id === state.selected)) state.selected = list[0]?.id ?? null;
  const scopeLabel = state.process ? processName(processFor(state.process)) : state.scope === 'starred' ? t("已标记") : t("全部流量");
  $('#scope-title').textContent = state.protocol ? `${scopeLabel} · ${protocolFilters.find(p => p.id === state.protocol).label}` : scopeLabel;
  $('#visible-count').textContent = workspace.page?.total ?? list.length;
  $('#error-count').textContent = workspace.page?.errors ?? baseRequests().filter(needsAttention).length;
  $$('[data-filter]').forEach(button => {
    button.classList.toggle('active',button.dataset.filter === state.filter);
    button.setAttribute('aria-pressed',String(button.dataset.filter === state.filter));
  });
  const tags = [];
  if (state.process) { const p=processFor(state.process); tags.push(['process',t("进程 {p0} · {p1}",{p0:processName(p),p1:processLabel(p)})]); }
  if (state.protocol) tags.push(['protocol',protocolFilters.find(p=>p.id===state.protocol)?.label || state.protocol]);
  if (state.scope === 'starred') tags.push(['scope',t("已标记")]);
  if (state.domain) tags.push(['domain',t("主机 {p0}",{p0:state.domain})]);
  if (state.filter !== 'all') tags.push(['filter',{errors:t("异常"),pending:t("未配对"),json:'JSON'}[state.filter]]);
  if (state.query) tags.push(['query',t("搜索 {p0}",{p0:state.query})]);
  $('#active-filters').hidden = tags.length === 0;
  $('#filter-tags').innerHTML = tags.map(([key,label])=>`<button class="active-filter-tag" data-clear-filter="${key}" aria-label="${escapeHTML(t("清除 {label}",{label}))}" title="${escapeHTML(t("清除 {label}",{label}))}"><span>${escapeHTML(label)}</span>${icon('close')}</button>`).join('');
  $('#request-list').innerHTML = list.length ? list.map((request,index) => {
    const statusClass = isError(request) ? 'error' : ['pending','partial'].includes(request.state) ? 'pending' : !isHTTP(request) || request.status >= 300 ? 'redirect' : '';
    const label = shortStatus(request), op = operation(request), title = recordTitle(request);
    return `<button class="request-row request-grid ${state.selected === request.id ? 'selected' : ''} ${request.fresh ? 'fresh' : ''}" data-request="${escapeHTML(request.id)}" data-family="${escapeHTML(family(request))}" role="listitem" aria-label="${escapeHTML(request.protocol+' '+op+' '+title+'，'+label)}" aria-current="${state.selected === request.id}"><span class="row-index col-index">${state.bookmarks.has(request.id) ? icon('star') : String((workspace.page?.index || 0)*(workspace.page?.size || 0)+index+1).padStart(2,'0')}</span><span class="status-code ${statusClass}" title="${escapeHTML(label)}">${escapeHTML(label)}</span><span class="row-method ${safeClass(isHTTP(request) ? op : family(request))}" title="${escapeHTML(op)}">${escapeHTML(op)}</span><span class="row-name"><span class="row-path" title="${escapeHTML(title)}">${escapeHTML(title)}</span><span class="row-host"><span class="inline-protocol">${escapeHTML(request.protocol)}</span>${request.real ? ' · '+escapeHTML(sourceFor(request)?.capture?.module || request.sourceId) : ''} · ${escapeHTML(recordPlaceholderHost(request) || request.host || t("主机未提供"))}</span></span><span class="col-duration ${request.durationMs >= 1000 ? 'slow' : ''}">${duration(request.durationMs)}</span><span class="col-size">${bytes(request.sizeBytes)}</span></button>`;
  }).join('') : `<div class="empty-list">${icon(state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? 'activity' : 'search','large-icon')}<h3>${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? t("等待真实采集事件") : state.scope === 'starred' && !state.bookmarks.size ? t("还没有标记的记录") : t("没有匹配的记录")}</h3><p>${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? t("连接状态可在右上角查看；采集器连接后，新流量会自动出现。") : state.scope === 'starred' && !state.bookmarks.size ? t("点击详情右上角的星标，留住排查线索") : t("试试其他协议、进程或关键词")}</p><button ${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? 'data-open-connection' : 'data-reset-filters'}>${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? t("查看数据源") : t("查看全部流量")}</button></div>`;
  const page = isPaged() ? workspace.page : null;
  $('#list-summary').textContent = page ? t("显示 {p0}–{p1} / {p2} 条",{p0:list.length ? page.index*page.size+1 : 0,p1:page.index*page.size+list.length,p2:page.total}) : t("显示 {p0} / {p1} 条记录",{p0:list.length,p1:requests.length});
  $('#page-controls').hidden = !page;
  $('#page-prev').disabled = !page || page.index===0;
  $('#page-next').disabled = !page || (page.index+1)*page.size>=page.total;
  $('#export-data').innerHTML = icon('download')+(page ? t("导出当前页 JSON") : t("导出 JSON"));
  $('#total-size').textContent = bytes(list.reduce((sum,r) => sum+r.sizeBytes,0));
  if (scrollToSelected) $(`[data-request="${state.selected}"]`)?.scrollIntoView({block:'nearest'});
  if (focusedRequest && list.some(r => r.id === focusedRequest)) $(`[data-request="${focusedRequest}"]`)?.focus({preventScroll:true});
  if (!preserveDetail || previousSelected !== state.selected) renderDetail();
}

function statusLabel(request) {
  if (request.state === 'pending') return t("尚未关联最终响应");
  if (request.state === 'failed') return t("连接失败");
  if (request.state === 'partial') return t("部分捕获");
  if (!isHTTP(request)) {
    if (isError(request)) return family(request) === 'mysql' ? t("派发返回异常") : t("协议错误");
    if (request.metadata?.kind === 'push') return t("服务端推送");
    if (request.metadata?.kind === 'stream_reset') return t("流已重置");
    if (family(request) === 'mysql') return t("SQL 事件已捕获");
    return t("已观测");
  }
  return request.status ? `${request.status} ${t(statusNames[request.status])}`.trim() : t("已观测");
}

function detailTabs(record) {
  if (isHTTP(record)) return [{id:'request',label:t("请求")},{id:'response',label:t("响应")},{id:'connection',label:t("连接")}];
  const tabs = protocolViews.tabs(record);
  return tabs.length ? tabs : [{id:'payload',label:t("原始载荷")},{id:'connection',label:t("事件信息")}];
}
function endpointLabel(record) {
  if (hasHTTPURL(record)) return `${record.scheme || 'https'}://${record.host}${record.path || ''}`;
  if (record.real) return `${record.sourceAddress || t("源端点未提供")} → ${record.destinationAddress || t("目标端点未提供")}`;
  return t("{p0} · 本地 {p1} · 远端 {p2}",{p0:record.host,p1:record.localAddress,p2:record.remoteAddress});
}

function renderDetail() {
  clearImagePreview();
  const request = selected();
  $('#detail-empty').hidden = !!request;
  $('#detail-view').hidden = !request;
  $('#selection-status').textContent = request ? `${processName(processFor(request.processId))} · ${request.id}` : t("未选择记录");
  $('#protocol-status').textContent = request ? `${request.protocol}${request.transport ? ' · '+request.transport.toUpperCase() : ''}` : t("多协议工作区");
  if (!request) return;
  const process = processFor(request.processId);
  const tabs = detailTabs(request);
  const tabFamily = family(request) === 'redis' ? `redis:${request.metadata.kind}` : family(request);
  if (state.tabFamily !== tabFamily || !tabs.some(tab => tab.id === state.tab)) state.tab = tabs[0].id;
  state.tabFamily = tabFamily;
  $('#detail-method').textContent = operation(request);
  $('#detail-method').className = `method-badge ${isHTTP(request) ? (request.method || '').toLowerCase() : family(request)}`;
  $('#detail-path').textContent = recordTitle(request);
  $('#detail-path').title = recordTitle(request);
  $('#detail-url').textContent = endpointLabel(request);
  $('#detail-url').title = $('#detail-url').textContent;
  $('.detail-url-row>svg use').setAttribute('href',family(request) === 'mysql' ? '#i-terminal' : '#i-link');
  $('#copy-url').setAttribute('aria-label',hasHTTPURL(request) ? t("复制请求 URL") : t("复制事件端点"));
  $('#copy-url').title = hasHTTPURL(request) ? t("复制 URL") : t("复制端点");
  $('#bookmark-request').setAttribute('aria-pressed',String(state.bookmarks.has(request.id)));
  $('#bookmark-request').setAttribute('aria-label',state.bookmarks.has(request.id) ? t("取消标记记录") : t("标记记录"));
  $('#bookmark-request').title = state.bookmarks.has(request.id) ? t("取消标记") : t("加入左侧「已标记」（当前页面会话）");
  $('#request-facts').innerHTML = `<span class="fact-status ${isError(request) ? 'error' : ['pending','partial'].includes(request.state) ? 'pending' : ''}">${icon(needsAttention(request) ? 'alert' : request.state === 'pending' ? 'activity' : 'check')}${escapeHTML(statusLabel(request))}</span><span class="fact-divider"></span><span>${escapeHTML(request.protocol)}</span>${request.durationMs !== null && request.durationMs !== undefined ? `<span class="fact-divider"></span><span title="${request.real ? t("观测耗时") : t("模拟观测耗时")}">${duration(request.durationMs)}</span>` : ''}<span class="fact-divider"></span><span class="fact-process">${icon('terminal')}${escapeHTML(processName(process))}</span>`;
  $('#detail-tabs').innerHTML = tabs.map(tab => `<button id="tab-${tab.id}" role="tab" aria-controls="tab-content" aria-selected="${tab.id === state.tab}" data-tab="${tab.id}">${escapeHTML(tab.label)}</button>`).join('')+`<div class="tabs-spacer"></div>${hasHTTPURL(request) && request.request && request.request.bodyEncoding !== 'hex' ? `<button class="icon-button compact" id="copy-curl" aria-label="${t("复制为 cURL")}" title="${t("复制为 cURL")}">${icon('terminal')}</button>` : ''}`;
  $('#tab-content').setAttribute('aria-labelledby',`tab-${state.tab}`);
  const summary = requests.find(r=>r.id===state.selected), detail = recordDetails.get(state.selected);
  if (isPaged() && (!detail || detail.version!==summary?.detailVersion || !detail.record)) {
    $('#tab-content').innerHTML = `<div class="empty-body"><strong>${escapeHTML(detail?.version===summary?.detailVersion && detail.error ? t(detail.error) : t("正在读取详情…"))}</strong>${detail?.error ? `<button class="text-button" id="retry-detail">${t("重试")}</button>` : ''}</div>`;
    if (!detail || detail.version!==summary?.detailVersion) void loadRecordDetail(summary);
    return;
  }
  if (state.tab === 'connection') renderConnection(request,process);
  else if (isHTTP(request)) renderMessage(request);
  else if (state.tab === 'payload') renderProtocolPayload(request);
  else $('#tab-content').innerHTML = protocolViews.render(request,state.tab,{escapeHTML,icon,bytes});
}

let imagePreviewURL = null;
function clearImagePreview() {
  if (imagePreviewURL) URL.revokeObjectURL(imagePreviewURL);
  imagePreviewURL = null;
}
const decodedBodies = new Map();
function bodyState(request, tab) {
  const message = request[tab] || {headers:[],body:''}, key = request.id+':'+tab;
  if (!contentCodings(message).length || !message.body) return {state:'identity',message};
  const signature = [message.body, message.bodyEncoding, message.byteLength, message.truncated, JSON.stringify(message.headers)];
  const existing = decodedBodies.get(key);
  if (existing && existing.signature.every((value,index) => value === signature[index])) return existing;
  existing?.controller.abort();
  const entry = {state:'loading',codings:contentCodings(message),signature,controller:new AbortController()};
  decodedBodies.delete(key); decodedBodies.set(key,entry);
  while (decodedBodies.size > 4) {
    const oldest = decodedBodies.keys().next().value;
    decodedBodies.get(oldest).controller.abort();
    decodedBodies.delete(oldest);
  }
  void decodeHTTPBody(message,{signal:entry.controller.signal,fallback:serverInflate}).then(result => {
    Object.assign(entry,result);
    const current = selected();
    if (decodedBodies.get(key) === entry && current?.id === request.id && state.tab === tab && current[tab]?.body === message.body) {
      const scroll = $('#tab-content').scrollTop;
      renderMessage(current);
      $('#tab-content').scrollTop = scroll;
    }
  });
  return entry;
}
function displayedMessage(request, tab) {
  const decoded = bodyState(request,tab);
  return state.bodySource !== 'encoded' && decoded.state === 'decoded' ? decoded.message : request[tab] || {headers:[],body:''};
}
function compressionControls(message, decoded) {
  if (!contentCodings(message).length || !message.body) return '';
  const errors = {unsupported:t("当前环境不支持这种压缩格式，保留原始字节。"),truncated:t("压缩正文未完整捕获，无法可靠解压。"),invalid:t("解压失败：压缩数据不完整、校验未通过或解码服务不可用。"),limit:t("解压内容超过 {p0} 上限，已停止解压。",{p0:bytes(maxDecodedBodyBytes)}),timeout:t("解压超时，已停止处理。")};
  const available = decoded.state === 'decoded';
  const status = available ? `${bytes(decoded.encodedBytes)} → ${bytes(decoded.message.byteLength)}` : decoded.state === 'loading' ? t("正在解压…") : errors[decoded.state] || '';
  return `<div class="compression-controls"><span><strong>${escapeHTML(decoded.codings.join(', '))}</strong> · ${escapeHTML(status)}</span><div class="viewer-tabs" aria-label="${t("压缩正文来源")}"><button data-body-source="decoded" ${available ? '' : 'disabled'} class="${state.bodySource !== 'encoded' ? 'active' : ''}" aria-pressed="${state.bodySource !== 'encoded'}">${t("解压后")}</button><button data-body-source="encoded" class="${state.bodySource === 'encoded' ? 'active' : ''}" aria-pressed="${state.bodySource === 'encoded'}">${t("原始压缩")}</button></div></div>`;
}

function renderMessage(request) {
  const original = request[state.tab] || {headers:[],body:''};
  const decoded = bodyState(request,state.tab), message = displayedMessage(request,state.tab);
  const contentType = header(message,'content-type'), imageType = /^image\//i.test(contentType.trim());
  if (imageType && state.viewer === 'pretty') state.viewer = 'raw';
  const typeLabel = imageType ? t("图片") : message.bodyEncoding === 'hex' ? t("二进制") : contentType.includes('json') ? 'JSON' : contentType.includes('html') ? 'HTML' : contentType.includes('css') ? 'CSS' : contentType.includes('text') ? t("文本") : message.body ? t("文本") : t("空");
  const transportStrip = request.protocol === 'HTTP/3' ? `<div class="transport-strip">${icon('activity')}<strong>HTTP/3</strong><span>QUIC${request.metadata?.quicVersion ? ' '+escapeHTML(request.metadata.quicVersion) : ''}</span><span>Stream ${escapeHTML(request.streamId ?? request.metadata?.streamId ?? t("未提供"))}</span>${request.metadata?.alpn ? `<span>${escapeHTML(request.metadata.alpn)}</span>` : ''}</div>` : '';
  let notice = '';
  if (state.tab === 'response') {
    if (request.state === 'pending') notice = `<div class="message-notice pending">${icon('activity')}<div><strong>${t("已捕获请求，尚未关联最终响应")}</strong><p>${request.real ? t("这表示当前没有可配对的最终响应，不代表服务端仍在处理。连接提前关闭、响应未捕获或关联信息缺失都可能造成这种状态。") : t("请求内容可在「请求」页查看。此条为固定模拟场景。")}</p></div></div>`;
    else if (request.state === 'failed') notice = `<div class="message-notice">${icon('alert')}<div><strong>${t("连接未能完成")}</strong><p>${escapeHTML(presentationNote(request) || t("未获取到应用层响应，此处没有 HTTP 状态码。"))}</p></div></div>`;
    else if (request.status >= 400) notice = `<div class="message-notice">${icon('alert')}<div><strong>${request.status === 502 ? t("上游服务返回错误") : t("HTTP 请求返回错误")}</strong><p>${request.status === 502 ? t("响应消息已完整捕获，可检查下方错误正文。") : t("查看响应正文与 Headers，了解服务端返回的原因。")}</p></div></div>`;
  }
  if (request.real && request.hasRequest === false && state.tab === 'request') notice = `<div class="message-notice pending">${icon('info')}<div><strong>${t("请求未捕获")}</strong><p>${t("这是一条未关联请求的响应记录，保留已收到的响应内容。")}</p></div></div>`;
  if (request.real && request.note) notice += `<div class="record-note">${icon('info')}<span>${escapeHTML(presentationNote(request))}</span></div>`;
  if (request.real && request.hasRequest && !hasHTTPURL(request)) notice += `<div class="record-note">${icon('info')}<span>${t("采集事件未提供 Host / authority，上方保留网络端点；不据此推算请求 URL。")}</span></div>`;
  $('#tab-content').innerHTML = `${transportStrip}${notice}<h3 class="section-heading">${icon('down')}${state.tab === 'response' ? t("响应头") : t("请求头")}<span>${message.headers.length}</span><span class="heading-end">Headers</span></h3><div class="header-table">${message.headers.length ? message.headers.map(h => `<div class="header-pair"><span class="header-key">${escapeHTML(h.name.toLowerCase())}</span><span class="header-value ${h.value.includes('[REDACTED]') ? 'redacted' : ''}">${escapeHTML(h.value)}</span></div>`).join('') : `<div class="header-pair"><span class="header-key">${t("暂无 Headers")}</span><span class="header-value">—</span></div>`}</div><section class="body-section"><h3 class="section-heading">${icon('down')}${state.tab === 'response' ? t("响应正文") : t("请求正文")}<span class="heading-end">${typeLabel} · ${bytes(message.byteLength ?? payloadBytes({body:message.body,encoding:message.bodyEncoding}).length)}</span></h3>${compressionControls(original,decoded)}<div class="body-toolbar"><div class="viewer-tabs" aria-label="${t("正文显示方式")}">${imageType ? '' : `<button data-viewer="pretty" class="${state.viewer === 'pretty' ? 'active' : ''}" aria-pressed="${state.viewer === 'pretty'}">${typeLabel === 'HTML' ? t("预览") : t("格式化")}</button>`}<button data-viewer="raw" class="${state.viewer === 'raw' ? 'active' : ''}" aria-pressed="${state.viewer === 'raw'}">${t("原文")}</button><button data-viewer="hex" class="${state.viewer === 'hex' ? 'active' : ''}" aria-pressed="${state.viewer === 'hex'}">Hex</button></div><div class="body-tools"><button class="icon-button compact ${state.wrap ? 'active' : ''}" data-wrap aria-label="${t("自动换行")}" aria-pressed="${state.wrap}" title="${t("自动换行")}">${icon('wrap')}</button><button class="icon-button compact" data-copy-body aria-label="${t("复制正文")}" title="${t("复制正文")}" ${message.body ? '' : 'disabled'}>${icon('copy')}</button></div></div><div class="body-view" id="body-view"></div></section>`;
  renderBody(message,contentType,request);
}

function prettyBody(message) {
  try { return JSON.stringify(JSON.parse(message.body),null,2); } catch { return message.body; }
}
function highlightJSON(line) {
  const regex = /("(?:\\.|[^"\\])*"\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
  let html = '', cursor = 0;
  for (const match of line.matchAll(regex)) {
    html += escapeHTML(line.slice(cursor,match.index));
    const type = match[1] ? 'key' : match[2] ? 'string' : match[3] ? 'bool' : 'number';
    html += `<span class="token-${type}">${escapeHTML(match[0])}</span>`;
    cursor = match.index+match[0].length;
  }
  return html+escapeHTML(line.slice(cursor));
}
function hexDump(text) {
  const data = text instanceof Uint8Array ? text : new TextEncoder().encode(text), lines = [];
  for (let offset = 0; offset < data.length; offset += 16) {
    const chunk = [...data.slice(offset,offset+16)];
    const hex = chunk.map(value => value.toString(16).padStart(2,'0')).join(' ').padEnd(47,' ');
    lines.push(`${offset.toString(16).padStart(8,'0')}  ${hex}  ${chunk.map(b => b >= 32 && b <= 126 ? String.fromCharCode(b) : '.').join('')}`);
  }
  return lines.join('\n');
}
function renderBody(message,contentType,request) {
  clearImagePreview();
  const target = $('#body-view');
  if (!message.body) {
    const waiting = state.tab === 'response' && request.state === 'pending';
    const failed = state.tab === 'response' && request.state === 'failed';
    const missing = request.real && (state.tab === 'request' ? request.hasRequest === false : request.hasResponse === false);
    target.innerHTML = `<div class="empty-body">${icon(waiting ? 'activity' : failed ? 'alert' : 'code')}<strong>${missing ? t("尚未捕获此消息") : waiting ? t("尚未关联响应消息") : failed ? t("未收到响应正文") : t("此消息没有正文")}</strong><span>${waiting && !request.real ? t("此样例没有可关联的最终响应") : failed ? t("请查看连接信息或采集诊断") : t("保留已观测到的 Headers 和事件信息")}</span></div>`;
    return;
  }
  if (state.viewer === 'raw' && /^image\//i.test(contentType.trim())) {
    renderImageBody(target,message,contentType);
    return;
  }
  if (state.viewer === 'pretty' && contentType.includes('html') && message.bodyEncoding !== 'hex') {
    target.innerHTML = `<iframe class="preview-frame" title="${t("隔离的 HTML 响应预览")}" sandbox="" inert tabindex="-1" referrerpolicy="no-referrer" style="pointer-events:none"></iframe><div class="body-meta"><span>${t("只读 HTML 预览 · 脚本与外部资源已禁用")}</span><span>UTF-8</span></div>`;
    // The iframe itself is inert. Captured CSS cannot re-enable links and cause
    // network requests by overriding a pointer-events rule inside the document.
    $('iframe',target).srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{font:14px/1.6 -apple-system,sans-serif;padding:14px;color:#273142;overflow-wrap:anywhere}a{pointer-events:none}</style>${message.body}`;
    return;
  }
  const text = payloadText({body:message.body,encoding:message.bodyEncoding || 'utf8',bytes:message.decodedBytes});
  const highlight = state.viewer === 'pretty' && contentType.includes('json') && message.bodyEncoding !== 'hex';
  const lines = text.split('\n');
  target.innerHTML = `<div class="code-window ${state.wrap ? 'wrap' : ''}"><pre aria-label="${state.tab === 'response' ? t("响应正文") : t("请求正文")}"><code>${lines.map((line,index) => `<span class="code-line"><span class="line-no" aria-hidden="true">${index+1}</span><span class="line-text">${highlight ? highlightJSON(line) : escapeHTML(line) || ' '}</span></span>`).join('')}</code></pre></div><div class="body-meta"><span>${t("{count} 行",{count:lines.length})}${state.viewer === 'hex' ? ' · Hex' : ''}</span><span>${message.bodyEncoding === 'hex' ? t("二进制 · Hex") : escapeHTML((message.textEncoding || 'UTF-8').toUpperCase())}</span></div>`;
}

function renderImageBody(target,message,contentType) {
  const unavailable = (title,detail) => {
    target.innerHTML = `<div class="empty-body image-unavailable">${icon('info')}<strong>${escapeHTML(title)}</strong><span>${escapeHTML(detail)}</span></div>`;
  };
  if (contentCodings(message).length && !message.decodedBytes) {
    unavailable(t("当前为压缩数据"), t("图片需要成功解压后才能预览；可切换 Hex 查看已捕获字节。"));
    return;
  }
  if (message.bodyEncoding === 'hex' && !/^(?:[a-f\d]{2})*$/i.test(message.body)) {
    unavailable(t("图片数据无效"), t("可切换 Hex 检查已捕获的内容。"));
    return;
  }
  const data = payloadBytes({body:message.body,encoding:message.bodyEncoding,bytes:message.decodedBytes});
  if (message.truncated || message.byteLength > data.length) {
    unavailable(t("图片未完整捕获"), t("当前仅有部分图片字节，可切换 Hex 查看。"));
    return;
  }
  if (typeof Blob === 'undefined' || !URL.createObjectURL) {
    unavailable(t("当前环境不支持图片预览"), t("可切换 Hex 查看本地捕获字节。"));
    return;
  }
  const mime = contentType.split(';',1)[0].trim().toLowerCase();
  target.innerHTML = `<div class="image-preview"><img alt="${t("捕获的图片正文")}" decoding="async"></div><div class="body-meta"><span class="image-dimensions">${t("正在读取图片…")}</span><span>${t("仅使用捕获内容")}</span></div>`;
  const img = $('img',target), url = URL.createObjectURL(new Blob([data],{type:mime}));
  imagePreviewURL = url;
  img.onload = () => {
    if (imagePreviewURL !== url || !target.isConnected) return;
    $('.image-dimensions',target).textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${bytes(data.length)}`;
  };
  img.onerror = () => {
    if (imagePreviewURL !== url || !target.isConnected) return;
    clearImagePreview();
    unavailable(t("无法预览图片"), t("图片数据损坏或当前浏览器不支持该格式，可切换 Hex 查看。"));
  };
  // An img element keeps SVG in image mode: no scripts or external resources.
  // Never inject captured SVG into the document or fetch the original URL.
  img.src = url;
}

function payloadParts(record) {
  if (family(record) === 'redis' && record.metadata?.requestPayload !== undefined) {
    return [{label:t("命令 RESP"),body:record.metadata.requestPayload,encoding:record.metadata.requestPayloadEncoding || 'utf8'},...(record.metadata.responsePayload ? [{label:t("响应 RESP"),body:record.metadata.responsePayload,encoding:record.metadata.responsePayloadEncoding || 'utf8'}] : [])];
  }
  return [{label:family(record) === 'mysql' ? t("SQL 原始内容") : family(record) === 'redis' ? t("原始 RESP") : t("事件载荷"),body:record.payload ?? '',encoding:record.payloadEncoding || 'utf8'}];
}
function payloadBytes(part) {
  if (part.bytes) return part.bytes;
  return part.encoding === 'hex' ? Uint8Array.from((part.body.match(/[a-f\d]{2}/gi) || []).map(value => parseInt(value,16))) : new TextEncoder().encode(part.body);
}
function payloadText(part) {
  if (state.viewer === 'hex' || (state.viewer === 'pretty' && part.encoding === 'hex')) return hexDump(payloadBytes(part));
  return state.viewer === 'pretty' ? prettyBody(part) : part.body;
}
function renderProtocolPayload(record) {
  const parts = payloadParts(record);
  const panels = parts.map(part => {
    const data = payloadBytes(part), text = payloadText(part), lines = text.split('\n');
    let json = false;
    if (state.viewer === 'pretty' && part.encoding !== 'hex') { try { JSON.parse(part.body); json = true; } catch { /* Keep original text. */ } }
    const content = data.length ? `<div class="code-window ${state.wrap ? 'wrap' : ''}"><pre aria-label="${escapeHTML(part.label)}"><code>${lines.map((line,index) => `<span class="code-line"><span class="line-no" aria-hidden="true">${index+1}</span><span class="line-text">${json ? highlightJSON(line) : escapeHTML(line) || ' '}</span></span>`).join('')}</code></pre></div>` : `<div class="empty-body">${icon('code')}<strong>${record.metadata?.kind === 'datagram' ? t("空 DATAGRAM · 0 字节") : t("此事件没有载荷")}</strong><span>${record.metadata?.kind === 'datagram' ? t("空数据报是有效事件，保留数据报边界") : t("仍可在协议详情中检查事件字段")}</span></div>`;
    return `<section class="body-section protocol-payload"><h3 class="section-heading">${escapeHTML(part.label)}<span class="heading-end">${bytes(data.length)}</span></h3>${content}<div class="body-meta"><span>${data.length ? t("{count} 行",{count:lines.length}) : t("0 字节")}</span><span>${part.encoding === 'hex' ? t("二进制 · Hex") : 'UTF-8'}</span></div></section>`;
  }).join('');
  const note = presentationNote(record) || (record.metadata?.displayTruncated ? t("载荷超过显示上限，当前仅展示捕获内容的前缀。") : family(record) === 'raw' ? t("保留原始事件载荷与元数据；尚未映射为完整的应用消息。") : '');
  $('#tab-content').innerHTML = `${note ? `<div class="record-note">${icon('info')}<span>${escapeHTML(note)}</span></div>` : ''}<div class="body-toolbar payload-toolbar"><div class="viewer-tabs" aria-label="${t("载荷显示方式")}">${[['pretty',t("格式化")],['raw',t("原文")],['hex','Hex']].map(([id,label]) => `<button data-viewer="${id}" class="${state.viewer === id ? 'active' : ''}" aria-pressed="${state.viewer === id}">${label}</button>`).join('')}</div><div class="body-tools"><button class="icon-button compact ${state.wrap ? 'active' : ''}" data-wrap aria-label="${t("自动换行")}" aria-pressed="${state.wrap}">${icon('wrap')}</button><button class="icon-button compact" data-copy-body aria-label="${t("复制载荷")}" title="${t("复制载荷")}">${icon('copy')}</button></div></div>${panels}`;
}
function renderConnection(request,process) {
  const fields = entries => `<dl class="connection-fields">${entries.map(([key,value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value === '' || value == null ? t("未提供") : value)}</dd>`).join('')}</dl>`;
  const m = request.metadata || {}, transport = (request.transport || '').toUpperCase();
  const source = family(request) === 'mysql' ? t("mysqld hook · SQL 查询事件") : family(request) === 'quic' ? t("解密后的 QUIC 流 / 数据报事件") : family(request) === 'raw' ? t("原始事件") : t("解密后的应用协议消息");
  const quicContext = family(request) === 'quic' || request.protocol === 'HTTP/3' ? `<h3 class="connection-heading">${t("QUIC 上下文")}</h3>${fields([[t("版本"),m.quicVersion ?? m.version],['Connection ID',m.cid],...(m.kind === 'datagram' ? [] : [['Stream ID',request.streamId ?? m.streamId]]),...(isHTTP(request) ? [['ALPN',m.alpn],['QPACK',m.qpack]] : [[t("加密级别"),m.encryptionLevel]])])}` : '';
  const direction = {client_to_server:t("客户端 → 服务端"),server_to_client:t("服务端 → 客户端"),read:t("进程读取"),write:t("进程写入")}[request.direction] || request.direction;
  const owners = [{...process,...(request.real ? {command:request.processCommand || '',commandTruncated:request.processCommandTruncated} : {})},request.responseProcess].filter(Boolean).filter((item,index,all) => all.findIndex(other => other.id === item.id) === index);
  const commands = owners.map(item => [owners.length > 1 ? t("进程命令 · {p0}",{p0:processLabel(item)}) : t("进程命令"),item.command ? item.command+(item.commandTruncated ? t("（已截断，最多 256 字节）") : '') : t("未提供")]);
  const tls = m.tls && typeof m.tls === 'object' && !Array.isArray(m.tls) ? m.tls : null;
  const tlsValue = key => typeof tls?.[key] === 'string' ? tls[key] : null;
  const expectsTLS = request.real && ['tls','gotls','gnutls'].includes(sourceFor(request)?.capture?.module);
  const tlsContext = tls ? `<section class="tls-context"><h3 class="connection-heading">${t("TLS 握手")}</h3>${fields([
    [t("TLS 版本"),tlsValue('version')],[t("密码套件"),tlsValue('cipher_suite')],[t("套件编号"),tlsValue('cipher_suite_id')],
    ['SNI',tlsValue('server_name')],[t("客户端 ALPN"),tlsValue('offered_alpn')],[t("协商 ALPN"),tlsValue('alpn')],[t("密钥交换组"),tlsValue('key_exchange_group')],
    [t("签名算法"),tlsValue('signature_algorithm')],[t("JA3 · 客户端"),tlsValue('ja3')],[t("JA4 · 客户端"),tlsValue('ja4')]
  ])}<p class="tls-note">${t("JA3 / JA4 来自客户端首次线上 ClientHello")}${tlsValue('client_hello') === 'initial_outer' ? '（ECH Outer）' : ''}${t("；协商参数来自服务端握手。未提供表示当前事件中没有该字段。")}</p>${tlsValue('ja3_raw') ? `<details class="event-metadata"><summary>${t("JA3 原始指纹")}</summary><pre>${escapeHTML(tls.ja3_raw)}</pre></details>` : ''}</section>` : expectsTLS ? `<section class="tls-context"><h3 class="connection-heading">${t("TLS 握手")}</h3><p class="tls-note">${t("当前事件未提供 TLS 握手信息。JA3、JA4 和协商参数需要由采集器传入，不能从 HTTP 内容推断。")}</p></section>` : '';
  $('#tab-content').innerHTML = `<div class="connection-content"><div class="connection-process">${avatar(process)}<div><strong>${escapeHTML(processName(process))}</strong><p>${escapeHTML(processLabel(process))} · ${escapeHTML(process.kind || '')}</p></div></div><h3 class="connection-heading">${t("进程归属")}</h3>${fields([[t("数据源"),sourceFor(request)?.label || request.sourceId || workspace.session.host],[t("进程名"),owners.map(processName).join('；')],[t("进程 PID"),owners.map(processLabel).join('；')],...commands,...(!request.real || !(request.processPid > 0) ? [[t("归属来源"),request.real ? t("采集器未提供") : t("模拟数据")]] : []),...(['mysql','quic','raw'].includes(family(request)) ? [[t("事件形态"),source]] : [])])}<h3 class="connection-heading">${t("事件与连接")}</h3>${fields([[t("连接标识"),displayConnectionId(request.connectionId)],[t("消息方向"),direction],[t("传输协议"),[transport || t('未提供'),request.protocol || t('未提供')].join(' · ')],[t("采集时间"),request.startedAt ? new Date(request.startedAt).toLocaleString(getLanguage(),{timeZone:'Asia/Shanghai',hour12:false})+' (UTC+8)' : null]])}${tlsContext}${quicContext}${request.real ? `<h3 class="connection-heading">${t("采集来源 ·")} ${escapeHTML(request.sourceId)}</h3><code class="source-endpoint">${escapeHTML(sourceFor(request)?.endpoint || t("地址未登记"))}</code>${sourceMetadata(sourceFor(request))}` : ''}${request.real ? `<details class="event-metadata"><summary>${t("原始事件元数据")}</summary><pre>${escapeHTML(JSON.stringify({connectionId:request.connectionId,metadata:m},null,2))}</pre></details>` : ''}<div class="connection-explainer">${icon('info')}<span>${request.real ? t("进程名表示捕获事件的进程归属，不据此判断客户端或服务端角色。进程命令是采集时的可读概览，可能已被进程改写；末尾空项已折叠，中间空参数保留，引号用于区分参数。原始 argv 字节保留在导出 JSON 中。方向表示应用消息流向。空缺字段保持未知；耗时不会依据秒级时间戳推算。") : t("虚构的演示会话。进程归属、关联关系和耗时均为模拟字段。")}</span></div></div>`;
}

function renderAll(options = {}) { if (isPaged() && !options.fromServer && workspace.page.filterKey!==filterKey()) { pageIndex=0;schedulePage();return; } renderSidebar(); renderList(options); }
function clearFilters() {
  Object.assign(state,{scope:'all',process:null,protocol:null,domain:null,filter:'all',query:''});
  $('#request-search').value = '';
  renderAll();
}
function chooseRequest(id) {
  state.selected = id;
  state.bodySource = 'decoded';
  $('#workspace').classList.add('detail-open');
  renderList();
  if (window.matchMedia('(min-width: 681px)').matches) $(`[data-request="${id}"]`)?.focus({preventScroll:true});
  $('#tab-content').scrollTop = 0;
}
async function copy(text,label) {
  try { await platform.copyText(text); toast("{p0}已复制",() => ({p0:t(label)})); }
  catch (error) { toast(error.message || t("复制未获允许，请在正文中选择文本复制")); }
}
function curlCommand(request) {
  const quote = text => "'"+text.replace(/'/g,"'\\''")+"'";
  const parts = [`curl${request.protocol === 'HTTP/3' ? ' --http3' : ''} -X ${request.method} ${quote(`${request.scheme}://${request.host}${request.path}`)}`];
  request.request.headers.filter(h => !['content-length','host'].includes(h.name.toLowerCase())).forEach(h => parts.push(`  -H ${quote(`${h.name}: ${h.value}`)}`));
  if (request.request.body) parts.push(`  --data-raw ${quote(request.request.body)}`);
  return parts.join(' \\\n');
}

document.addEventListener('click',event => {
  const button = event.target.closest('button');
  if (!button || !workspace) return;
  if (button.hasAttribute('data-mode')) {
    switchMode(button.dataset.mode);
  } else if (button.hasAttribute('data-open-connection')) {
    openConnectionStatus();
  } else if (button.hasAttribute('data-process')) {
    Object.assign(state,{scope:'all',process:button.dataset.process,domain:null});
    $('#workspace').classList.remove('sidebar-open');
    renderAll();
  } else if (button.hasAttribute('data-scope')) {
    Object.assign(state,{scope:button.dataset.scope,process:null,protocol:null,domain:null});
    $('#workspace').classList.remove('sidebar-open');
    renderAll();
  } else if (button.hasAttribute('data-protocol')) {
    state.protocol = state.protocol === button.dataset.protocol ? null : button.dataset.protocol;
    state.domain = null;
    $('#workspace').classList.remove('sidebar-open');
    renderAll();
  } else if (button.hasAttribute('data-domain')) {
    state.domain = state.domain === button.dataset.domain ? null : button.dataset.domain;
    $('#workspace').classList.remove('sidebar-open');
    renderAll();
  } else if (button.hasAttribute('data-filter')) {
    state.filter = button.dataset.filter;
    renderAll();
  } else if(button.id==='retry-detail') {recordDetails.delete(state.selected);renderDetail();
  } else if (button.id==='page-prev' || button.id==='page-next') { pageIndex = Math.max(0,workspace.page.index+(button.id==='page-next' ? 1 : -1));schedulePage();
  } else if (button.hasAttribute('data-request')) chooseRequest(button.dataset.request);
  else if (button.hasAttribute('data-tab')) {
    state.tab = button.dataset.tab;
    state.bodySource = 'decoded';
    renderDetail();
    $('#tab-content').scrollTop = 0;
  } else if (button.hasAttribute('data-viewer')) {
    const scroll = $('#tab-content').scrollTop;
    state.viewer = button.dataset.viewer;
    renderDetail();
    $('#tab-content').scrollTop = scroll;
  } else if (button.hasAttribute('data-body-source')) {
    const scroll = $('#tab-content').scrollTop;
    state.bodySource = button.dataset.bodySource;
    renderDetail();
    $('#tab-content').scrollTop = scroll;
  } else if (button.hasAttribute('data-wrap')) {
    state.wrap = !state.wrap;
    const scroll = $('#tab-content').scrollTop;
    renderDetail();
    $('#tab-content').scrollTop = scroll;
  } else if (button.hasAttribute('data-copy-body')) {
    const record = selected();
    if (!record) return;
    if (!isHTTP(record)) copy(payloadParts(record).map(payloadText).join('\n\n'),"载荷");
    else {
      const message = displayedMessage(record,state.tab);
      if (message) copy(payloadText({body:message.body,encoding:message.bodyEncoding || 'utf8',bytes:message.decodedBytes}),"正文");
    }
  } else if (button.id === 'copy-curl') {
    if (selected()?.request && hasHTTPURL(selected())) copy(curlCommand(selected()),"cURL 命令");
  } else if (button.hasAttribute('data-clear-filter')) {
    const key = button.dataset.clearFilter;
    if (key === 'query') { state.query = ''; $('#request-search').value = ''; }
    else if (key === 'scope') state.scope = 'all';
    else if (key === 'filter') state.filter = 'all';
    else if (['process','protocol','domain'].includes(key)) state[key] = null;
    renderAll();
  } else if (button.hasAttribute('data-reset-filters')) clearFilters();
});

$('#request-search').addEventListener('input',event => { state.query = event.target.value; renderAll(); });
$('#clear-filters').addEventListener('click',clearFilters);
$('#clear-process').addEventListener('click',() => { state.process = null; renderAll(); });
$('#clear-domain').addEventListener('click',() => { state.domain = null; renderAll(); });
$('#clear-protocol').addEventListener('click',() => { state.protocol = null; state.domain = null; renderAll(); });
$('#bookmark-request').addEventListener('click',() => {
  const request = selected();
  if (!request) return;
  const marked = state.bookmarks.has(request.id);
  if (marked) state.bookmarks.delete(request.id); else state.bookmarks.add(request.id);
  renderAll();
  toast(marked ? "已取消标记" : "已加入左侧「已标记」");
});
$('#copy-url').addEventListener('click',() => { if (selected()) copy($('#detail-url').textContent,hasHTTPURL(selected()) ? 'URL' : "端点"); });
$('#toggle-processes').addEventListener('click',() => $('#workspace').classList.toggle('sidebar-open'));
$('#back-to-list').addEventListener('click',() => $('#workspace').classList.remove('detail-open'));

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('#theme-toggle').setAttribute('aria-label',theme === 'dark' ? t("切换浅色模式") : t("切换深色模式"));
  try { localStorage.setItem('ecaptureq-theme',theme); } catch { /* Storage is optional. */ }
}
$('#theme-toggle').addEventListener('click',() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
try { setTheme(localStorage.getItem('ecaptureq-theme') === 'dark' ? 'dark' : 'light'); } catch { setTheme('light'); }

const connectionStates = {connected:"已连接",connecting:"连接中",reconnecting:"正在重连",disconnected:"已断开",unconfigured:"未配置采集器",stopped:"已停止",partial:"部分连接",degraded:"部分连接",idle:"等待连接"};
function statusSources() { return Array.isArray(serverStatus.sources) ? serverStatus.sources : []; }
function sourceFor(record) { return statusSources().find(source => source.id === record.sourceId); }
function sourceMetadata(source) {
  const c = source?.capture;
  if (!c) return `<p class="source-intro">${t("采集主机、模式与启动参数未登记；eCaptureQ 事件本身不提供这些信息。")}</p>`;
  const fields = [[t("采集主机"),c.host],[t("模块"),c.module],[t("模式 / 数据源"),[c.mode,c.textSource].filter(Boolean).join(' / ')],['eCapture commit',c.collectorCommit],['Decryptor',c.decryptorVersion]];
  return `<dl class="connection-fields source-fields">${fields.map(([key,value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value || t("未登记"))}</dd>`).join('')}</dl><p class="source-command-label">${t("启动命令 · 服务端登记")}</p><pre class="source-command"><code>${escapeHTML(c.command || t("未登记"))}</code></pre>`;
}
function updateCaptureControls() {
  const live = state.mode === 'live', snapshot = live && !!workspace?.snapshot, button = $('#capture-toggle');
  button.hidden = snapshot;
  button.classList.toggle('running',live ? !state.paused : state.running);
  button.classList.toggle('live-capture',live);
  button.innerHTML = `${live ? icon(state.paused ? 'play' : 'pause') : '<span class="record-dot"></span>'}<span>${live ? state.paused ? t("恢复刷新") : t("暂停刷新") : state.running ? t("暂停模拟") : t("开始模拟")}</span>`;
  button.title = live ? t("冻结当前记录以便检查；后台继续接收，恢复后显示最新记录") : t("追加虚构样例");
  button.setAttribute('aria-pressed',String(live ? state.paused : state.running));
  $('#reset-demo').hidden = live;
  $$('[data-mode]').forEach(button => { button.setAttribute('aria-pressed',String(button.dataset.mode === state.mode)); button.disabled = !!window.__ECAPTURE_MOCK__ && !window.__ECAPTURE_CAPTURE__ && button.dataset.mode === 'live'; if (button.dataset.mode === 'live') button.textContent = window.__ECAPTURE_CAPTURE__ ? t("快照") : t("实时"); });
  const sources = statusSources(), connected = sources.filter(source => source.state === 'connected').length;
  const offline = !!(window.__ECAPTURE_CAPTURE__ || window.__ECAPTURE_MOCK__);
  const label = t(serviceError) || t(connectionStates[serverStatus.state]) || (connected ? t("已连接") : t("等待连接"));
  $('#mode-label').textContent = snapshot ? t("快照 · {p0} 源",{p0:sources.length}) : offline ? t("模拟数据") : serviceError ? t("数据源 · 服务断开") : t("数据源 {p0}/{p1}",{p0:connected,p1:sources.length});
  $('#connection-toggle').title = sources.length ? sources.map(source => `${source.label}: ${t(connectionStates[source.state]) || source.state}`).join('\n') : t("添加第一个 eCapture 数据源");
  $('#connection-toggle').setAttribute('aria-label',snapshot ? t("查看采集快照的数据源") : t("管理数据源：{p0} 个已连接，共 {p1} 个",{p0:connected,p1:sources.length}));
  $('#connection-toggle').dataset.state = snapshot ? 'snapshot' : offline ? 'mock' : serviceError ? 'error' : connected === sources.length && connected > 0 ? 'connected' : connected > 0 ? 'degraded' : 'waiting';
  $('#live-label').textContent = snapshot ? t("已保存 · 非实时") : live ? state.paused ? t("刷新已暂停 · 后台继续接收") : t("自动刷新 · 1 秒") : state.running ? t("正在生成模拟记录") : t("样例会话");
  $('#live-label').classList.toggle('running',live ? !snapshot && !state.paused && connected > 0 : state.running);
  const dropped = Number(serverStatus.dropped || 0), evicted = Number(serverStatus.evicted || 0);
  $('#status-message').textContent = snapshot ? t("真实采集快照 · {p0} 条记录 · 当前未连接采集器",{p0:requests.length}) : live ? `${state.paused ? t("刷新已暂停") : t("实时数据")} · ${label}${statusSources().length ? t(" · {p0}/{p1} 个数据源",{p0:connected,p1:statusSources().length}) : ''}${dropped ? t(" · {p0} 条未保留",{p0:dropped}) : ''}${evicted ? t(" · {p0} 条超出保留范围",{p0:evicted}) : ''}` : state.running ? t("模拟采集中 · 不发送真实网络请求") : t("演示会话 · 虚构样例");
  $('.status-indicator').classList.toggle('status-warning',live && !snapshot && (serviceError || !connected));
  $('.sidebar-caption').textContent = live ? t('实时') : t('模拟');
  $('#add-source-toggle').hidden = offline;
  $('#add-source-toggle').disabled = sources.length >= 16;
  $('#source-save-hint').textContent = serverStatus.sourcePersistence === 'file' ? t("保存到来源配置，重启后保留") : t("当前服务会话内保留");
  if ($('#connection-dialog').open) renderConnectionStatus();
}
const sourceErrors = {invalid_endpoint:"请输入 ws:// 或 wss:// 地址，不包含账号、查询参数或片段。",invalid_label:"名称最多 160 个字符。",duplicate_source:"这个地址已添加，请在下方查看连接状态。",source_limit:"最多支持 16 个数据源。",source_save_failed:"无法保存来源配置，请检查服务端文件权限。",source_config_changed:"来源配置已在外部修改，请重新启动服务加载后再添加。",source_config_too_large:"来源配置超过容量上限，请缩短填写内容。",service_stopping:"服务正在停止，请稍后重试。",origin_rejected:"请求来源校验失败，请从当前 eCaptureQ 窗口重新提交。",invalid_source:"数据源信息格式无效。",connection_failed:"连接中断或暂不可达，正在自动重试",frame_too_large:"上游消息超过接收限制",json_required:"请提交 JSON 格式的数据源。"};
let renderedSourceLogs = '';
function renderConnectionStatus() {
  const sources = statusSources();
  const expanded = new Set($$('[data-source-details][open]').map(element => element.dataset.sourceDetails));
  const logs = Array.isArray(serverStatus.logs) ? serverStatus.logs.slice(-8).reverse() : [];
  const counts = ['connected','connecting','reconnecting','stopped'].map(state => ({state,count:sources.filter(source=>source.state===state).length})).filter(item=>item.count);
  const summary = `<div class="source-summary">${counts.map(item=>`<span data-state="${item.state}">${escapeHTML(t(connectionStates[item.state]))} <strong>${item.count}</strong></span>`).join('')}<span class="source-summary-total">${t("共 {count} 个数据源",{count:sources.length})}</span></div>`;
  $('#connection-status').innerHTML = `<p class="source-intro">${workspace?.snapshot ? t("这是合成测试流量经过真实 eBPF 捕获生成的只读快照，当前不连接采集器。可切换到独立的模拟样例。") : state.mode === 'mock' ? t("当前展示模拟会话。已配置的数据源独立连接并持续接收，切换到实时模式即可查看。") : t("各数据源独立接收事件和自动重连，单个来源断开不会影响其他连接。")}</p>${summary}${serverStatus.excludeHTTPPathPrefix ? `<p class="source-intro">${escapeHTML(t("已排除 {prefix} 与工作台响应 · {count} 条事件",{prefix:serverStatus.excludeHTTPPathPrefix,count:Number(serverStatus.filtered || 0)}))}</p>` : ''}${serviceError ? `<div class="source-error">${escapeHTML(t(serviceError))}${t("，下方保留最后一次连接状态。")}</div>` : ''}${sources.length ? sources.map(source => `<div class="source-card" data-source-id="${escapeHTML(source.id)}"><div><strong>${escapeHTML(source.label || source.id)}</strong><span class="source-state" data-state="${safeClass(source.state)}">${escapeHTML(t(connectionStates[source.state]) || source.state)}</span></div><code>${escapeHTML(source.endpoint || '')}</code><p>${escapeHTML(source.capture?.host || t("主机未登记"))} · ${escapeHTML(source.capture?.module || t("模块未登记"))} ${t("· 事件")} ${Number(source.events || 0)}</p><p>${t("重试 {retries} · 已恢复连接 {reconnects}",{retries:Number(source.retries || 0),reconnects:Number(source.reconnects || 0)})}</p>${source.lastError ? `<p class="source-error">${escapeHTML(t(sourceErrors[source.lastError]) || source.lastError)}</p>` : ''}<details data-source-details="${escapeHTML(source.id)}" ${expanded.has(source.id) ? 'open' : ''}><summary>${t("采集信息与启动参数")}</summary>${sourceMetadata(source)}</details></div>`).join('') : `<div class="source-card source-empty"><strong>${t("还没有数据源")}</strong><p>${window.__ECAPTURE_MOCK__ ? t("离线演示不能连接采集器，请使用 Go 服务。") : t("点击「添加数据源」，连接一个或多个 eCapture 采集器。")}</p></div>`}<div class="source-totals"><span>${t("接收事件")} <strong>${Number(serverStatus.events || 0)}</strong></span><span>${t("无效消息")} <strong>${Number(serverStatus.malformed || 0)}</strong></span><span>${t("未映射事件")} <strong>${Number(serverStatus.ignored || 0)}</strong></span></div>`;
  // Keep the disclosure and summary mounted while connection status polls.
  // Reuse unchanged log content as well, preserving focus and text selection.
  $('#source-log-details').hidden = logs.length === 0;
  const logHTML = logs.map(log => `<div><span>${escapeHTML(sources.find(s=>s.id===log.sourceId)?.label || log.sourceId || '')}</span><code>${escapeHTML(log.message || log.text || '')}</code></div>`).join('');
  if (logHTML !== renderedSourceLogs) {
    $('#source-log-details .source-logs').innerHTML = logHTML;
    renderedSourceLogs = logHTML;
  }
}
function openConnectionStatus() { renderConnectionStatus(); $('#connection-dialog').showModal(); }
$('#add-source-toggle').addEventListener('click',() => {
  $('#add-source-form').hidden = false;
  $('#source-form-error').hidden = true;
  $('#connection-dialog').scrollTop = 0;
  $('#source-endpoint').focus({preventScroll:true});
});
$('#cancel-add-source').addEventListener('click',() => { $('#add-source-form').hidden = true; });
const syncSourceMetadata = initSourceMetadata($('#add-source-form'));
$('#add-source-form').addEventListener('input',() => { $('#source-form-error').hidden = true; });
$('#add-source-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (window.__ECAPTURE_CAPTURE__ || window.__ECAPTURE_MOCK__) return;
  const button = $('#submit-source'), error = $('#source-form-error');
  if (button.disabled) return;
  syncSourceMetadata();
  const form = new FormData(event.currentTarget), source = {label:String(form.get('label')).trim(),endpoint:String(form.get('endpoint')).trim()};
  const host = String(form.get('host')).trim(), module = String(form.get('module')), command = String(form.get('command')).trim();
  if (host || module || command) source.capture = {host,module,command,mode:module ? 'text' : '',textSource:module ? 'pcapng' : ''};
  button.disabled = true; button.textContent = t("正在添加…"); error.hidden = true;
  const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10000);
  try {
    const response = await fetch('api/sources',{method:'POST',headers:{'Content-Type':'application/json','X-Ecapture-UI':'1'},body:JSON.stringify(source),signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(Object.hasOwn(sourceErrors,result.error) ? sourceErrors[result.error] : "添加失败，请稍后重试。"),{uiMessage:true});
    serverStatus = result.status; serviceError = '';
    $('#add-source-form').reset(); $('#add-source-form').hidden = true;
    updateCaptureControls();
    toast("已添加 {p0}，正在连接",{p0:result.source.label});
  } catch (failure) {
    error.dataset.message = failure.name === 'AbortError' ? "请求超时，请先检查下方是否已添加，再重试。" : failure.uiMessage ? failure.message : "添加失败，请检查服务连接。";
    error.textContent = t(error.dataset.message); error.hidden = false;
  } finally { clearTimeout(timeout); button.disabled = false; button.textContent = t("添加并连接"); }
});
$('#connection-toggle').addEventListener('click',openConnectionStatus);
$('#close-connection').addEventListener('click',() => $('#connection-dialog').close());
$('#connection-dialog').addEventListener('click',event => { if (event.target === event.currentTarget) { const r = event.target.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) event.target.close(); } });

function appendSimulation() {
  const eligible = seeds.filter(r => r.state === 'complete' && (!state.protocol || protocolKey(r) === state.protocol) && (!state.process || matchesProcess(r, state.process)) && (!state.domain || r.host === state.domain));
  if (!eligible.length) return;
  const request = structuredClone(eligible[sequence % eligible.length]);
  sequence++;
  request.id = `sim-${String(sequence).padStart(4,'0')}`;
  request.startedAt = new Date().toISOString();
  request.fresh = true;
  requests.unshift(request);
  if (requests.length > 300) {
    const removed = requests.pop();
    state.bookmarks.delete(removed.id);
  }
  renderAll({preserveDetail:true});
  setTimeout(() => { request.fresh = false; },600);
}
$('#capture-toggle').addEventListener('click',() => {
  if (!workspace) return;
  if (state.mode === 'live') { state.paused = !state.paused; updateCaptureControls(); if (!state.paused) refreshLive(); return; }
  state.running = !state.running;
  clearInterval(timer);
  if (state.running) { appendSimulation(); timer = setInterval(appendSimulation,2800); }
  updateCaptureControls();
});
$('#reset-demo').addEventListener('click',() => {
  if (!workspace || state.mode !== 'mock') return;
  clearInterval(timer); state.running = false; sequence = 0;
  requests = structuredClone(seeds); state.bookmarks.clear();
  Object.assign(state,{selected:requests[0].id,tabFamily:null,tab:'request',viewer:'pretty',bodySource:'decoded'});
  clearFilters(); updateCaptureControls(); toast("已恢复 {p0} 条样例记录",{p0:seeds.length});
});
$('#export-data').addEventListener('click',async () => {
  if (!workspace) return;
  let list = filteredRequests();
  if (isPaged()) {
    const full=[];$('#export-data').disabled=true;
    try {
      for(let i=0;i<list.length;i+=4) full.push(...await Promise.all(list.slice(i,i+4).map(async row=>{
        const response=await fetchWithTimeout('api/record?id='+encodeURIComponent(row.id),{cache:'no-store'});
        if(!response.ok)throw new Error(t("记录已淘汰或暂时不可用"));return response.json();
      })));
      list=full;
    } catch { toast(t("导出失败：请刷新列表后重试"));return; }
    finally { $('#export-data').disabled=false; }
  }
  $('#export-data').disabled=true;
  try {
    const result = await platform.exportJSON(state.mode === 'live' ? 'ecaptureq-live-session.json' : 'ecaptureq-demo-session.json',
      JSON.stringify({session:workspace.session,processes:workspace.processes,requests:list},null,2));
    if (!result.cancelled) toast("已导出当前筛选的 {p0} 条{p1}记录",() => ({p0:list.length,p1:state.mode === 'live' ? t("实时") : t("模拟")}));
  } catch (error) { toast("导出失败：{message}",() => ({message:t(sourceMessage(error.message))})); }
  finally { $('#export-data').disabled=false; }
});

document.addEventListener('keydown',event => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
    event.preventDefault(); $('#request-search').focus(); return;
  }
  if (event.key === 'Escape') {
    $('#workspace').classList.remove('sidebar-open','detail-open');
    if (document.activeElement === $('#request-search')) { state.query = ''; $('#request-search').value = ''; renderAll(); }
  }
  if (!workspace || !event.target.closest('#request-list') || !['ArrowUp','ArrowDown'].includes(event.key)) return;
  event.preventDefault();
  const list = filteredRequests(), index = list.findIndex(r => r.id === state.selected);
  const next = list[Math.max(0,Math.min(list.length-1,index+(event.key === 'ArrowDown' ? 1 : -1)))];
  if (next) { state.selected = next.id; renderList({scrollToSelected:true}); $(`[data-request="${next.id}"]`)?.focus({preventScroll:true}); }
});

initLayout();

async function fetchWorkspace(mode, signal, useFilters = false) {
  if (window.__ECAPTURE_CAPTURE__ && mode !== 'mock') return {...structuredClone(window.__ECAPTURE_CAPTURE__),mode:'live',snapshot:true};
  if (window.__ECAPTURE_MOCK__) return {...structuredClone(window.__ECAPTURE_MOCK__),mode:'mock'};
  const filters = useFilters ? liveFilters() : {process:'',protocol:'',domain:'',scope:'all',filter:'all',q:'',bookmarks:''};
  const params=new URLSearchParams({...filters,view:'page',page:String(useFilters ? pageIndex : 0)});
  if(mode)params.set('mode',mode);
  const response = await fetch('api/workspace?'+params,{cache:'no-store',signal});
  if (!response.ok) throw new Error(t("工作区服务不可用"));
  const next = await response.json();
  if(next.page) {next.page.filterKey=JSON.stringify(filters);next.page.requestKey=params.toString();}
  if (!Array.isArray(next.requests) || !Array.isArray(next.processes) || !next.session) throw new Error(t("工作区数据无效"));
  return next;
}
function applyWorkspace(next, reset = false, force = false) {
  if (!reset && next.page && next.page.filterKey!==filterKey()) {schedulePage();return;}
  serverStatus = next.status || {};
  serviceError = '';
  if (state.mode === 'live' && state.paused && !reset && !force) { updateCaptureControls(); return; }
  const previousSelected = JSON.stringify(selected());
  const changed = reset || next.page?.requestKey!==workspace?.page?.requestKey || revision === null || next.revision == null || revision !== next.revision;
  if (!changed) { updateCaptureControls(); return; }
  revision = next.revision ?? null;
  workspace = next;
  requests = next.requests;
  if(next.page)pageIndex=next.page.index;
  const ids = new Set(next.page ? next.page.bookmarks : requests.map(record => record.id));
  for (const id of state.bookmarks) if (!ids.has(id)) state.bookmarks.delete(id);
  if (state.mode === 'mock') seeds = structuredClone(requests);
  if (reset) {
    for (const entry of decodedBodies.values()) entry.controller.abort();
    decodedBodies.clear();recordDetails.clear();detailController?.abort();detailLoading='';pageIndex=0;
    Object.assign(state,{scope:'all',process:null,protocol:null,domain:null,filter:'all',query:'',selected:requests[0]?.id ?? null,tabFamily:null,tab:'request',viewer:'pretty',bodySource:'decoded'});
    state.bookmarks.clear(); $('#request-search').value = '';
  }
  const scroll = $('#tab-content').scrollTop;
  renderAll({fromServer:true,preserveDetail:!reset && JSON.stringify(selected()) === previousSelected});
  if (!reset) $('#tab-content').scrollTop = scroll;
  updateCaptureControls(); $('#loading').hidden = true;
}
async function loadWorkspace(mode) {
  const generation = ++loadGeneration;
  loadController?.abort();
  loadController = new AbortController();
  const timeout = setTimeout(() => loadController?.abort(),30000);
  try {
    const next = await fetchWorkspace(mode,loadController.signal);
    if (generation !== loadGeneration) return;
    state.mode = next.mode || next.session.mode || 'mock';
    applyWorkspace(next,true);
  } finally { clearTimeout(timeout); }
}
async function switchMode(mode) {
  if (mode === state.mode || (window.__ECAPTURE_MOCK__ && !window.__ECAPTURE_CAPTURE__ && mode === 'live')) return;
  clearInterval(timer); state.running = false; state.paused = false;
  try { await loadWorkspace(mode); }
  catch { if (workspace) { serviceError = "服务暂不可用"; updateCaptureControls(); toast(t("模式切换失败，已保留当前会话")); } }
}
let refreshing = false;
async function refreshLive(force = false) {
  if (window.__ECAPTURE_CAPTURE__ || window.__ECAPTURE_MOCK__) return;
  if(refreshing){if(force)schedulePage();return;}
  refreshing = true;
  const generation = loadGeneration, controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(),30000);
  try {
    if (state.mode === 'live') {
      const next = await fetchWorkspace('live',controller.signal,true);
      if (generation === loadGeneration && state.mode === 'live') applyWorkspace(next,false,force);
    } else {
      const response = await fetch('api/status',{cache:'no-store',signal:controller.signal});
      if (!response.ok) throw new Error('status unavailable');
      const next = await response.json();
      if (generation === loadGeneration && state.mode === 'mock') { serverStatus = next; serviceError = ''; updateCaptureControls(); }
    }
  } catch {
    if (generation === loadGeneration) { serviceError = "服务暂不可用"; updateCaptureControls(); }
  } finally { clearTimeout(timeout); refreshing = false; }
}
function updateLanguageControls() {
  const language = getLanguage();
  const label = t('当前语言：{language}',{language:language === 'en' ? 'English' : '简体中文'});
  $('#language-toggle').title = label;
  $('#language-toggle').setAttribute('aria-label',t('切换语言')+' · '+label);
  $$('[data-language]').forEach(button => button.setAttribute('aria-checked',String(button.dataset.language === language)));
}
function closeLanguageMenu(focus = false) {
  $('#language-menu').hidden = true;
  $('#language-toggle').setAttribute('aria-expanded','false');
  if (focus) $('#language-toggle').focus();
}
function changeLanguage(language) {
  const scroll = ['#sidebar','#request-list','#tab-content','#connection-dialog'].map(selector => [selector,$(selector).scrollTop]);
  const disclosures = $$('#tab-content details').map(element => element.open);
  setLanguage(language);
  translateStatic();
  updateLanguageControls();
  $('.web-badge').textContent = platform.desktop ? t('桌面') : 'WEB';
  setTheme(document.documentElement.dataset.theme || 'light');
  if (workspace) { renderSidebar(); renderList(); updateCaptureControls(); }
  $$('#tab-content details').forEach((element,index) => { if (index < disclosures.length) element.open = disclosures[index]; });
  $('#source-form-error').textContent = t($('#source-form-error').dataset.message || '');
  $('#submit-source').textContent = t($('#submit-source').disabled ? '正在添加…' : '添加并连接');
  if ($('#source-endpoint').validity.customError) validateSourceEndpoint();
  if (!$('#toast').hidden && toastMessage) $('#toast').textContent = toastMessage();
  if (workspaceLoadFailed) renderWorkspaceError();
  for (const [selector,top] of scroll) $(selector).scrollTop = top;
}
$('#language-toggle').addEventListener('click',() => {
  const opening = $('#language-menu').hidden;
  $('#language-menu').hidden = !opening;
  $('#language-toggle').setAttribute('aria-expanded',String(opening));
  if (opening) $('#language-menu [aria-checked=true]').focus();
});
$('#language-menu').addEventListener('click',event => {
  const option = event.target.closest('[data-language]');
  if (option) { changeLanguage(option.dataset.language); closeLanguageMenu(true); }
});
$('.language-picker').addEventListener('keydown',event => {
  if (event.key === 'Escape') { event.stopPropagation(); closeLanguageMenu(true); }
  if (['ArrowDown','ArrowUp','Home','End'].includes(event.key)) {
    event.preventDefault();
    $('#language-menu').hidden = false;
    $('#language-toggle').setAttribute('aria-expanded','true');
    const options = $$('#language-menu [data-language]'), index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length-1 : (index+(event.key === 'ArrowUp' ? -1 : 1)+options.length)%options.length;
    options[next].focus();
  }
});
document.addEventListener('click',event => { if (!event.target.closest('.language-picker')) closeLanguageMenu(); });
$('.language-picker').addEventListener('focusout',event => {
  // WebKit may blur a menu button with no relatedTarget during pointerdown.
  // Keep the menu mounted until click; outside clicks and Escape close it too.
  if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) closeLanguageMenu();
});
function validateSourceEndpoint() {
  const input = $('#source-endpoint');
  input.setCustomValidity('');
  if (!input.value.trim()) input.setCustomValidity(t('请输入 WebSocket 地址。'));
  else if (input.validity.typeMismatch) input.setCustomValidity(t('请输入有效的 WebSocket 地址。'));
}
$('#source-endpoint').addEventListener('invalid',validateSourceEndpoint);
$('#source-endpoint').addEventListener('input',() => $('#source-endpoint').setCustomValidity(''));
let workspaceLoadFailed = false;
function renderWorkspaceError() {
  $('#loading').innerHTML = `${icon('alert','large-icon')}<strong>${t("工作区加载失败")}</strong><span>${t("请确认 Go 服务正在运行，然后刷新页面。")}</span>`;
}
translateStatic();
updateLanguageControls();
setTheme(document.documentElement.dataset.theme || 'light');

platform.init().then(mode => {
  $('.web-badge').textContent = mode.desktop ? t('桌面') : 'WEB';
}).catch(error => toast(error.message));
// Browser links retain normal navigation and user activation. Desktop routes
// external navigation through the native adapter, away from the capture UI.
document.addEventListener('click',event => {
  const link = event.target.closest('a[target="_blank"]');
  if (!link || !platform.desktop) return;
  event.preventDefault();
  platform.openExternal(link.href).catch(error => toast(error.message));
});
loadWorkspace().catch(() => { workspaceLoadFailed = true; renderWorkspaceError(); });
pollTimer = setInterval(refreshLive,1000);
window.addEventListener('beforeunload',() => { clearInterval(timer); clearInterval(pollTimer); clearImagePreview(); clearTimeout(pageTimer); detailController?.abort(); loadController?.abort(); });
