// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
let redirecting = false;

// Only the optional Web auth middleware emits this challenge. Native requests
// and unrelated third-party 401 responses retain their normal behavior.
export async function apiFetch(url, options, request = globalThis.fetch) {
  const response = await request(url,options);
  const location = globalThis.location;
  if (!redirecting && response.status === 401 && response.headers.get('X-Ecaptureq-Auth') === 'required' &&
      location && /^https?:$/.test(location.protocol) && new URL(url,location.href).origin === location.origin) {
    redirecting = true;
    globalThis.dispatchEvent(new Event('ecaptureq-auth-expired'));
    location.replace(new URL('login',location.href).href);
  }
  return response;
}
