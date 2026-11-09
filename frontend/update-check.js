// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
// Startup update check against the official GitHub releases feed. Only this
// fixed, trusted URL is fetched; captured URLs are never refetched.

export const releasesURL = 'https://api.github.com/repos/gojue/ecaptureQ/releases';

const semver = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function normalizeVersion(value) {
  const raw = String(value ?? '').trim().replace(/^v/i, '');
  return semver.test(raw) ? raw : null;
}

const identifiers = value => (value ? value.split('.') : []);

export function compareVersions(a, b) {
  const left = normalizeVersion(a), right = normalizeVersion(b);
  if (!left || !right) return null;
  const l = left.match(semver), r = right.match(semver);
  for (let i = 1; i <= 3; i++) {
    const diff = Number(l[i]) - Number(r[i]);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  const lp = identifiers(l[4]), rp = identifiers(r[4]);
  if (lp.length === 0 && rp.length === 0) return 0;
  if (lp.length === 0) return 1;
  if (rp.length === 0) return -1;
  const length = Math.max(lp.length, rp.length);
  for (let i = 0; i < length; i++) {
    const li = lp[i], ri = rp[i];
    if (li === undefined) return -1;
    if (ri === undefined) return 1;
    const ln = /^\d+$/.test(li), rn = /^\d+$/.test(ri);
    if (ln && rn) {
      const diff = Number(li) - Number(ri);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (ln !== rn) {
      return ln ? -1 : 1;
    } else if (li !== ri) {
      return li < ri ? -1 : 1;
    }
  }
  return 0;
}

export function latestStableRelease(releases) {
  if (!Array.isArray(releases)) return null;
  let best = null;
  for (const release of releases) {
    if (!release || release.draft || release.prerelease) continue;
    const version = normalizeVersion(release.tag_name);
    if (!version) continue;
    if (!best || compareVersions(version, best.version) > 0) best = {version, release};
  }
  return best?.release ?? null;
}

export function resolveUpdate(currentVersion, releases) {
  const current = normalizeVersion(currentVersion);
  if (!current) return null;
  const latest = latestStableRelease(releases);
  if (!latest) return null;
  const version = normalizeVersion(latest.tag_name);
  if (!version || compareVersions(version, current) <= 0) return null;
  return {
    version,
    tagName: String(latest.tag_name).trim(),
    url: typeof latest.html_url === 'string' && /^https:\/\//i.test(latest.html_url)
      ? latest.html_url
      : `https://github.com/gojue/ecaptureQ/releases/tag/${encodeURIComponent(String(latest.tag_name).trim())}`
  };
}

export async function checkForUpdate(currentVersion, request = globalThis.fetch, timeoutMs = 8000) {
  if (!normalizeVersion(currentVersion)) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await request(releasesURL, {headers: {Accept: 'application/vnd.github+json'}, signal: controller.signal});
    if (!response.ok) throw new Error(`GitHub releases responded ${response.status}`);
    return resolveUpdate(currentVersion, await response.json());
  } finally {
    clearTimeout(timer);
  }
}
