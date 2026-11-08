// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0

// Editable registration defaults only; these are not facts from capture events.
export function hostFromEndpoint(value) {
  const text = String(value ?? '').trim();
  if (text.length > 2048 || !/^wss?:\/\//i.test(text) || /[\s\\?#]/.test(text)) return '';
  if (text.slice(text.indexOf('://')+3).split('/')[0].includes('@')) return '';
  try {
    const url = new URL(text);
    if (!url.hostname || url.username || url.password || url.port === '0') return '';
    // URL.hostname retains brackets around IPv6; a host field has no port.
    const host = url.hostname.replace(/^\[|\]$/g,'');
    return host.length <= 256 ? host : '';
  } catch { return ''; }
}

// A limited shell word reader, never an evaluator. Reject compound commands and
// substitutions rather than guessing which collector would actually be invoked.
function commandWords(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 16384) return null;
  const words = [];
  let word = '', quote = '', active = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '\0') return null;
    if (quote === "'") {
      if (char === "'") quote = '';
      else word += char;
      continue;
    }
    if (char === '`' || (char === '$' && text[i+1] === '(')) return null;
    if (char === '\\') {
      const next = text[++i];
      if (next === undefined) return null;
      if (next === '\n') continue;
      if (next === '\r' && text[i+1] === '\n') { i++; continue; }
      if (quote === '"' && !['"','\\','$','`'].includes(next)) word += '\\';
      word += next; active = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = '';
      else word += char;
      continue;
    }
    if (char === '"' || char === "'") { quote = char; active = true; continue; }
    if (/[;|&<>\r\n()]/.test(char) || (char === '#' && !active)) return null;
    if (/\s/.test(char)) {
      if (active) { words.push(word); word = ''; active = false; }
    } else { word += char; active = true; }
  }
  if (quote) return null;
  if (active) words.push(word);
  return words;
}

const moduleNames = new Map([['tls','tls'],['openssl','tls'],['gotls','gotls'],['tlsgo','gotls'],['gnutls','gnutls'],['gnu','gnutls']]);
// Known upstream persistent flags only; an option value must never become a module.
const valueFlags = new Set(['--btf','-b','--mapsize','--pid','-p','--uid','-u','--logaddr','-l','--eventaddr','--ecaptureq','--listen','--tsize','-t','--eventroratesize','--eventroratetime']);
const booleanFlags = new Set(['--debug','-d','--hex']);
const assignment = word => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word || '');
const executableName = word => (word || '').split('/').pop();

export function moduleFromCommand(value) {
  const words = commandWords(value);
  if (!words) return '';
  let i = 0;
  while (assignment(words[i])) i++;
  if (executableName(words[i]) === 'sudo') {
    i++;
    while (words[i]?.startsWith('-')) {
      const option = words[i++];
      if (option === '--') break;
      if (['-E','-n','-H','--preserve-env','--non-interactive','--set-home'].includes(option)) continue;
      if (['-u','-g','--user','--group'].includes(option) && words[i]) { i++; continue; }
      if (/^--(?:user|group|preserve-env)=.+/.test(option)) continue;
      return '';
    }
    while (assignment(words[i])) i++;
  }
  if (executableName(words[i]) === 'env') {
    i++;
    if (['-i','--ignore-environment'].includes(words[i])) i++;
    if (words[i] === '--') i++;
    while (assignment(words[i])) i++;
  }
  const executable = words[i++];
  if (executableName(executable) !== 'ecapture' || /[$*?{}]/.test(executable)) return '';
  for (; i < words.length; i++) {
    const word = words[i], equals = word.indexOf('='), flag = equals < 0 ? word : word.slice(0,equals);
    if (valueFlags.has(flag)) {
      const value = equals < 0 ? words[++i] : word.slice(equals+1);
      if (!value || value.startsWith('-')) return '';
    } else if (booleanFlags.has(flag)) {
      if (equals >= 0 && !/^(?:true|false)$/.test(word.slice(equals+1))) return '';
    } else return moduleNames.get(word) || '';
  }
  return '';
}

export function initSourceMetadata(form) {
  const endpoint = form.querySelector('[name=endpoint]'), host = form.querySelector('[name=host]');
  const command = form.querySelector('[name=command]'), module = form.querySelector('[name=module]');
  let manualHost = !!host.value, manualModule = !!module.value;
  const sync = () => {
    if (!manualHost) host.value = hostFromEndpoint(endpoint.value);
    if (!manualModule) module.value = moduleFromCommand(command.value);
  };
  const changed = event => {
    if (event.target === host) manualHost = true;
    if (event.target === module) manualModule = true;
    if (event.target === endpoint || event.target === command) sync();
  };
  form.addEventListener('input',changed);
  form.addEventListener('change',changed);
  form.addEventListener('reset',() => {
    manualHost = manualModule = false;
    // The reset event runs before the browser restores each control's value.
    queueMicrotask(sync);
  });
  sync();
  return sync;
}
