// Protocol-specific presentation of decoded capture events and mock records.
// Capture transport and message association belong to the shared Go service.
import {t} from './i18n.js';

export const protocolViews = (() => {
  const directions = {
    client_to_server: ['客户端', '服务端', '客户端 → 服务端'],
    server_to_client: ['服务端', '客户端', '服务端 → 客户端'],
  };

  function tabs(record) {
    const connection = {id:'connection', label:t('连接')};
    switch (record.family) {
      case 'quic': return [{id:'overview',label:t('流事件')},{id:'payload',label:t('载荷')},connection];
      case 'mysql': return [{id:'query',label:t('SQL 查询')},{id:'overview',label:t('捕获信息')},{id:'payload',label:t('原始')},connection];
      case 'redis': {
        const kind = record.metadata?.kind;
        return kind === 'push' || kind === 'attribute'
          ? [{id:'result',label:kind === 'push' ? t('推送消息') : t('属性')},{id:'command',label:t('关联信息')},{id:'payload',label:t('原始 RESP')},connection]
          : [{id:'command',label:t('命令')},{id:'result',label:t('响应')},{id:'payload',label:t('原始 RESP')},connection];
      }
      case 'mqtt': return [{id:'overview',label:t('报文')},{id:'payload',label:t('载荷')},connection];
      default: return [];
    }
  }

  function valueText(value) {
    if (value === undefined) return '—';
    if (value === null) return 'null';
    if (typeof value === 'boolean') return String(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  }

  function fields(entries, h) {
    return `<dl class="pv-fields">${entries.map(([key,value]) => `<dt>${h.escapeHTML(key)}</dt><dd>${h.escapeHTML(valueText(value))}</dd>`).join('')}</dl>`;
  }

  function section(title, content, h, auxiliary = '') {
    return `<section class="pv-section"><h3 class="pv-heading">${h.escapeHTML(title)}${auxiliary ? `<span>${h.escapeHTML(auxiliary)}</span>` : ''}</h3>${content}</section>`;
  }

  function notice(title, detail, h, tone = 'neutral') {
    return `<div class="pv-notice pv-notice-${tone}">${h.icon(tone === 'neutral' ? 'info' : 'alert')}<div><strong>${h.escapeHTML(title)}</strong>${detail ? `<p>${h.escapeHTML(detail)}</p>` : ''}</div></div>`;
  }

  function badge(text, h, tone = 'neutral') {
    return `<span class="pv-badge pv-badge-${tone}">${h.escapeHTML(valueText(text))}</span>`;
  }

  function flow(record, h) {
    if (!Object.hasOwn(directions,record.direction)) return '';
    const direction = directions[record.direction].map(key => t(key));
    return `<div class="pv-flow" aria-label="${direction[2]}"><span>${direction[0]}</span>${h.icon('arrow')}<span>${direction[1]}</span><small>${h.escapeHTML(record.transport?.toUpperCase() || '')}</small></div>`;
  }

  function quic(record, h) {
    const m = record.metadata || {};
    const isDatagram = m.kind === 'datagram';
    const isReset = m.kind === 'stream_reset';
    const names = {stream_chunk:t('STREAM 数据'),stream_end:t('STREAM 结束'),stream_reset:t('STREAM 重置'),datagram:'DATAGRAM'};
    const streamId = m.streamId ?? record.streamId;
    const header = `<div class="pv-event-title"><strong>${h.escapeHTML(names[m.kind] || m.kind || t('QUIC 事件'))}</strong>${badge(isDatagram ? t('数据报') : `Stream ${streamId ?? '—'}`,h,'blue')}</div>`;
    let state = '';
    if (isDatagram && record.sizeBytes === 0) state = notice(t('已捕获一个空数据报'),t('长度为 0，仍保留独立的数据报边界。'),h);
    if (isReset) state = notice(t('已观察到流重置'),t('错误码 {code}；该事件保留已捕获的数据状态。',{code:valueText(m.errorCode)}),h,'amber');
    if (m.earlyData === 'rejected') state += notice(t('0-RTT 数据被拒绝'),t('这里保留已解密的早期字节，不将其标记为对端已接受。'),h,'amber');
    const eventFields = isDatagram
      ? [[t('事件类型'),m.kind],[t('数据长度'),h.bytes(record.sizeBytes ?? 0)],[t('消息边界'),t('单个 DATAGRAM')],['Stream ID',t('不适用')],[t('可靠交付状态'),t('不推断')]]
      : [[t('事件类型'),m.kind],['Stream ID',streamId],[t('起始偏移'),m.offset],[t('数据长度'),h.bytes(record.sizeBytes ?? 0)],[t('结束标记'),m.end],...(isReset ? [[t('错误码'),m.errorCode]] : [])];
    const transportFields = [[t('QUIC 版本'),m.version],['Connection ID',m.cid],[t('加密级别'),m.encryptionLevel],...(m.earlyData !== undefined ? [[t('早期数据'),m.earlyData]] : [])];
    return header + flow(record,h) + state + section(t('事件字段'),fields(eventFields,h),h) + section(t('QUIC 上下文'),fields(transportFields,h),h) + `<p class="pv-footnote">${t('按流与方向查看已解密数据；此视图不将 QUIC 事件解释为 HTTP 请求。')}</p>`;
  }

  function sqlHighlight(sql, h) {
    const tokens = /(--[^\n]*|'(?:''|[^'])*'|"(?:""|[^"])*"|\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|IS|IN|VALUES|INSERT|INTO|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|ORDER|BY|GROUP|LIMIT|OFFSET|ASC|DESC|COUNT|SUM|AVG|DISTINCT|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK|SHOW|EXPLAIN)\b|\b\d+(?:\.\d+)?\b)/gi;
    let output = '', cursor = 0;
    for (const match of sql.matchAll(tokens)) {
      output += h.escapeHTML(sql.slice(cursor,match.index));
      const token = match[0];
      const kind = token.startsWith('--') ? 'comment' : /^["']/.test(token) ? 'string' : /^\d/.test(token) ? 'number' : 'keyword';
      output += `<span class="pv-sql-${kind}">${h.escapeHTML(token)}</span>`;
      cursor = match.index+token.length;
    }
    return output+h.escapeHTML(sql.slice(cursor));
  }

  function mysql(record, tab, h) {
    const m = record.metadata || {};
    const truncated = m.truncated === true;
    const sql = m.sql ?? record.payload ?? '';
    const queryKind = sql.trim().match(/^[a-z]+/i)?.[0].toUpperCase() || 'QUERY';
    const boundary = truncated
      ? notice(t('SQL 捕获内容已截断'),t('已捕获 {captured} / {original} 字节；仅展示已捕获的查询片段。',{captured:valueText(m.capturedLength),original:valueText(m.originalLength)}),h,'amber')
      : '';
    if (tab === 'query') {
      return `<div class="pv-event-title"><strong>${t('查询事件')}</strong>${badge(queryKind,h,'purple')}</div>${boundary}${section('SQL',`<div class="pv-sql-code"><pre><code>${sqlHighlight(sql,h)}</code></pre></div>`,h,t('{count} 字节',{count:valueText(m.capturedLength)}))}${section(t('捕获摘要'),fields([[t('来源'),m.captureSource],[t('捕获 / 原始长度'),t('{captured} / {original} 字节',{captured:valueText(m.capturedLength),original:valueText(m.originalLength)})],[t('截断'),m.truncated]],h),h)}<p class="pv-footnote">${t('展示 mysqld 探针观察到的查询，不包含数据库结果集。')}</p>`;
    }
    const abnormal = Number(m.dispatchCode) === -2;
    return `<div class="pv-event-title"><strong>${t('探针捕获信息')}</strong>${badge(truncated ? t('部分内容') : t('查询事件'),h,truncated ? 'amber' : 'neutral')}</div>${boundary}${abnormal ? notice(t('派发返回值异常'),t('保留探针观察值，不据此推断 SQL 的最终执行结果。'),h,'amber') : ''}${section(t('查询捕获'),fields([[t('采集来源'),m.captureSource],[t('已捕获长度'),m.capturedLength],[t('原始查询长度'),m.originalLength],[t('发生截断'),m.truncated]],h),h)}${section('dispatch_command',fields([[t('返回码'),m.dispatchCode],[t('返回值名称'),m.dispatchReturn]],h),h)}${notice(t('派发返回值不是 SQL 执行结果'),t('SUCCESS 表示观察到的函数返回值；不代表事务提交、执行耗时或结果集已被采集。'),h)}`;
  }

  const respTypeNames = {simple_string:'Simple string',bulk_string:'Bulk string',integer:'Integer',double:'Double',boolean:'Boolean',array:'Array',map:'Map',set:'Set',null:'Null',error:'Error',push:'Push',attribute:'Attribute'};
  function responseNode(node, h, label = '', depth = 0) {
    if (!node || typeof node !== 'object' || !Object.prototype.hasOwnProperty.call(node,'type')) {
      return `<div class="pv-tree-value"><span class="pv-tree-key">${h.escapeHTML(label)}</span><code>${h.escapeHTML(valueText(node))}</code></div>`;
    }
    const type = node.type;
    const typeLabel = respTypeNames[type] || type;
    const value = node.value;
    const isMap = (type === 'map' || type === 'attribute') && Array.isArray(value);
    const isList = ['array','set','push'].includes(type) && Array.isArray(value);
    const prefix = label ? `<span class="pv-tree-key">${h.escapeHTML(label)}</span>` : '';
    if (isMap || isList) {
      const children = isMap
        ? value.map((entry,index) => `<div class="pv-map-entry"><div class="pv-map-key">${responseNode(entry.key,h,t('键 {index}',{index}),depth+1)}</div>${responseNode(entry.value,h,t('值'),depth+1)}</div>`).join('')
        : value.map((child,index) => responseNode(child,h,`[${index}]`,depth+1)).join('');
      return `<details class="pv-tree-group" ${depth < 2 ? 'open' : ''}><summary>${prefix}${badge(typeLabel,h,type === 'push' ? 'purple' : 'neutral')}<span class="pv-tree-count">${t(isMap ? '{count} 对' : '{count} 项',{count:value.length})}</span></summary><div class="pv-tree-children">${children || `<span class="pv-tree-empty">${t('空集合')}</span>`}</div></details>`;
    }
    const formatted = type === 'null' ? '(nil)' : node.encoding === 'hex' ? '0x'+valueText(value) : typeof value === 'string' && ['simple_string','bulk_string','verbatim_string'].includes(type) ? JSON.stringify(value) : valueText(value);
    return `<div class="pv-tree-value ${type === 'error' ? 'pv-tree-error' : ''}">${prefix}${badge(typeLabel,h,type === 'error' ? 'red' : type === 'null' ? 'amber' : 'neutral')}<code>${h.escapeHTML(formatted)}</code></div>`;
  }

  function redis(record, tab, h) {
    const m = record.metadata || {};
    const push = m.kind === 'push', attribute = m.kind === 'attribute';
    if (tab === 'command') {
      if (push || attribute) {
        return `<div class="pv-event-title"><strong>${push ? t('服务器主动推送') : t('RESP3 属性')}</strong>${badge(`RESP${m.respVersion ?? 3}`,h,'purple')}</div>${flow(record,h)}${section(t('消息关联'),fields([[t('消息种类'),m.kind],...(m.channel !== undefined ? [['Channel',m.channel]] : []),[t('请求编号'),m.requestId === undefined ? t('无关联请求') : m.requestId],[t('关联状态'),m.matched]],h),h)}${notice(push ? t('独立的推送消息') : t('独立的属性信息'),push ? t('此消息不消耗普通命令的响应位置。') : t('属性信息单独展示，不伪造新的命令响应。'),h)}`;
      }
      const args = Array.isArray(m.args) ? m.args : [];
      return `<div class="pv-event-title"><strong>${t('Redis 命令')}</strong>${badge(m.command || 'COMMAND',h,'purple')}</div>${flow(record,h)}${section(t('命令参数'),`<div class="pv-command-line"><span>${h.escapeHTML(m.command || '')}</span>${args.map(arg => `<code>${h.escapeHTML(JSON.stringify(arg))}</code>`).join(' ')}</div><ol class="pv-arguments">${args.map((arg,index) => `<li><span>${index}</span><code>${h.escapeHTML(arg)}</code></li>`).join('')}</ol>`,h,t('{count} 个参数',{count:args.length}))}${section(t('关联信息'),fields([[t('协议'),`RESP${m.respVersion ?? '—'}`],[t('请求编号'),m.requestId],[t('已关联响应'),m.matched],[t('消息种类'),m.kind]],h),h)}${m.matched === false ? notice(t('尚无可关联的响应'),t('保留未匹配状态，不按显示顺序强行配对。'),h,'amber') : ''}`;
    }
    const title = push ? m.channel !== undefined ? t('Pub/Sub 推送') : m.pushKind === 'invalidate' ? t('缓存失效通知') : t('Redis 推送') : attribute ? t('响应属性') : t('Redis 响应');
    let context = '';
    if (push) context = notice(t('服务器推送'),m.channel !== undefined ? t('Channel：{channel}',{channel:m.channel}) : m.pushKind === 'invalidate' ? t('服务端通知下方键已失效；数组内容是键列表。') : t('此消息独立于普通命令响应。'),h);
    if (m.result === null || m.result === undefined) {
      return `<div class="pv-event-title"><strong>${title}</strong>${badge(`RESP${m.respVersion ?? '—'}`,h)}</div>${context}<div class="pv-waiting">${h.icon('activity')}<strong>${t('等待响应')}</strong><span>${t('尚未观察到可关联的 RESP 值')}</span></div>`;
    }
    const error = m.result?.type === 'error' || !!m.error;
    return `<div class="pv-event-title"><strong>${title}</strong>${badge(`RESP${m.respVersion ?? '—'}`,h,push ? 'purple' : 'neutral')}</div>${context}${error ? notice(t('Redis 返回错误'),typeof m.error === 'string' ? m.error : t('错误内容保留在下方 RESP 值中。'),h,'red') : ''}${section(t('结构化 RESP 值'),`<div class="pv-response-tree">${responseNode(m.result,h)}</div>`,h)}${section(t('消息关联'),fields([[t('种类'),m.kind],[t('请求编号'),m.requestId === undefined ? t('不适用') : m.requestId],[t('已匹配'),m.matched]],h),h)}<p class="pv-footnote">${t('Null 表示协议中的空值；它与尚未收到响应分别展示。')}</p>`;
  }

  function mqtt(record, h) {
    const m = record.metadata || {};
    const name = m.packetName || record.operation || 'MQTT';
    const isPublish = name === 'PUBLISH';
    const packetId = m.packetId === undefined ? (isPublish && m.qos === 0 ? t('不适用（QoS 0）') : ['CONNECT','CONNACK','PINGREQ','PINGRESP','DISCONNECT'].includes(name) ? t('不适用') : t('未提供')) : m.packetId;
    const topicInfo = m.topic !== undefined ? section('Topic',`<div class="pv-topic">${h.escapeHTML(m.topic)}</div>`,h) : '';
    const topicRows = Array.isArray(m.topics) ? m.topics : [];
    const topics = topicRows.length ? section(t('订阅主题'),`<table class="pv-topics"><thead><tr><th>${t('主题筛选器')}</th><th>QoS</th></tr></thead><tbody>${topicRows.map(item => `<tr><td>${h.escapeHTML(typeof item === 'string' ? item : item.topic)}</td><td>${h.escapeHTML(typeof item === 'string' ? '—' : valueText(item.qos))}</td></tr>`).join('')}</tbody></table>`,h,t('{count} 项',{count:topicRows.length})) : '';
    const main = [[t('报文类型'),`${name} (${valueText(m.packetType)})`],['Client ID',m.clientId],['Packet ID',packetId]];
    if (m.qos !== undefined) main.push(['QoS',m.qos]);
    if (m.dup !== undefined) main.push(['DUP',m.dup]);
    if (m.retain !== undefined) main.push(['RETAIN',m.retain]);
    if (m.keepAlive !== undefined) main.push([t('保持连接'),`${m.keepAlive} s`]);
    if (m.protocolLevel !== undefined) main.push([t('协议级别'),m.protocolLevel]);
    if (m.cleanSession !== undefined) main.push([t('清理会话'),m.cleanSession]);
    if (m.sessionPresent !== undefined) main.push([t('已有会话'),m.sessionPresent]);
    if (m.returnCode !== undefined) main.push([t('返回码'),m.returnCode]);
    if (m.returnCodes !== undefined) main.push([t('返回码'),m.returnCodes]);
    if (m.username !== undefined) main.push([t('用户名'),m.username]);
    if (m.password !== undefined) main.push([t('密码'),'[REDACTED]']);
    if (m.ackObserved !== undefined) main.push([t('ACK 已观察到'),m.ackObserved]);
    return `<div class="pv-event-title"><strong>${h.escapeHTML(name)}</strong>${badge('MQTT 3.1.1',h,'blue')}</div>${flow(record,h)}${m.dup === true ? notice(t('DUP 标记已置位'),t('显示报文携带的重复标记，不据此推断投递次数或最终结果。'),h,'amber') : ''}${topicInfo}${topics}${section(t('报文字段'),fields(main,h),h)}${section(t('载荷'),fields([[t('长度'),h.bytes(record.sizeBytes ?? 0)],[t('内容编码'),record.payloadEncoding || 'utf8']],h),h)}<p class="pv-footnote">${t('此处展示已观察到的 MQTT 报文。QoS 和 ACK 观察值不构成消息投递成功的证明。')}</p>`;
  }

  function render(record, tab, helpers) {
    let content = '';
    switch (record.family) {
      case 'quic': content = quic(record,helpers); break;
      case 'mysql': content = mysql(record,tab,helpers); break;
      case 'redis': content = redis(record,tab,helpers); break;
      case 'mqtt': content = mqtt(record,helpers); break;
      default: content = notice(t('暂无协议详情'),t('可在载荷页查看原始内容。'),helpers);
    }
    return `<div class="pv-view" data-protocol-view="${helpers.escapeHTML(record.family)}">${content}</div>`;
  }

  return {tabs,render};
})();
