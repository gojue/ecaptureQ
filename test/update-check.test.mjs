// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import {compareVersions, normalizeVersion, latestStableRelease, resolveUpdate, checkForUpdate, releasesURL} from '../frontend/update-check.js';

test('normalizeVersion strips a leading v and rejects non-semver strings', () => {
  assert.equal(normalizeVersion('v1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('1.2.3'), '1.2.3');
  assert.equal(normalizeVersion('  v1.2.3 '), '1.2.3');
  assert.equal(normalizeVersion('1.2.3-rc.1+build.5'), '1.2.3-rc.1+build.5');
  assert.equal(normalizeVersion('release-1.2.3'), null);
  assert.equal(normalizeVersion(''), null);
  assert.equal(normalizeVersion(undefined), null);
});

test('compareVersions orders releases, prereleases and build metadata', () => {
  assert.equal(compareVersions('1.0.0', '1.0.1'), -1);
  assert.equal(compareVersions('1.0.1', '1.0.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.0.0-rc.1'), 1);
  assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.2'), -1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-10'), -1);
  assert.equal(compareVersions('1.0.0-alpha', '1.0.0-2'), 1);
  assert.equal(compareVersions('1.0.0-2', '1.0.0-alpha'), -1);
  assert.equal(compareVersions('v1.1.0', '1.0.9'), 1);
  assert.equal(compareVersions('not-a-version', '1.0.0'), null);
});

test('latestStableRelease skips drafts and prereleases and picks the highest version', () => {
  const releases = [
    {tag_name: 'v1.0.0', draft: false, prerelease: false},
    {tag_name: 'v0.9.0', draft: false, prerelease: false},
    {tag_name: 'v1.1.0-rc.1', draft: false, prerelease: true},
    {tag_name: 'v1.2.0', draft: true, prerelease: false},
  ];
  assert.equal(latestStableRelease(releases).tag_name, 'v1.0.0');
  assert.equal(latestStableRelease([releases[3], releases[2], releases[1], releases[0]]).tag_name, 'v1.0.0');
  assert.equal(latestStableRelease([]), null);
  assert.equal(latestStableRelease([{draft: false, prerelease: false}]), null);
});

test('resolveUpdate returns details only when a newer stable release exists', () => {
  const releases = [
    {tag_name: 'v1.2.0', html_url: 'https://github.com/gojue/ecaptureQ/releases/tag/v1.2.0', draft: false, prerelease: false},
    {tag_name: 'v1.0.0', draft: false, prerelease: false},
  ];
  const update = resolveUpdate('1.0.0', releases);
  assert.equal(update.version, '1.2.0');
  assert.equal(update.url, 'https://github.com/gojue/ecaptureQ/releases/tag/v1.2.0');
  assert.equal(resolveUpdate('1.2.0', releases), null);
  assert.equal(resolveUpdate('1.3.0', releases), null);
  assert.equal(resolveUpdate('1.0.0', [{tag_name: 'v1.2.0', draft: false, prerelease: true}]), null);
});

test('checkForUpdate fetches the releases feed and reports newer versions', async () => {
  const releases = [{tag_name: 'v1.1.0', html_url: 'https://github.com/gojue/ecaptureQ/releases/tag/v1.1.0', draft: false, prerelease: false}];
  const update = await checkForUpdate('1.0.0', async (url, options) => {
    assert.equal(url, releasesURL);
    assert.equal(options.headers.Accept, 'application/vnd.github+json');
    return new Response(JSON.stringify(releases), {status: 200});
  });
  assert.equal(update.version, '1.1.0');
  assert.equal(await checkForUpdate('1.1.0', async () => new Response(JSON.stringify(releases), {status: 200})), null);
  assert.equal(await checkForUpdate('bad', async () => { throw new Error('unreachable'); }), null);
  await assert.rejects(checkForUpdate('1.0.0', async () => new Response('not found', {status: 404})), /responded 404/);
});
