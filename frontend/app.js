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
const statusNames = {200:'OK',201:'Created',204:'No Content',304:'Not Modified',400:'Bad Request',401:'Unauthorized',403:'Forbidden',404:'Not Found',429:'Too Many Requests',500:'Internal Server Error',502:'Bad Gateway',503:'Service Unavailable'};
const protocolFilters = [{id:'http',label:'HTTP/1 · 2'},{id:'http3',label:'HTTP/3'},{id:'quic',label:'QUIC'},{id:'mysql',label:'MySQL'},{id:'redis',label:'Redis'},{id:'mqtt',label:'MQTT'},{id:'raw',label:'其他 / 原始'}];
const state = {scope:'all',process:null,protocol:null,domain:null,filter:'all',query:'',selected:null,tab:'request',viewer:'pretty',bodySource:'decoded',wrap:true,bookmarks:new Set(),running:false,mode:'mock',paused:false};
let workspace, requests = [], seeds = [], timer, toastTimer, sequence = 0, pollTimer, loadController, loadGeneration = 0, revision = null, serverStatus = {}, serviceError = '';

function toast(message) {
  const element = $('#toast');
  element.textContent = message;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { element.hidden = true; }, 2600);
}

function processFor(id) { return workspace.processes.find(p => p.id === id) || {id,name:'未知进程',pid:null,kind:'未提供',command:''}; }
function processLabel(process) { return process.pid > 0 ? String(process.pid) : 'PID 未提供'; }
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
function recordTitle(record) { return (isHTTP(record) ? record.path : record.summary) || record.summary || '未捕获请求路径'; }
function isError(record) { return (isHTTP(record) && record.status >= 400) || record.state === 'failed' || record.outcome === 'error'; }
function needsAttention(record) { return isError(record) || record.state === 'partial'; }
function header(message, name) { return message?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || ''; }
function hasJSON(record) {
  if (isHTTP(record)) return header(record.response,'content-type').includes('json');
  if (record.payloadEncoding === 'hex' || !record.payload) return false;
  try { JSON.parse(record.payload); return true; } catch { return false; }
}
function shortStatus(record) {
  if (record.state === 'pending') return '未配对';
  if (record.state === 'partial') return '截断';
  if (record.state === 'failed') return '失败';
  if (isHTTP(record)) return record.status || '观测';
  if (isError(record)) return '异常';
  if (record.metadata?.kind === 'push') return '推送';
  if (record.metadata?.kind === 'stream_reset') return '重置';
  return '观测';
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
    if(!response.ok)throw new Error(response.status===404?'此记录已超出保留范围，请刷新列表。':'详情暂时不可用。');
    const record=await response.json();
    recordDetails.set(row.id,{version:row.detailVersion,record});
  } catch(error) {
    if(error.name==='AbortError' && !timedOut)return;
    recordDetails.set(row.id,{version:row.detailVersion,error:timedOut?'详情读取超时，请重试。':error.message});
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
    return `<button class="process-item ${state.process === process.id ? 'active' : ''} ${count === 0 ? 'no-matches' : ''}" data-process="${escapeHTML(process.id)}" aria-pressed="${state.process === process.id}" aria-label="筛选 ${escapeHTML(process.name)}，${escapeHTML(processLabel(process))}">${avatar(process)}<span class="process-info"><span class="process-name">${escapeHTML(process.name)}</span><span class="process-meta">${escapeHTML(processLabel(process))} · ${escapeHTML(process.kind || process.source || '')}</span></span><span class="process-count">${count}</span></button>`;
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
  const scopeLabel = state.process ? processFor(state.process).name : state.scope === 'starred' ? '已标记' : '全部流量';
  $('#scope-title').textContent = state.protocol ? `${scopeLabel} · ${protocolFilters.find(p => p.id === state.protocol).label}` : scopeLabel;
  $('#visible-count').textContent = workspace.page?.total ?? list.length;
  $('#error-count').textContent = workspace.page?.errors ?? baseRequests().filter(needsAttention).length;
  $$('[data-filter]').forEach(button => {
    button.classList.toggle('active',button.dataset.filter === state.filter);
    button.setAttribute('aria-pressed',String(button.dataset.filter === state.filter));
  });
  const tags = [];
  if (state.process) { const p=processFor(state.process); tags.push(['process',`进程 ${p.name} · ${processLabel(p)}`]); }
  if (state.protocol) tags.push(['protocol',protocolFilters.find(p=>p.id===state.protocol)?.label || state.protocol]);
  if (state.scope === 'starred') tags.push(['scope','已标记']);
  if (state.domain) tags.push(['domain',`主机 ${state.domain}`]);
  if (state.filter !== 'all') tags.push(['filter',{errors:'异常',pending:'未配对',json:'JSON'}[state.filter]]);
  if (state.query) tags.push(['query',`搜索 ${state.query}`]);
  $('#active-filters').hidden = tags.length === 0;
  $('#filter-tags').innerHTML = tags.map(([key,label])=>`<button class="active-filter-tag" data-clear-filter="${key}" aria-label="清除${escapeHTML(label)}" title="清除${escapeHTML(label)}"><span>${escapeHTML(label)}</span>${icon('close')}</button>`).join('');
  $('#request-list').innerHTML = list.length ? list.map((request,index) => {
    const statusClass = isError(request) ? 'error' : ['pending','partial'].includes(request.state) ? 'pending' : !isHTTP(request) || request.status >= 300 ? 'redirect' : '';
    const label = shortStatus(request), op = operation(request), title = recordTitle(request);
    return `<button class="request-row request-grid ${state.selected === request.id ? 'selected' : ''} ${request.fresh ? 'fresh' : ''}" data-request="${escapeHTML(request.id)}" data-family="${escapeHTML(family(request))}" role="listitem" aria-label="${escapeHTML(request.protocol+' '+op+' '+title+'，'+label)}" aria-current="${state.selected === request.id}"><span class="row-index col-index">${state.bookmarks.has(request.id) ? icon('star') : String((workspace.page?.index || 0)*(workspace.page?.size || 0)+index+1).padStart(2,'0')}</span><span class="status-code ${statusClass}">${escapeHTML(label)}</span><span class="row-method ${safeClass(isHTTP(request) ? op : family(request))}" title="${escapeHTML(op)}">${escapeHTML(op)}</span><span class="row-name"><span class="row-path" title="${escapeHTML(title)}">${escapeHTML(title)}</span><span class="row-host"><span class="inline-protocol">${escapeHTML(request.protocol)}</span>${request.real ? ' · '+escapeHTML(sourceFor(request)?.capture?.module || request.sourceId) : ''} · ${escapeHTML(request.host || '主机未提供')}</span></span><span class="col-duration ${request.durationMs >= 1000 ? 'slow' : ''}">${duration(request.durationMs)}</span><span class="col-size">${bytes(request.sizeBytes)}</span></button>`;
  }).join('') : `<div class="empty-list">${icon(state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? 'activity' : 'search','large-icon')}<h3>${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? '等待真实采集事件' : state.scope === 'starred' && !state.bookmarks.size ? '还没有标记的记录' : '没有匹配的记录'}</h3><p>${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? '连接状态可在右上角查看；采集器连接后，新流量会自动出现。' : state.scope === 'starred' && !state.bookmarks.size ? '点击详情右上角的星标，留住排查线索' : '试试其他协议、进程或关键词'}</p><button ${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? 'data-open-connection' : 'data-reset-filters'}>${state.mode === 'live' && !(workspace.page?.retained ?? requests.length) ? '查看数据源' : '查看全部流量'}</button></div>`;
  const page = isPaged() ? workspace.page : null;
  $('#list-summary').textContent = page ? `显示 ${list.length ? page.index*page.size+1 : 0}–${page.index*page.size+list.length} / ${page.total} 条` : `显示 ${list.length} / ${requests.length} 条记录`;
  $('#page-controls').hidden = !page;
  $('#page-prev').disabled = !page || page.index===0;
  $('#page-next').disabled = !page || (page.index+1)*page.size>=page.total;
  $('#export-data').innerHTML = icon('download')+(page ? '导出当前页 JSON' : '导出 JSON');
  $('#total-size').textContent = bytes(list.reduce((sum,r) => sum+r.sizeBytes,0));
  if (scrollToSelected) $(`[data-request="${state.selected}"]`)?.scrollIntoView({block:'nearest'});
  if (focusedRequest && list.some(r => r.id === focusedRequest)) $(`[data-request="${focusedRequest}"]`)?.focus({preventScroll:true});
  if (!preserveDetail || previousSelected !== state.selected) renderDetail();
}

function statusLabel(request) {
  if (request.state === 'pending') return '尚未关联最终响应';
  if (request.state === 'failed') return '连接失败';
  if (request.state === 'partial') return '部分捕获';
  if (!isHTTP(request)) {
    if (isError(request)) return family(request) === 'mysql' ? '派发返回异常' : '协议错误';
    if (request.metadata?.kind === 'push') return '服务端推送';
    if (request.metadata?.kind === 'stream_reset') return '流已重置';
    if (family(request) === 'mysql') return 'SQL 事件已捕获';
    return '已观测';
  }
  return request.status ? `${request.status} ${statusNames[request.status] || ''}`.trim() : '已观测';
}

function detailTabs(record) {
  if (isHTTP(record)) return [{id:'request',label:'请求'},{id:'response',label:'响应'},{id:'connection',label:'连接'}];
  const tabs = protocolViews.tabs(record);
  return tabs.length ? tabs : [{id:'payload',label:'原始载荷'},{id:'connection',label:'事件信息'}];
}
function endpointLabel(record) {
  if (hasHTTPURL(record)) return `${record.scheme || 'https'}://${record.host}${record.path || ''}`;
  if (record.real) return `${record.sourceAddress || '源端点未提供'} → ${record.destinationAddress || '目标端点未提供'}`;
  return `${record.host} · 本地 ${record.localAddress} · 远端 ${record.remoteAddress}`;
}

function renderDetail() {
  clearImagePreview();
  const request = selected();
  $('#detail-empty').hidden = !!request;
  $('#detail-view').hidden = !request;
  $('#selection-status').textContent = request ? `${processFor(request.processId).name} · ${request.id}` : '未选择记录';
  $('#protocol-status').textContent = request ? `${request.protocol}${request.transport ? ' · '+request.transport.toUpperCase() : ''}` : '多协议工作区';
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
  $('#copy-url').setAttribute('aria-label',hasHTTPURL(request) ? '复制请求 URL' : '复制事件端点');
  $('#copy-url').title = hasHTTPURL(request) ? '复制 URL' : '复制端点';
  $('#bookmark-request').setAttribute('aria-pressed',String(state.bookmarks.has(request.id)));
  $('#bookmark-request').setAttribute('aria-label',state.bookmarks.has(request.id) ? '取消标记记录' : '标记记录');
  $('#bookmark-request').title = state.bookmarks.has(request.id) ? '取消标记' : '加入左侧「已标记」（当前页面会话）';
  $('#request-facts').innerHTML = `<span class="fact-status ${isError(request) ? 'error' : ['pending','partial'].includes(request.state) ? 'pending' : ''}">${icon(needsAttention(request) ? 'alert' : request.state === 'pending' ? 'activity' : 'check')}${escapeHTML(statusLabel(request))}</span><span class="fact-divider"></span><span>${escapeHTML(request.protocol)}</span>${request.durationMs !== null && request.durationMs !== undefined ? `<span class="fact-divider"></span><span title="${request.real ? '观测耗时' : '模拟观测耗时'}">${duration(request.durationMs)}</span>` : ''}<span class="fact-divider"></span><span class="fact-process">${icon('terminal')}${escapeHTML(process.name)}</span>`;
  $('#detail-tabs').innerHTML = tabs.map(tab => `<button id="tab-${tab.id}" role="tab" aria-controls="tab-content" aria-selected="${tab.id === state.tab}" data-tab="${tab.id}">${escapeHTML(tab.label)}</button>`).join('')+`<div class="tabs-spacer"></div>${hasHTTPURL(request) && request.request && request.request.bodyEncoding !== 'hex' ? `<button class="icon-button compact" id="copy-curl" aria-label="复制为 cURL" title="复制为 cURL">${icon('terminal')}</button>` : ''}`;
  $('#tab-content').setAttribute('aria-labelledby',`tab-${state.tab}`);
  const summary = requests.find(r=>r.id===state.selected), detail = recordDetails.get(state.selected);
  if (isPaged() && (!detail || detail.version!==summary?.detailVersion || !detail.record)) {
    $('#tab-content').innerHTML = `<div class="empty-body"><strong>${escapeHTML(detail?.version===summary?.detailVersion && detail.error ? detail.error : '正在读取详情…')}</strong>${detail?.error ? '<button class="text-button" id="retry-detail">重试</button>' : ''}</div>`;
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
  const errors = {unsupported:'当前环境不支持这种压缩格式，保留原始字节。',truncated:'压缩正文未完整捕获，无法可靠解压。',invalid:'解压失败：压缩数据不完整、校验未通过或解码服务不可用。',limit:`解压内容超过 ${bytes(maxDecodedBodyBytes)} 上限，已停止解压。`,timeout:'解压超时，已停止处理。'};
  const available = decoded.state === 'decoded';
  const status = available ? `${bytes(decoded.encodedBytes)} → ${bytes(decoded.message.byteLength)}` : decoded.state === 'loading' ? '正在解压…' : errors[decoded.state] || '';
  return `<div class="compression-controls"><span><strong>${escapeHTML(decoded.codings.join(', '))}</strong> · ${escapeHTML(status)}</span><div class="viewer-tabs" aria-label="压缩正文来源"><button data-body-source="decoded" ${available ? '' : 'disabled'} class="${state.bodySource !== 'encoded' ? 'active' : ''}" aria-pressed="${state.bodySource !== 'encoded'}">解压后</button><button data-body-source="encoded" class="${state.bodySource === 'encoded' ? 'active' : ''}" aria-pressed="${state.bodySource === 'encoded'}">原始压缩</button></div></div>`;
}

function renderMessage(request) {
  const original = request[state.tab] || {headers:[],body:''};
  const decoded = bodyState(request,state.tab), message = displayedMessage(request,state.tab);
  const contentType = header(message,'content-type'), imageType = /^image\//i.test(contentType.trim());
  if (imageType && state.viewer === 'pretty') state.viewer = 'raw';
  const typeLabel = imageType ? 'Image' : message.bodyEncoding === 'hex' ? 'Binary' : contentType.includes('json') ? 'JSON' : contentType.includes('html') ? 'HTML' : contentType.includes('css') ? 'CSS' : contentType.includes('text') ? 'Text' : message.body ? 'Text' : 'Empty';
  const transportStrip = request.protocol === 'HTTP/3' ? `<div class="transport-strip">${icon('activity')}<strong>HTTP/3</strong><span>QUIC${request.metadata?.quicVersion ? ' '+escapeHTML(request.metadata.quicVersion) : ''}</span><span>Stream ${escapeHTML(request.streamId ?? request.metadata?.streamId ?? '未提供')}</span>${request.metadata?.alpn ? `<span>${escapeHTML(request.metadata.alpn)}</span>` : ''}</div>` : '';
  let notice = '';
  if (state.tab === 'response') {
    if (request.state === 'pending') notice = `<div class="message-notice pending">${icon('activity')}<div><strong>已捕获请求，尚未关联最终响应</strong><p>${request.real ? '这表示当前没有可配对的最终响应，不代表服务端仍在处理。连接提前关闭、响应未捕获或关联信息缺失都可能造成这种状态。' : '请求内容可在「请求」页查看。此条为固定模拟场景。'}</p></div></div>`;
    else if (request.state === 'failed') notice = `<div class="message-notice">${icon('alert')}<div><strong>连接未能完成</strong><p>${escapeHTML(request.note || '未获取到应用层响应，此处没有 HTTP 状态码。')}</p></div></div>`;
    else if (request.status >= 400) notice = `<div class="message-notice">${icon('alert')}<div><strong>${request.status === 502 ? '上游服务返回错误' : 'HTTP 请求返回错误'}</strong><p>${request.status === 502 ? '响应消息已完整捕获，可检查下方错误正文。' : '查看响应正文与 Headers，了解服务端返回的原因。'}</p></div></div>`;
  }
  if (request.real && request.hasRequest === false && state.tab === 'request') notice = `<div class="message-notice pending">${icon('info')}<div><strong>请求未捕获</strong><p>这是一条未关联请求的响应记录，保留已收到的响应内容。</p></div></div>`;
  if (request.real && request.note) notice += `<div class="record-note">${icon('info')}<span>${escapeHTML(request.note)}</span></div>`;
  if (request.real && request.hasRequest && !hasHTTPURL(request)) notice += `<div class="record-note">${icon('info')}<span>采集事件未提供 Host / authority，上方保留网络端点；不据此推算请求 URL。</span></div>`;
  $('#tab-content').innerHTML = `${transportStrip}${notice}<h3 class="section-heading">${icon('down')}${state.tab === 'response' ? '响应头' : '请求头'}<span>${message.headers.length}</span><span class="heading-end">Headers</span></h3><div class="header-table">${message.headers.length ? message.headers.map(h => `<div class="header-pair"><span class="header-key">${escapeHTML(h.name.toLowerCase())}</span><span class="header-value ${h.value.includes('[REDACTED]') ? 'redacted' : ''}">${escapeHTML(h.value)}</span></div>`).join('') : '<div class="header-pair"><span class="header-key">暂无 Headers</span><span class="header-value">—</span></div>'}</div><section class="body-section"><h3 class="section-heading">${icon('down')}${state.tab === 'response' ? '响应正文' : '请求正文'}<span class="heading-end">${typeLabel} · ${bytes(message.byteLength ?? payloadBytes({body:message.body,encoding:message.bodyEncoding}).length)}</span></h3>${compressionControls(original,decoded)}<div class="body-toolbar"><div class="viewer-tabs" aria-label="正文显示方式">${imageType ? '' : `<button data-viewer="pretty" class="${state.viewer === 'pretty' ? 'active' : ''}" aria-pressed="${state.viewer === 'pretty'}">${typeLabel === 'HTML' ? '预览' : '格式化'}</button>`}<button data-viewer="raw" class="${state.viewer === 'raw' ? 'active' : ''}" aria-pressed="${state.viewer === 'raw'}">原文</button><button data-viewer="hex" class="${state.viewer === 'hex' ? 'active' : ''}" aria-pressed="${state.viewer === 'hex'}">Hex</button></div><div class="body-tools"><button class="icon-button compact ${state.wrap ? 'active' : ''}" data-wrap aria-label="自动换行" aria-pressed="${state.wrap}" title="自动换行">${icon('wrap')}</button><button class="icon-button compact" data-copy-body aria-label="复制正文" title="复制正文" ${message.body ? '' : 'disabled'}>${icon('copy')}</button></div></div><div class="body-view" id="body-view"></div></section>`;
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
    target.innerHTML = `<div class="empty-body">${icon(waiting ? 'activity' : failed ? 'alert' : 'code')}<strong>${missing ? '尚未捕获此消息' : waiting ? '尚未关联响应消息' : failed ? '未收到响应正文' : '此消息没有正文'}</strong><span>${waiting && !request.real ? '此样例没有可关联的最终响应' : failed ? '请查看连接信息或采集诊断' : '保留已观测到的 Headers 和事件信息'}</span></div>`;
    return;
  }
  if (state.viewer === 'raw' && /^image\//i.test(contentType.trim())) {
    renderImageBody(target,message,contentType);
    return;
  }
  if (state.viewer === 'pretty' && contentType.includes('html') && message.bodyEncoding !== 'hex') {
    target.innerHTML = '<iframe class="preview-frame" title="隔离的 HTML 响应预览" sandbox="" inert tabindex="-1" referrerpolicy="no-referrer" style="pointer-events:none"></iframe><div class="body-meta"><span>只读 HTML 预览 · 脚本与外部资源已禁用</span><span>UTF-8</span></div>';
    // The iframe itself is inert. Captured CSS cannot re-enable links and cause
    // network requests by overriding a pointer-events rule inside the document.
    $('iframe',target).srcdoc = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{font:14px/1.6 -apple-system,sans-serif;padding:14px;color:#273142;overflow-wrap:anywhere}a{pointer-events:none}</style>${message.body}`;
    return;
  }
  const text = payloadText({body:message.body,encoding:message.bodyEncoding || 'utf8',bytes:message.decodedBytes});
  const highlight = state.viewer === 'pretty' && contentType.includes('json') && message.bodyEncoding !== 'hex';
  const lines = text.split('\n');
  target.innerHTML = `<div class="code-window ${state.wrap ? 'wrap' : ''}"><pre aria-label="${state.tab === 'response' ? '响应' : '请求'}正文"><code>${lines.map((line,index) => `<span class="code-line"><span class="line-no" aria-hidden="true">${index+1}</span><span class="line-text">${highlight ? highlightJSON(line) : escapeHTML(line) || ' '}</span></span>`).join('')}</code></pre></div><div class="body-meta"><span>${lines.length} 行${state.viewer === 'hex' ? ' · Hex' : ''}</span><span>${message.bodyEncoding === 'hex' ? '二进制 · Hex' : escapeHTML((message.textEncoding || 'UTF-8').toUpperCase())}</span></div>`;
}

function renderImageBody(target,message,contentType) {
  const unavailable = (title,detail) => {
    target.innerHTML = `<div class="empty-body image-unavailable">${icon('info')}<strong>${escapeHTML(title)}</strong><span>${escapeHTML(detail)}</span></div>`;
  };
  if (contentCodings(message).length && !message.decodedBytes) {
    unavailable('当前为压缩数据', '图片需要成功解压后才能预览；可切换 Hex 查看已捕获字节。');
    return;
  }
  if (message.bodyEncoding === 'hex' && !/^(?:[a-f\d]{2})*$/i.test(message.body)) {
    unavailable('图片数据无效', '可切换 Hex 检查已捕获的内容。');
    return;
  }
  const data = payloadBytes({body:message.body,encoding:message.bodyEncoding,bytes:message.decodedBytes});
  if (message.truncated || message.byteLength > data.length) {
    unavailable('图片未完整捕获', '当前仅有部分图片字节，可切换 Hex 查看。');
    return;
  }
  if (typeof Blob === 'undefined' || !URL.createObjectURL) {
    unavailable('当前环境不支持图片预览', '可切换 Hex 查看本地捕获字节。');
    return;
  }
  const mime = contentType.split(';',1)[0].trim().toLowerCase();
  target.innerHTML = '<div class="image-preview"><img alt="捕获的图片正文" decoding="async"></div><div class="body-meta"><span class="image-dimensions">正在读取图片…</span><span>仅使用捕获内容</span></div>';
  const img = $('img',target), url = URL.createObjectURL(new Blob([data],{type:mime}));
  imagePreviewURL = url;
  img.onload = () => {
    if (imagePreviewURL !== url || !target.isConnected) return;
    $('.image-dimensions',target).textContent = `${img.naturalWidth} × ${img.naturalHeight} · ${bytes(data.length)}`;
  };
  img.onerror = () => {
    if (imagePreviewURL !== url || !target.isConnected) return;
    clearImagePreview();
    unavailable('无法预览图片', '图片数据损坏或当前浏览器不支持该格式，可切换 Hex 查看。');
  };
  // An img element keeps SVG in image mode: no scripts or external resources.
  // Never inject captured SVG into the document or fetch the original URL.
  img.src = url;
}

function payloadParts(record) {
  if (family(record) === 'redis' && record.metadata?.requestPayload !== undefined) {
    return [{label:'命令 RESP',body:record.metadata.requestPayload,encoding:record.metadata.requestPayloadEncoding || 'utf8'},...(record.metadata.responsePayload ? [{label:'响应 RESP',body:record.metadata.responsePayload,encoding:record.metadata.responsePayloadEncoding || 'utf8'}] : [])];
  }
  return [{label:family(record) === 'mysql' ? 'SQL 原始内容' : family(record) === 'redis' ? '原始 RESP' : '事件载荷',body:record.payload ?? '',encoding:record.payloadEncoding || 'utf8'}];
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
    const content = data.length ? `<div class="code-window ${state.wrap ? 'wrap' : ''}"><pre aria-label="${escapeHTML(part.label)}"><code>${lines.map((line,index) => `<span class="code-line"><span class="line-no" aria-hidden="true">${index+1}</span><span class="line-text">${json ? highlightJSON(line) : escapeHTML(line) || ' '}</span></span>`).join('')}</code></pre></div>` : `<div class="empty-body">${icon('code')}<strong>${record.metadata?.kind === 'datagram' ? '空 DATAGRAM · 0 字节' : '此事件没有载荷'}</strong><span>${record.metadata?.kind === 'datagram' ? '空数据报是有效事件，保留数据报边界' : '仍可在协议详情中检查事件字段'}</span></div>`;
    return `<section class="body-section protocol-payload"><h3 class="section-heading">${escapeHTML(part.label)}<span class="heading-end">${bytes(data.length)}</span></h3>${content}<div class="body-meta"><span>${data.length ? lines.length+' 行' : '0 字节'}</span><span>${part.encoding === 'hex' ? '二进制 · Hex' : 'UTF-8'}</span></div></section>`;
  }).join('');
  const note = record.note || record.metadata?.parseError || (record.metadata?.displayTruncated ? '载荷超过显示上限，当前仅展示捕获内容的前缀。' : family(record) === 'raw' ? '保留原始事件载荷与元数据；尚未映射为完整的应用消息。' : '');
  $('#tab-content').innerHTML = `${note ? `<div class="record-note">${icon('info')}<span>${escapeHTML(note)}</span></div>` : ''}<div class="body-toolbar payload-toolbar"><div class="viewer-tabs" aria-label="载荷显示方式">${[['pretty','格式化'],['raw','原文'],['hex','Hex']].map(([id,label]) => `<button data-viewer="${id}" class="${state.viewer === id ? 'active' : ''}" aria-pressed="${state.viewer === id}">${label}</button>`).join('')}</div><div class="body-tools"><button class="icon-button compact ${state.wrap ? 'active' : ''}" data-wrap aria-label="自动换行" aria-pressed="${state.wrap}">${icon('wrap')}</button><button class="icon-button compact" data-copy-body aria-label="复制载荷" title="复制载荷">${icon('copy')}</button></div></div>${panels}`;
}
function renderConnection(request,process) {
  const fields = entries => `<dl class="connection-fields">${entries.map(([key,value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value === '' || value == null ? '未提供' : value)}</dd>`).join('')}</dl>`;
  const m = request.metadata || {}, transport = (request.transport || '').toUpperCase();
  const source = family(request) === 'mysql' ? 'mysqld hook · SQL 查询事件' : family(request) === 'quic' ? '解密后的 QUIC 流 / 数据报事件' : family(request) === 'raw' ? '原始事件' : '解密后的应用协议消息';
  const quicContext = family(request) === 'quic' || request.protocol === 'HTTP/3' ? `<h3 class="connection-heading">QUIC 上下文</h3>${fields([['版本',m.quicVersion ?? m.version],['Connection ID',m.cid],...(m.kind === 'datagram' ? [] : [['Stream ID',request.streamId ?? m.streamId]]),...(isHTTP(request) ? [['ALPN',m.alpn],['QPACK',m.qpack]] : [['加密级别',m.encryptionLevel]])])}` : '';
  const endpoints = request.real ? [['源端点',request.sourceAddress],['目标端点',request.destinationAddress]] : [['本地端点',request.localAddress],['远端端点',request.remoteAddress]];
  const direction = {client_to_server:'客户端 → 服务端',server_to_client:'服务端 → 客户端',read:'进程读取',write:'进程写入'}[request.direction] || request.direction;
  const owners = [{...process,...(request.real ? {command:request.processCommand || '',commandTruncated:request.processCommandTruncated} : {})},request.responseProcess].filter(Boolean).filter((item,index,all) => all.findIndex(other => other.id === item.id) === index);
  const commands = owners.map(item => [owners.length > 1 ? `进程命令 · ${processLabel(item)}` : '进程命令',item.command ? item.command+(item.commandTruncated ? '（已截断，最多 256 字节）' : '') : '未提供']);
  const tls = m.tls && typeof m.tls === 'object' && !Array.isArray(m.tls) ? m.tls : null;
  const tlsValue = key => typeof tls?.[key] === 'string' ? tls[key] : null;
  const expectsTLS = request.real && ['tls','gotls','gnutls'].includes(sourceFor(request)?.capture?.module);
  const tlsContext = tls ? `<section class="tls-context"><h3 class="connection-heading">TLS 握手</h3>${fields([
    ['TLS 版本',tlsValue('version')],['密码套件',tlsValue('cipher_suite')],['套件编号',tlsValue('cipher_suite_id')],
    ['SNI',tlsValue('server_name')],['客户端 ALPN',tlsValue('offered_alpn')],['协商 ALPN',tlsValue('alpn')],['密钥交换组',tlsValue('key_exchange_group')],
    ['签名算法',tlsValue('signature_algorithm')],['JA3 · 客户端',tlsValue('ja3')],['JA4 · 客户端',tlsValue('ja4')]
  ])}<p class="tls-note">JA3 / JA4 来自客户端首次线上 ClientHello${tlsValue('client_hello') === 'initial_outer' ? '（ECH Outer）' : ''}；协商参数来自服务端握手。未提供表示当前事件中没有该字段。</p>${tlsValue('ja3_raw') ? `<details class="event-metadata"><summary>JA3 原始指纹</summary><pre>${escapeHTML(tls.ja3_raw)}</pre></details>` : ''}</section>` : expectsTLS ? '<section class="tls-context"><h3 class="connection-heading">TLS 握手</h3><p class="tls-note">当前事件未提供 TLS 握手信息。JA3、JA4 和协商参数需要由采集器传入，不能从 HTTP 内容推断。</p></section>' : '';
  $('#tab-content').innerHTML = `<div class="connection-content"><div class="connection-process">${avatar(process)}<div><strong>${escapeHTML(process.name)}</strong><p>${escapeHTML(processLabel(process))} · ${escapeHTML(process.kind || '')}</p></div></div><h3 class="connection-heading">进程归属</h3>${fields([['数据源',sourceFor(request)?.label || request.sourceId || workspace.session.host],['进程名',owners.map(item => item.name).join('；')],['进程 PID',owners.map(processLabel).join('；')],...commands,...(!request.real || !(request.processPid > 0) ? [['归属来源',request.real ? '采集器未提供' : '模拟数据']] : []),...(['mysql','quic','raw'].includes(family(request)) ? [['事件形态',source]] : [])])}<h3 class="connection-heading">事件与连接</h3>${fields([...endpoints,['协议',request.protocol],['传输层',transport],['连接标识',request.connectionId],['消息方向',direction],['采集时间',request.startedAt ? new Date(request.startedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})+' (UTC+8)' : null]])}${tlsContext}${quicContext}${request.real ? `<h3 class="connection-heading">采集来源 · ${escapeHTML(request.sourceId)}</h3><code class="source-endpoint">${escapeHTML(sourceFor(request)?.endpoint || '地址未登记')}</code>${sourceMetadata(sourceFor(request))}` : ''}${request.real ? `<details class="event-metadata"><summary>原始事件元数据</summary><pre>${escapeHTML(JSON.stringify(m,null,2))}</pre></details>` : ''}<div class="connection-explainer">${icon('info')}<span>${request.real ? '进程名表示捕获事件的进程归属，不据此判断客户端或服务端角色。进程命令是采集时的可读概览，可能已被进程改写；末尾空项已折叠，中间空参数保留，引号用于区分参数。原始 argv 字节保留在导出 JSON 中。方向表示应用消息流向。空缺字段保持未知；耗时不会依据秒级时间戳推算。' : '虚构的演示会话。进程归属、关联关系和耗时均为模拟字段。'}</span></div></div>`;
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
  try { await platform.copyText(text); toast(`${label}已复制`); }
  catch (error) { toast(error.message || '复制未获允许，请在正文中选择文本复制'); }
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
    if (!isHTTP(record)) copy(payloadParts(record).map(payloadText).join('\n\n'),'载荷');
    else {
      const message = displayedMessage(record,state.tab);
      if (message) copy(payloadText({body:message.body,encoding:message.bodyEncoding || 'utf8',bytes:message.decodedBytes}),'正文');
    }
  } else if (button.id === 'copy-curl') {
    if (selected()?.request && hasHTTPURL(selected())) copy(curlCommand(selected()),'cURL 命令');
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
  toast(marked ? '已取消标记' : '已加入左侧「已标记」');
});
$('#copy-url').addEventListener('click',() => { if (selected()) copy($('#detail-url').textContent,hasHTTPURL(selected()) ? 'URL' : '端点'); });
$('#toggle-processes').addEventListener('click',() => $('#workspace').classList.toggle('sidebar-open'));
$('#back-to-list').addEventListener('click',() => $('#workspace').classList.remove('detail-open'));

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('#theme-toggle').innerHTML = icon(theme === 'dark' ? 'sun' : 'moon');
  $('#theme-toggle').setAttribute('aria-label',theme === 'dark' ? '切换浅色模式' : '切换深色模式');
  try { localStorage.setItem('ecaptureq-theme',theme); } catch { /* Storage is optional. */ }
}
$('#theme-toggle').addEventListener('click',() => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'));
try { setTheme(localStorage.getItem('ecaptureq-theme') === 'dark' ? 'dark' : 'light'); } catch { setTheme('light'); }

const connectionStates = {connected:'已连接',connecting:'连接中',reconnecting:'正在重连',disconnected:'已断开',unconfigured:'未配置采集器',stopped:'已停止',partial:'部分连接',degraded:'部分连接',idle:'等待连接'};
function statusSources() { return Array.isArray(serverStatus.sources) ? serverStatus.sources : []; }
function sourceFor(record) { return statusSources().find(source => source.id === record.sourceId); }
function sourceMetadata(source) {
  const c = source?.capture;
  if (!c) return '<p class="source-intro">采集主机、模式与启动参数未登记；eCaptureQ 事件本身不提供这些信息。</p>';
  const fields = [['采集主机',c.host],['模块',c.module],['模式 / 数据源',[c.mode,c.textSource].filter(Boolean).join(' / ')],['eCapture commit',c.collectorCommit],['Decryptor',c.decryptorVersion]];
  return `<dl class="connection-fields source-fields">${fields.map(([key,value]) => `<dt>${escapeHTML(key)}</dt><dd>${escapeHTML(value || '未登记')}</dd>`).join('')}</dl><p class="source-command-label">启动命令 · 服务端登记</p><pre class="source-command"><code>${escapeHTML(c.command || '未登记')}</code></pre>`;
}
function updateCaptureControls() {
  const live = state.mode === 'live', snapshot = live && !!workspace?.snapshot, button = $('#capture-toggle');
  button.hidden = snapshot;
  button.classList.toggle('running',live ? !state.paused : state.running);
  button.classList.toggle('live-capture',live);
  button.innerHTML = `${live ? icon(state.paused ? 'play' : 'pause') : '<span class="record-dot"></span>'}<span>${live ? state.paused ? '恢复刷新' : '暂停刷新' : state.running ? '暂停模拟' : '开始模拟'}</span>`;
  button.title = live ? '冻结当前记录以便检查；后台继续接收，恢复后显示最新记录' : '追加虚构样例';
  button.setAttribute('aria-pressed',String(live ? state.paused : state.running));
  $('#reset-demo').hidden = live;
  $$('[data-mode]').forEach(button => { button.setAttribute('aria-pressed',String(button.dataset.mode === state.mode)); button.disabled = !!window.__ECAPTURE_MOCK__ && !window.__ECAPTURE_CAPTURE__ && button.dataset.mode === 'live'; if (button.dataset.mode === 'live') button.textContent = window.__ECAPTURE_CAPTURE__ ? '快照' : '实时'; });
  const sources = statusSources(), connected = sources.filter(source => source.state === 'connected').length;
  const offline = !!(window.__ECAPTURE_CAPTURE__ || window.__ECAPTURE_MOCK__);
  const label = serviceError || connectionStates[serverStatus.state] || (connected ? '已连接' : '等待连接');
  $('#mode-label').textContent = snapshot ? `快照 · ${sources.length} 源` : offline ? '模拟数据' : serviceError ? '数据源 · 服务断开' : `数据源 ${connected}/${sources.length}`;
  $('#connection-toggle').title = sources.length ? sources.map(source => `${source.label}: ${connectionStates[source.state] || source.state}`).join('\n') : '添加第一个 eCapture 数据源';
  $('#connection-toggle').setAttribute('aria-label',snapshot ? '查看采集快照的数据源' : `管理数据源：${connected} 个已连接，共 ${sources.length} 个`);
  $('#connection-toggle').dataset.state = snapshot ? 'snapshot' : offline ? 'mock' : serviceError ? 'error' : connected === sources.length && connected > 0 ? 'connected' : connected > 0 ? 'degraded' : 'waiting';
  $('#live-label').textContent = snapshot ? '已保存 · 非实时' : live ? state.paused ? '刷新已暂停 · 后台继续接收' : '自动刷新 · 1 秒' : state.running ? '正在生成模拟记录' : '样例会话';
  $('#live-label').classList.toggle('running',live ? !snapshot && !state.paused && connected > 0 : state.running);
  const dropped = Number(serverStatus.dropped || 0), evicted = Number(serverStatus.evicted || 0);
  $('#status-message').textContent = snapshot ? `真实采集快照 · ${requests.length} 条记录 · 当前未连接采集器` : live ? `${state.paused ? '刷新已暂停' : '实时数据'} · ${label}${statusSources().length ? ` · ${connected}/${statusSources().length} 个数据源` : ''}${dropped ? ` · ${dropped} 条未保留` : ''}${evicted ? ` · ${evicted} 条超出保留范围` : ''}` : state.running ? '模拟采集中 · 不发送真实网络请求' : '演示会话 · 虚构样例';
  $('.status-indicator').classList.toggle('status-warning',live && !snapshot && (serviceError || !connected));
  $('.sidebar-caption').textContent = live ? 'LIVE' : 'MOCK';
  $('#add-source-toggle').hidden = offline;
  $('#add-source-toggle').disabled = sources.length >= 16;
  $('#source-save-hint').textContent = serverStatus.sourcePersistence === 'file' ? '保存到来源配置，重启后保留' : '当前服务会话内保留';
  if ($('#connection-dialog').open) renderConnectionStatus();
}
const sourceErrors = {invalid_endpoint:'请输入 ws:// 或 wss:// 地址，不包含账号、查询参数或片段。',invalid_label:'名称最多 160 个字符。',duplicate_source:'这个地址已添加，请在下方查看连接状态。',source_limit:'最多支持 16 个数据源。',source_save_failed:'无法保存来源配置，请检查服务端文件权限。',source_config_changed:'来源配置已在外部修改，请重新启动服务加载后再添加。',source_config_too_large:'来源配置超过容量上限，请缩短填写内容。',service_stopping:'服务正在停止，请稍后重试。',origin_rejected:'请求来源校验失败，请从当前 eCaptureQ 窗口重新提交。',invalid_source:'数据源信息格式无效。',connection_failed:'连接中断或暂不可达，正在自动重试',frame_too_large:'上游消息超过接收限制',json_required:'请提交 JSON 格式的数据源。'};
let renderedSourceLogs = '';
function renderConnectionStatus() {
  const sources = statusSources();
  const expanded = new Set($$('[data-source-details][open]').map(element => element.dataset.sourceDetails));
  const logs = Array.isArray(serverStatus.logs) ? serverStatus.logs.slice(-8).reverse() : [];
  const counts = ['connected','connecting','reconnecting','stopped'].map(state => ({state,count:sources.filter(source=>source.state===state).length})).filter(item=>item.count);
  const summary = `<div class="source-summary">${counts.map(item=>`<span data-state="${item.state}">${escapeHTML(connectionStates[item.state])} <strong>${item.count}</strong></span>`).join('')}<span class="source-summary-total">共 ${sources.length} 个数据源</span></div>`;
  $('#connection-status').innerHTML = `<p class="source-intro">${workspace?.snapshot ? '这是合成测试流量经过真实 eBPF 捕获生成的只读快照，当前不连接采集器。可切换到独立的模拟样例。' : state.mode === 'mock' ? '当前展示模拟会话。已配置的数据源独立连接并持续接收，切换到实时模式即可查看。' : '各数据源独立接收事件和自动重连，单个来源断开不会影响其他连接。'}</p>${summary}${serverStatus.excludeHTTPPathPrefix ? `<p class="source-intro">已排除 ${escapeHTML(serverStatus.excludeHTTPPathPrefix)} 与工作台响应 · ${Number(serverStatus.filtered || 0)} 条事件</p>` : ''}${serviceError ? `<div class="source-error">${escapeHTML(serviceError)}，下方保留最后一次连接状态。</div>` : ''}${sources.length ? sources.map(source => `<div class="source-card" data-source-id="${escapeHTML(source.id)}"><div><strong>${escapeHTML(source.label || source.id)}</strong><span class="source-state" data-state="${safeClass(source.state)}">${escapeHTML(connectionStates[source.state] || source.state)}</span></div><code>${escapeHTML(source.endpoint || '')}</code><p>${escapeHTML(source.capture?.host || '主机未登记')} · ${escapeHTML(source.capture?.module || '模块未登记')} · 事件 ${Number(source.events || 0)}</p><p>重试 ${Number(source.retries || 0)} · 已恢复连接 ${Number(source.reconnects || 0)}</p>${source.lastError ? `<p class="source-error">${escapeHTML(sourceErrors[source.lastError] || source.lastError)}</p>` : ''}<details data-source-details="${escapeHTML(source.id)}" ${expanded.has(source.id) ? 'open' : ''}><summary>采集信息与启动参数</summary>${sourceMetadata(source)}</details></div>`).join('') : `<div class="source-card source-empty"><strong>还没有数据源</strong><p>${window.__ECAPTURE_MOCK__ ? '离线演示不能连接采集器，请使用 Go 服务。' : '点击「添加数据源」，连接一个或多个 eCapture 采集器。'}</p></div>`}<div class="source-totals"><span>接收事件 <strong>${Number(serverStatus.events || 0)}</strong></span><span>无效消息 <strong>${Number(serverStatus.malformed || 0)}</strong></span><span>未映射事件 <strong>${Number(serverStatus.ignored || 0)}</strong></span></div>`;
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
$('#add-source-form').addEventListener('input',() => { $('#source-form-error').hidden = true; });
$('#add-source-form').addEventListener('submit',async event => {
  event.preventDefault();
  if (window.__ECAPTURE_CAPTURE__ || window.__ECAPTURE_MOCK__) return;
  const button = $('#submit-source'), error = $('#source-form-error');
  if (button.disabled) return;
  const form = new FormData(event.currentTarget), source = {label:String(form.get('label')).trim(),endpoint:String(form.get('endpoint')).trim()};
  const host = String(form.get('host')).trim(), module = String(form.get('module')), command = String(form.get('command')).trim();
  if (host || module || command) source.capture = {host,module,command,mode:module ? 'text' : '',textSource:module ? 'pcapng' : ''};
  button.disabled = true; button.textContent = '正在添加…'; error.hidden = true;
  const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),10000);
  try {
    const response = await fetch('api/sources',{method:'POST',headers:{'Content-Type':'application/json','X-Ecapture-UI':'1'},body:JSON.stringify(source),signal:controller.signal});
    const result = await response.json();
    if (!response.ok) throw new Error(sourceErrors[result.error] || '添加失败，请稍后重试。');
    serverStatus = result.status; serviceError = '';
    $('#add-source-form').reset(); $('#add-source-form').hidden = true;
    updateCaptureControls();
    toast(`已添加 ${result.source.label}，正在连接`);
  } catch (failure) {
    error.textContent = failure.name === 'AbortError' ? '请求超时，请先检查下方是否已添加，再重试。' : failure.message || '添加失败，请检查服务连接。'; error.hidden = false;
  } finally { clearTimeout(timeout); button.disabled = false; button.textContent = '添加并连接'; }
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
  clearFilters(); updateCaptureControls(); toast(`已恢复 ${seeds.length} 条样例记录`);
});
$('#export-data').addEventListener('click',async () => {
  if (!workspace) return;
  let list = filteredRequests();
  if (isPaged()) {
    const full=[];$('#export-data').disabled=true;
    try {
      for(let i=0;i<list.length;i+=4) full.push(...await Promise.all(list.slice(i,i+4).map(async row=>{
        const response=await fetchWithTimeout('api/record?id='+encodeURIComponent(row.id),{cache:'no-store'});
        if(!response.ok)throw new Error('记录已淘汰或暂时不可用');return response.json();
      })));
      list=full;
    } catch { toast('导出失败：请刷新列表后重试');return; }
    finally { $('#export-data').disabled=false; }
  }
  $('#export-data').disabled=true;
  try {
    const result = await platform.exportJSON(state.mode === 'live' ? 'ecaptureq-live-session.json' : 'ecaptureq-demo-session.json',
      JSON.stringify({session:workspace.session,processes:workspace.processes,requests:list},null,2));
    if (!result.cancelled) toast(`已导出当前筛选的 ${list.length} 条${state.mode === 'live' ? '实时' : '模拟'}记录`);
  } catch (error) { toast('导出失败：'+error.message); }
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

function makeResizable(id,variable,min,max,invert,startAtMax = false) {
  const separator = $(id);
  let preferredWidth = max;
  const apply = value => {
    preferredWidth = Math.max(min,Math.min(max,value));
    const available = $('#workspace').clientWidth;
    const other = variable === '--sidebar-width' ? $('#detail-pane').clientWidth : $('#sidebar').clientWidth;
    const dynamicMax = Math.max(min,Math.min(max,available-other-310));
    const constrained = Math.round(Math.max(min,Math.min(dynamicMax,preferredWidth)));
    document.documentElement.style.setProperty(variable,`${constrained}px`);
    separator.setAttribute('aria-valuemax',dynamicMax);
    separator.setAttribute('aria-valuenow',constrained);
  };
  if (startAtMax) {
    // The leftmost separator position gives the detail pane its maximum width.
    const observer = new ResizeObserver(() => apply(preferredWidth));
    observer.observe($('#workspace'));
    observer.observe($('#sidebar'));
    apply(max);
  }
  separator.addEventListener('pointerdown',event => {
    if (event.button !== 0) return;
    event.preventDefault(); separator.setPointerCapture(event.pointerId);
    const startX = event.clientX;
    const target = variable === '--sidebar-width' ? $('#sidebar') : $('#detail-pane');
    const startWidth = target.getBoundingClientRect().width;
    separator.classList.add('dragging'); document.body.classList.add('resizing');
    const move = e => apply(startWidth+(e.clientX-startX)*(invert ? -1 : 1));
    const finish = () => { separator.classList.remove('dragging'); document.body.classList.remove('resizing'); separator.removeEventListener('pointermove',move); separator.removeEventListener('pointerup',finish); separator.removeEventListener('pointercancel',finish); };
    separator.addEventListener('pointermove',move); separator.addEventListener('pointerup',finish); separator.addEventListener('pointercancel',finish);
  });
  separator.addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const current = (variable === '--sidebar-width' ? $('#sidebar') : $('#detail-pane')).getBoundingClientRect().width;
    apply(current+(event.key === 'ArrowRight' ? 12 : -12)*(invert ? -1 : 1));
  });
}
makeResizable('#sidebar-splitter','--sidebar-width',176,300,false);
makeResizable('#detail-splitter','--detail-width',340,720,true,true);

async function fetchWorkspace(mode, signal, useFilters = false) {
  if (window.__ECAPTURE_CAPTURE__ && mode !== 'mock') return {...structuredClone(window.__ECAPTURE_CAPTURE__),mode:'live',snapshot:true};
  if (window.__ECAPTURE_MOCK__) return {...structuredClone(window.__ECAPTURE_MOCK__),mode:'mock'};
  const filters = useFilters ? liveFilters() : {process:'',protocol:'',domain:'',scope:'all',filter:'all',q:'',bookmarks:''};
  const params=new URLSearchParams({...filters,view:'page',page:String(useFilters ? pageIndex : 0)});
  if(mode)params.set('mode',mode);
  const response = await fetch('api/workspace?'+params,{cache:'no-store',signal});
  if (!response.ok) throw new Error('工作区服务不可用');
  const next = await response.json();
  if(next.page) {next.page.filterKey=JSON.stringify(filters);next.page.requestKey=params.toString();}
  if (!Array.isArray(next.requests) || !Array.isArray(next.processes) || !next.session) throw new Error('工作区数据无效');
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
  catch { if (workspace) { serviceError = '服务暂不可用'; updateCaptureControls(); toast('模式切换失败，已保留当前会话'); } }
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
    if (generation === loadGeneration) { serviceError = '服务暂不可用'; updateCaptureControls(); }
  } finally { clearTimeout(timeout); refreshing = false; }
}
platform.init().then(mode => {
  $('.web-badge').textContent = mode.desktop ? 'DESKTOP' : 'WEB';
}).catch(error => toast(error.message));
// Browser links retain normal navigation and user activation. Desktop routes
// external navigation through the native adapter, away from the capture UI.
document.addEventListener('click',event => {
  const link = event.target.closest('a[target="_blank"]');
  if (!link || !platform.desktop) return;
  event.preventDefault();
  platform.openExternal(link.href).catch(error => toast(error.message));
});
loadWorkspace().catch(() => {
  $('#loading').innerHTML = `${icon('alert','large-icon')}<strong>工作区加载失败</strong><span>请确认 Go 服务正在运行，然后刷新页面。</span>`;
});
pollTimer = setInterval(refreshLive,1000);
window.addEventListener('beforeunload',() => { clearInterval(timer); clearInterval(pollTimer); clearImagePreview(); clearTimeout(pageTimer); detailController?.abort(); loadController?.abort(); });
