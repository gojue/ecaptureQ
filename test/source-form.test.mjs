// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {hostFromEndpoint,moduleFromCommand} from '../frontend/source-form.js';

test('capture host defaults use only the WebSocket hostname, including IPv6',() => {
  for (const [value,host] of [
    ['ws://192.0.2.20:28256/','192.0.2.20'],
    [' wss://collector.example.test/path ','collector.example.test'],
    ['wss://[2001:db8::7]:443/capture','2001:db8::7'],
    ['ws://[::1]:28256/','::1'],
    ['WS://Collector.Example.Test:80/','collector.example.test']
  ]) assert.equal(hostFromEndpoint(value),host,value);
});

test('invalid or credential-bearing endpoints do not invent host metadata',() => {
  for (const value of [null,'','host:28256','http://example.test','ws:example.test',
    'ws://user:pass@example.test/','ws://@example.test','ws://host/?','ws://host/#',
    'ws://host/?key=secret','ws://host/#fragment','ws://host:65536/','ws://host:0/',
    'ws://[invalid]/','ws://host\\path','ws://ho\nst/',`ws://${'a'.repeat(257)}/`]) {
    assert.equal(hostFromEndpoint(value),'',String(value));
  }
});

test('module detection recognizes exact official commands and aliases with common launch prefixes',() => {
  for (const [command,module] of [
    ['ecapture tls -m text --text-source pcapng','tls'],
    ['./ecapture openssl --ssl_version boringssl','tls'],
    ['sudo ./bin/ecapture gotls --elfpath /opt/app','gotls'],
    ['sudo -E -n -u root /opt/ecapture/ecapture gnutls','gnutls'],
    ['sudo --user=root -- /opt/ecapture/ecapture tlsgo','gotls'],
    ['env CAPTURE_DEMO=1 /opt/ecapture/ecapture gnu','gnutls'],
    ['sudo env -i CAPTURE_DEMO=1 "/opt/collector tools/ecapture" gotls','gotls'],
    ['CAPTURE_DEMO=1 ./ecapture tls','tls'],
    ["'./ecapture' 'gotls' --elfpath '/opt/gnu app'",'gotls'],
    ['sudo ./ecapture \\\n  gotls --elfpath /opt/app','gotls'],
    ['ecapture --logaddr gotls --debug --pid=42 tls','tls'],
    ['ecapture -p 42 --hex=false gnutls','gnutls'],
    ['ecapture tls --libssl /opt/gotls.so --pid $PID','tls']
  ]) assert.equal(moduleFromCommand(command),module,command);
});

test('module detection never scans arbitrary parameters, expands shell, or guesses ambiguous commands',() => {
  for (const command of [null,'','ecapture','ecapture go','ecapture boringssl',
    'echo "ecapture gotls"','./gotls','other tls','sh -c "ecapture tls"',
    '$ECAPTURE_BINARY gotls','$HOME/ecapture tls','ecapture --logaddr gotls',
    'ecapture --unknown gotls','ecapture --elfpath gotls','ecapture --pid --debug tls',
    'ecapture --pid= tls','sudo -x ./ecapture tls','ecapture "gotls',
    'ecapture gotls\\','ecapture tls; ecapture gotls','ecapture tls && echo gotls',
    'ecapture tls | tee output','ecapture tls > output','ecapture tls\necapture gotls',
    'ecapture tls --pid $(id)','ecapture tls --pid `id`','ecapture tls # comment',
    'ecapture\0 gotls','ecapture tls '+ 'x'.repeat(16384)]) {
    assert.equal(moduleFromCommand(command),'',String(command));
  }
});
