// Copyright 2026 CFC4N. SPDX-License-Identifier: Apache-2.0
import {t,translateStatic} from './i18n.js';

translateStatic();
const form = document.querySelector('#login-form'), submit = document.querySelector('#login-submit'), error = document.querySelector('#login-error');
form.addEventListener('submit',async event => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true; error.hidden = true;
  const controller = new AbortController(), timeout = setTimeout(()=>controller.abort(),15000);
  try {
    const response = await fetch('api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Ecapture-UI':'1'},
      body:JSON.stringify({username:form.elements.username.value,password:form.elements.password.value}),signal:controller.signal,cache:'no-store'});
    if (!response.ok) throw new Error(response.status === 401 ? '用户名或密码错误。' : response.status === 429 ? '登录尝试过于频繁，请稍后重试。' : '登录服务暂不可用，请稍后重试。');
    // Confirm that the browser accepted the cookie (e.g. Secure requires HTTPS).
    const check = await fetch('api/config',{cache:'no-store',signal:controller.signal});
    if (!check.ok) throw new Error('登录会话未建立，请检查 Cookie 和 HTTPS 配置。');
    location.replace(new URL('./',location.href).href);
  } catch (cause) {
    error.textContent = t(cause.name === 'AbortError' || cause instanceof TypeError ? '登录服务暂不可用，请稍后重试。' : cause.message);
    error.hidden = false;
    form.elements.password.value = '';
    form.elements.password.focus();
  } finally { clearTimeout(timeout); submit.disabled = false; }
});
