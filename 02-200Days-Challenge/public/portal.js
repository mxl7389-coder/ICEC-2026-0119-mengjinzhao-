'use strict';
/**
 * 入口页共用脚本：按 body[data-portal] 分支
 *   cover → 动态封面的日期 / 时段问候 / 两端登录状态
 *   user  → 用户端登录（portal=user）
 *   admin → 管理端登录 + 首次初始化（portal=admin）
 * 依赖：无。所有请求走同源 /api/，服务端按入口二次校验角色。
 */
(function () {
  var portal = document.body.dataset.portal || 'cover';
  var isAdminPortal = portal === 'admin';
  var $ = function (sel) { return document.querySelector(sel); };

  function api(path, opts) {
    opts = opts || {};
    return fetch('/api/' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) {
          var err = new Error(data.message || '请求失败，请稍后重试');
          err.code = data.error;
          throw err;
        }
        return data;
      });
    });
  }

  function showAlert(message, kind) {
    var el = $('#portal-alert');
    if (!el) return;
    el.textContent = message;
    el.className = 'portal-alert ' + (kind || 'error');
  }
  function clearAlert() {
    var el = $('#portal-alert');
    if (el) el.className = 'portal-alert hidden';
  }
  function showBlock(name) {
    ['login', 'setup'].forEach(function (n) {
      var el = $('#' + n + '-block');
      if (el) el.classList.toggle('hidden', n !== name);
    });
    var title = $('#form-title'), sub = $('#form-sub');
    if (name === 'setup') {
      if (title) title.textContent = '创建管理员账号';
      if (sub) sub.textContent = '系统检测到还没有任何账号。此步骤只在管理端出现一次，请由你本人设置。';
    }
  }
  function busy(form, on) {
    var btn = form.querySelector('button[type="submit"]');
    if (!btn) return;
    btn.disabled = !!on;
    btn.textContent = on ? '请稍候…' : btn.dataset.label;
  }

  /* ------------------------------ 动态封面 ------------------------------ */
  function initCover() {
    var now = new Date();
    var week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()];
    var dateEl = $('#cover-date'), timeEl = $('#cover-time');
    if (dateEl) dateEl.textContent = now.getFullYear() + ' 年 ' + (now.getMonth() + 1) + ' 月 ' + now.getDate() + ' 日 · ' + week;
    if (timeEl) {
      var h = now.getHours();
      var greet = h < 6 ? '夜阑人静' : h < 11 ? '晨光初启' : h < 14 ? '日中正好'
        : h < 18 ? '午后书声' : h < 22 ? '灯下研读' : '夜阑人静';
      timeEl.textContent = greet + ' · ' + String(h).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    }

    api('auth/state').then(function (s) {
      var uState = $('#state-user'), aState = $('#state-admin');
      var uCard = $('#card-user'), aCard = $('#card-admin');
      if (!s.initialized) {
        if (aState) aState.textContent = '待创建管理员';
        if (uState) uState.textContent = '等待管理员创建账号';
        if (uCard) uCard.classList.add('is-waiting');
        var hint = $('#cover-hint');
        if (hint) hint.textContent = '首次使用：请先从管理端创建第一位管理员，再由管理员创建学生 / 教师账号。系统不预置任何数据。';
        return;
      }
      if (s.user) {
        var admin = s.user.role === 'admin';
        var el = admin ? aState : uState;
        var card = admin ? aCard : uCard;
        if (el) {
          el.textContent = '已登录 · ' + (s.user.display_name || s.user.username);
          el.classList.add('is-online');
        }
        if (card) card.classList.add('is-active');
      }
    }).catch(function () { /* 服务未启动时封面仍可正常浏览 */ });
  }

  /* ------------------------------ 两端登录 ------------------------------ */
  function initLogin() {
    var loginForm = $('#form-login');
    var setupForm = $('#form-setup');
    [loginForm, setupForm].forEach(function (f) {
      if (f) {
        var btn = f.querySelector('button[type="submit"]');
        if (btn) btn.dataset.label = btn.textContent;
      }
    });

    api('auth/state').then(function (s) {
      if (s.user) {
        var belongsHere = isAdminPortal ? s.user.role === 'admin' : s.user.role !== 'admin';
        if (belongsHere) {
          window.location.replace(isAdminPortal ? '/admin/index.html' : '/user/index.html');
          return;
        }
        showBlock('login');
        showAlert('当前登录的是「' + (s.user.role_label || s.user.role) + '」账号，与本入口不匹配。可直接使用本端账号登录，或先在原入口退出登录。', 'info');
      } else if (!s.initialized) {
        if (isAdminPortal) {
          showBlock('setup');
          showAlert('系统尚未初始化，请在此创建第一位管理员。密码以 scrypt 加盐哈希保存，明文不会写入任何文件。', 'info');
        } else {
          showBlock('login');
          showAlert('系统尚未初始化。请由管理员先在管理端完成首次设置，本入口暂不能登录。', 'info');
        }
      } else {
        showBlock('login');
      }
    }).catch(function (err) {
      showBlock(isAdminPortal ? 'login' : 'login');
      showAlert('无法连接服务：' + err.message + '。请确认 node server.js 正在运行。');
    });

    if (loginForm) {
      loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        busy(loginForm, true);
        api('auth/login', {
          method: 'POST',
          body: {
            username: $('#lg-user').value.trim(),
            password: $('#lg-pass').value,
            portal: portal,
          },
        }).then(function () {
          window.location.href = isAdminPortal ? '/admin/index.html' : '/user/index.html';
        }).catch(function (err) {
          showAlert(err.message);
          busy(loginForm, false);
        });
      });
    }

    if (setupForm) {
      setupForm.addEventListener('submit', function (e) {
        e.preventDefault();
        clearAlert();
        var pass = $('#su-pass').value, pass2 = $('#su-pass2').value;
        if (pass !== pass2) { showAlert('两次输入的密码不一致'); return; }
        busy(setupForm, true);
        api('auth/setup', {
          method: 'POST',
          body: {
            display_name: $('#su-name').value.trim(),
            username: $('#su-user').value.trim(),
            password: pass,
            portal: 'admin',
          },
        }).then(function () {
          window.location.href = '/admin/index.html';
        }).catch(function (err) {
          showAlert(err.message);
          busy(setupForm, false);
        });
      });
    }
  }

  if (portal === 'cover') initCover();
  else initLogin();
})();
