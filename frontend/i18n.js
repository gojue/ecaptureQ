// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// Chinese source keys keep both languages together without touching captured data.
import { messages } from './messages.js';
export { messages };
export const languageStorageKey = 'ecaptureq-language';
// WebView exposes the system's preferred language; browsers expose their own
// language preference. Only an explicit selection is saved, so a first visit
// can follow a changed system preference on the next launch.
const systemLanguage = globalThis.navigator?.languages?.[0] || globalThis.navigator?.language || 'en';
let language = /^zh(?:-[a-z0-9]+)*$/i.test(systemLanguage) ? 'zh-CN' : 'en';
try {
  const saved = globalThis.localStorage?.getItem(languageStorageKey);
  if (saved === 'en' || saved === 'zh-CN') language = saved;
} catch { /* Storage is optional. */ }
export function getLanguage() { return language; }
export function setLanguage(value) {
  language = value === 'zh-CN' ? 'zh-CN' : 'en';
  try { globalThis.localStorage?.setItem(languageStorageKey,language); } catch { /* Storage is optional. */ }
  return language;
}
export function t(key, params = {}) {
  if (key == null) return '';
  const source = String(key);
  const message = language === 'en' ? (Object.hasOwn(messages,source) ? messages[source] : source) : source;
  // A replacement callback keeps dollars, braces and markup in values literal.
  return message.replace(/\{(\w+)\}/g,(placeholder,name) => Object.hasOwn(params,name) ? String(params[name]) : placeholder);
}
export function translateStatic(root = document) {
  root.documentElement?.setAttribute('lang',language);
  root.querySelectorAll('[data-i18n]').forEach(element => { element.textContent = t(element.dataset.i18n); });
  for (const attribute of ['aria-label','title','placeholder','content']) {
    root.querySelectorAll(`[data-i18n-${attribute}]`).forEach(element => {
      element.setAttribute(attribute,t(element.getAttribute(`data-i18n-${attribute}`)));
    });
  }
}

// Only used for application-generated error/toast messages, never capture fields.
export function sourceMessage(message) {
  const value = String(message ?? '');
  if (Object.hasOwn(messages,value)) return value;
  return Object.keys(messages).find(key => messages[key] === value) ?? value;
}
