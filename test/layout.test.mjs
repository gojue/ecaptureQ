// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {layoutWidths, readLayoutPreferences} from '../frontend/layout.js';

test('default middle is 60% of the previous default; the sidebar is unchanged', () => {
  const normal = layoutWidths(1440, 218);
  assert.equal(normal.sidebar, 218);
  assert.ok(Math.abs(normal.list - 296.4) < 0.001); // Previously 494 px.
  assert.ok(Math.abs(normal.detail - 917.6) < 0.001);
  const wide = layoutWidths(1920, 232);
  assert.equal(wide.sidebar, 232);
  assert.equal(wide.list, 576); // Previously 960 px.
  assert.equal(wide.detail, 1104);
});

test('dragging can expand detail beyond its previous 720 px limit', () => {
  const leftmost = layoutWidths(1440, 218, 240);
  assert.equal(leftmost.list, 240);
  assert.equal(leftmost.detail, 974);
  assert.equal(layoutWidths(1440, 218, 2000).detail, 340);
});

test('narrow layouts preserve usable panes and account for the hidden sidebar', () => {
  for (const [width, sidebar, visible] of [[961,186,true], [800,186,false], [681,186,false]]) {
    const size = layoutWidths(width, sidebar, undefined, visible);
    assert.ok(size.list >= 240);
    assert.ok(size.detail >= 340);
    assert.equal(size.sidebar + size.list + size.detail + (visible ? 8 : 4), width);
    if (!visible) assert.equal(size.sidebar, 0);
  }
});

test('temporary resize constraints do not overwrite a saved user width', () => {
  const preferences = {list:500, sidebar:218};
  assert.equal(layoutWidths(800, preferences.sidebar, preferences.list, false).list, 456);
  assert.equal(layoutWidths(1440, preferences.sidebar, preferences.list).list, 500);
  assert.deepEqual(preferences, {list:500, sidebar:218});
  for (let i = 0; i < 5; i++) assert.equal(layoutWidths(1440, 218).list, 296.4);
});

test('only supported explicit dimensions are restored from optional storage', () => {
  const read = value => readLayoutPreferences({getItem:key => {
    assert.equal(key, 'ecaptureq-layout-v1');
    return value;
  }});
  assert.deepEqual(read(null), {});
  assert.deepEqual(read('{'), {});
  assert.deepEqual(read('{"sidebar":218,"list":290}'), {sidebar:218,list:290});
  assert.deepEqual(read('{"sidebar":400,"list":-20}'), {});
  assert.deepEqual(read('{"sidebar":"218","list":1e999}'), {});
  assert.deepEqual(read('{"sidebar":186,"detail":720}'), {sidebar:186});
  assert.deepEqual(readLayoutPreferences({getItem(){throw new Error('denied');}}), {});
  assert.deepEqual(readLayoutPreferences(undefined), {});
});
