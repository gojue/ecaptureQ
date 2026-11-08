// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {displayConnectionId} from '../frontend/connection-display.js';

const tuple = '192.0.2.10:45626--192.0.2.20:443/tcp#3557';

test('only the process prefix is removed from a known connection key', () => {
  for (const comm of ['', 'curl', 'demo-client', 'worker/child', 'worker--child/a-b']) {
    assert.equal(displayConnectionId(`42-7-${comm}/${tuple}`), tuple);
  }
  assert.equal(displayConnectionId(`0--1-decryptor/${tuple}`), tuple);
  assert.equal(displayConnectionId(`9223372036854775807--9223372036854775808-worker/${tuple}`), tuple);
});

test('IPv6 endpoints are unambiguous and preserve connection endpoint order', () => {
  assert.equal(displayConnectionId('0-0-/2001:db8::2:45626--2001:db8::1:443/tcp#3'), '[2001:db8::2]:45626--[2001:db8::1]:443/tcp#3');
  assert.equal(displayConnectionId('0-0-/::1:0--192.0.2.20:65535/udp#0'), '[::1]:0--192.0.2.20:65535/udp#0');
  assert.equal(displayConnectionId('0-0-/::ffff:c000:201:45626--2001:db8::1:443/udp#4'), '[::ffff:c000:201]:45626--[2001:db8::1]:443/udp#4');
});

test('connection generation is preserved without JavaScript number rounding', () => {
  const value = '192.0.2.10:45626--192.0.2.20:443/udp#18446744073709551615';
  assert.equal(displayConnectionId(`0-0-/${value}`), value);
  assert.notEqual(displayConnectionId(`0-0-/${tuple}`), displayConnectionId(`0-0-/${tuple.replace('#3557', '#3558')}`));
});

test('unknown, incomplete and malformed IDs are returned untouched', () => {
  for (const value of [
    undefined, null, '', 42, 'conn-01-03', 'quic-conn-01', 'quic:cid:abcdef', tuple,
    `pid-7-curl/${tuple}`, `42-fd-curl/${tuple}`, `042-7-curl/${tuple}`, `-0-7-curl/${tuple}`,
    `9223372036854775808-7-curl/${tuple}`, `42--9223372036854775809-curl/${tuple}`,
    `42-7-curl/${tuple.replace('#3557', '')}`, `42-7-curl/${tuple.replace('#3557', '#03557')}`,
    `42-7-curl/${tuple.replace('#3557', '#18446744073709551616')}`,
    `42-7-curl/${tuple.replace('/tcp', '/quic')}`, `42-7-curl/${tuple.replace('/tcp', '/TCP')}`,
    `42-7-curl/${tuple.replace('192.0.2.10', '256.0.2.10')}`,
    `42-7-curl/${tuple.replace('192.0.2.10', '192.00.2.10')}`,
    `42-7-curl/${tuple.replace('192.0.2.10', 'example.test')}`,
    `42-7-curl/${tuple.replace('45626', '65536')}`, `42-7-curl/${tuple.replace('443', '0443')}`,
    '0-0-/2001:::1:45626--2001:db8::2:443/tcp#3',
    '0-0-/fe80::1%en0:45626--2001:db8::2:443/tcp#3',
    '0-0-/[2001:db8::1]:45626--[2001:db8::2]:443/tcp#3',
    `42-7-curl\nworker/${tuple}`, `42-7-curl/${tuple}\n`,
  ]) assert.equal(displayConnectionId(value), value);
});

test('request, response and migrated QUIC messages display the same immutable UUID', () => {
  const id = '0-0-/192.0.2.10:45626--192.0.2.20:443/udp#3557';
  const request = {connectionId:id, sourceAddress:'192.0.2.10:45626', destinationAddress:'192.0.2.20:443', direction:'client_to_server', streamId:'0'};
  const response = {...request, sourceAddress:request.destinationAddress, destinationAddress:request.sourceAddress, direction:'server_to_client'};
  const migrated = {...request, sourceAddress:'198.51.100.30:45627', streamId:'4'};
  const records = [request, response, migrated], before = JSON.stringify(records);
  for (const record of records) assert.equal(displayConnectionId(record.connectionId), '192.0.2.10:45626--192.0.2.20:443/udp#3557');
  assert.equal(JSON.stringify(records), before, 'display formatting must not change export or correlation fields');
});
