// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import {t} from './i18n.js';
import {mockNoteMessages, mockSummaryMessages} from './messages.js';

// These exact notes are authored by internal/app/mapper.go, not by a capture.
const mapperNotes = new Map([
  ['Request was not observed or is no longer retained in this capture session.', '当前采集会话未观测到请求，或请求已超出保留范围。'],
  ['dispatch_command return value was not captured; execution outcome is unknown.', '未捕获 dispatch_command 返回值；执行结果未知。'],
  ['Request was not observed; response is not assigned to another command.', '未观测到请求；此响应不会分配给其他命令。'],
]);

export function presentationNote(record) {
  const note = record.note;
  if (note) {
    if (record.real === true) {
      const key = mapperNotes.get(note);
      return key ? t(key) : note;
    }
    return Object.hasOwn(mockNoteMessages, note) ? t(note) : note;
  }
  // parseError can come from upstream metadata. Keep even familiar error text
  // verbatim; the diagnostic JSON and export also retain every original value.
  return record.metadata?.parseError || '';
}

export function processName(process) {
  if (process?.name === '未知进程' && (process.pid == null || process.pid === 0) &&
      typeof process.source === 'string' && process.source && process.id === `${process.source}:unknown`) {
    return t('未知进程');
  }
  return process?.name ?? '';
}

export function recordPlaceholderTitle(record) {
  if (record.real !== true) return Object.hasOwn(mockSummaryMessages,record.summary) ? t(record.summary) : null;
  if (record.family === 'http' && record.hasRequest === false && record.path === '(request not observed)') {
    return t('未捕获请求路径');
  }
  if (record.family !== 'raw') return null;
  if (record.operation === 'EVENT' && record.protocol === 'RAW' && record.summary === 'Captured event') {
    return t('已捕获事件');
  }
  if (['KEYLOG','PCAPNG'].includes(record.protocol) && record.metadata?.captureFormat === `CAPTURE_FORMAT_${record.protocol}` &&
      record.summary === `Captured ${record.protocol} event`) {
    return t('已捕获 {protocol} 事件',{protocol:record.protocol});
  }
  if (record.protocol === 'Redis' && record.operation === 'RESP') {
    if (record.summary === 'Redis · bounded raw value' && record.metadata?.parseError === 'RESP value exceeds display limit') return t('Redis · 超出显示上限的原始值');
    if (record.summary === 'Redis · unparsed value' && record.metadata?.parseError === 'invalid or unsupported RESP value') return t('Redis · 未解析值');
  }
  return null;
}

export function recordPlaceholderHost(record) {
  return record.real === true && record.host === 'Unknown endpoint' && record.metadata?.hostSource === 'unknown'
    ? t('未知端点') : null;
}
