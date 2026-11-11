'use strict';
/* 登录 / 首次初始化：只做身份入口，不预置任何账号或业务数据 */
const $ = (s) => document.querySelector(s);

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(data.message || data.error || '请求失败 (' + res.status + ')');
  return data;
}

let toastTimer;
function toast(msg, isError) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}
function showError(target, msg) {
  const el = $(target);
  el.textContent = msg;
  el.classList.remove('hidden');
}
function goHome(role) {
  window.location.href = role === 'admin' ? '/admin.html' : '/index.html';
}

(async function init() {
  try {
    const state = await api('auth/state');
    if (state.user) { goHome(state.user.role); return; }
    if (state.initialized) $('#login-block').classList.remove('hidden');
    else $('#setup-block').classList.remove('hidden');
  } catch (err) {
    $('#login-block').classList.remove('hidden');
    showError('#login-alert', '无法连接服务：' + err.message + '。请确认 node server.js 正在运行。');
  }
})();

$('#form-setup').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#su-name').value.trim();
  const username = $('#su-user').value.trim();
  const password = $('#su-pass').value;
  const again = $('#su-pass2').value;
  if (!name) return toast('请填写显示名称', true);
  if (password !== again) return toast('两次输入的密码不一致', true);
  try {
    const r = await api('auth/setup', { method: 'POST', body: { display_name: name, username, password } });
    toast('管理员创建成功，正在进入后台…');
    setTimeout(() => goHome(r.user.role), 350);
  } catch (err) {
    toast(err.message, true);
    showError('#setup-alert', err.message);
  }
});

$('#form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#login-alert').classList.add('hidden');
  try {
    const r = await api('auth/login', {
      method: 'POST',
      body: { username: $('#lg-user').value.trim(), password: $('#lg-pass').value },
    });
    goHome(r.user.role);
  } catch (err) { showError('#login-alert', err.message); }
});
