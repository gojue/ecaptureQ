// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {formatCollectorCommand} from '../frontend/source-form.js';

test('collector argv preserves argument boundaries and literal captured text',() => {
  assert.equal(formatCollectorCommand(['/opt/ecapture','gotls','--elfpath','/opt/my app','','tcp port 443']),
    '/opt/ecapture gotls --elfpath "/opt/my app" "" "tcp port 443"');
  for (const argument of ['$(id)','`id`','"quoted"','line\nbreak','<script>alert(1)</script>','中文']) {
    assert.equal(formatCollectorCommand([argument]),JSON.stringify(argument));
  }
});

test('missing or malformed argv never invents a launch command',() => {
  for (const argv of [null,undefined,[],{},'ecapture tls',[1],['ecapture',null]]) {
    assert.equal(formatCollectorCommand(argv),'');
  }
});
