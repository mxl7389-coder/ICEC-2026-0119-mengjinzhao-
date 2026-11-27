'use strict';
/* 管理员后台：SSE 实时日志 + 系统健康 + 日志分析 + 账号权限 + 数据 + 备份导出 + 版本规划
   v6 · 按 SRS 2.4 / 3.6 重构信息架构，所有数值来自真实接口 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const S = {
  user: null, rows: [], agg: null, allDays: [], users: [], overview: null,
  cursor: 0, paused: false, live: false, pollTimer: null, es: null,
  stats: { total: 0, errors: 0 },
  dayRows: [], selectedDay: '',
  feedback: [], audit: [], backup: null,
};
const TITLES = {
  live: ['实时运行日志', '服务端每次调用自动写入的脱敏记录，通过 SSE 实时推送', '运行监控'],
  health: ['系统健康', 'CM-FR-509 健康检查清单与实时资源占用', '运行监控'],
  analytics: ['日志分析', '按模块、动作、错误码、角色、自然日聚合，驱动真实迭代', '运行监控'],
  users: ['账号与角色', '所有账号由使用者创建，系统不预置任何账号', '系统管理'],
  data: ['数据总览', '条数、服务信息与脱敏业务审计记录', '系统管理'],
  feedback: ['反馈收集', '8 位真实使用者的反馈与收集进度', '系统管理'],
  backup: ['备份与导出', '日志导出、业务快照 SHA256 校验与按需恢复', '系统管理'],
  about: ['版本与规划', '真实 Git 迭代记录与 SRS 管理员职责对照', '版本'],
};

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let data = {};
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401) { window.location.href = '/admin/login.html'; throw new Error('登录已失效'); }
  if (res.status === 403) { window.location.href = '/admin/login.html'; throw new Error('需要管理员权限'); }
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
function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (err) { toast(err.message || '操作失败', true); console.error(err); }
  };
}
function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
function feats(meta) {
  return Object.entries(meta || {})
    .filter(([, v]) => typeof v === 'number' || typeof v === 'boolean')
    .slice(0, 3).map(([k, v]) => k + '=' + v).join(' · ') || '';
}
function pct(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function durationText(s) {
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor(s % 3600 / 60) + ' 分';
  return Math.floor(s / 86400) + ' 天 ' + Math.floor(s % 86400 / 3600) + ' 小时';
}

/* ------------------------------ 实时控制台 ------------------------------ */
function rowHtml(r, fresh) {
  const detail = [r.error_code, feats(r.meta)].filter(Boolean).join(' · ') || '—';
  return '<div class="log-line ' + (r.status === 'error' ? 'error ' : '') + (fresh ? 'fresh' : '') + '">' +
    '<span class="log-time">' + esc(fmtTime(r.ts)) + '</span>' +
    '<span class="log-role">' + esc(r.role || '-') + '</span>' +
    '<span class="log-mod">' + esc(r.module) + '</span>' +
    '<span class="log-act">' + esc(r.action) + '</span>' +
    '<span class="log-status ' + r.status + '">' + esc(r.status) + '</span>' +
    '<span class="log-dur">' + r.duration_ms + 'ms</span>' +
    '<span class="log-err">' + esc(detail) + '</span></div>';
}
function renderRows() {
  const mod = $('#filter-module').value;
  const status = $('#filter-status').value;
  const text = $('#filter-text').value.trim().toLowerCase();
  const rows = S.rows.filter((r) => {
    if (mod && r.module !== mod) return false;
    if (status && r.status !== status) return false;
    if (text && !(r.action + ' ' + r.module + ' ' + (r.error_code || '')).toLowerCase().includes(text)) return false;
    return true;
  }).slice(0, 300);
  $('#log-rows').innerHTML = rows.length
    ? rows.map((r, i) => rowHtml(r, i === 0 && S.live)).join('')
    : '<div class="admin-empty">当前筛选条件下暂无日志记录。任意一次页面访问或接口调用，新记录都会即时出现在这里。</div>';
  $('#row-count').textContent = rows.length;
}
function fillModuleFilter() {
  const sel = $('#filter-module'), prev = sel.value;
  const mods = Object.keys(S.agg ? S.agg.by_module : {}).sort();
  S.rows.forEach((r) => { if (!mods.includes(r.module)) mods.push(r.module); });
  sel.innerHTML = '<option value="">全部模块</option>' + mods.map((m) =>
    '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
  if (mods.includes(prev)) sel.value = prev;
}
function updateKpis() {
  const durations = S.rows.map((r) => r.duration_ms).sort((a, b) => a - b);
  const avg = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0;
  const a = S.agg || { by_status: {} };
  $('#kpi-calls').textContent = S.stats.total;
  $('#kpi-calls-foot').textContent = '覆盖 ' + (S.allDays.length || a.days_with_data || 0) + ' 个自然日 · 实时累加';
  $('#kpi-avg').innerHTML = avg.toFixed(2) + '<small style="font-size:14px;color:var(--muted)"> ms</small>';
  $('#kpi-avg-foot').textContent = '当前窗口 P95 ' + pct(durations, .95).toFixed(2) + ' ms · 峰值 ' + (durations.length ? durations[durations.length - 1] : 0).toFixed(2) + ' ms';
  $('#kpi-errors').textContent = S.stats.errors;
  $('#kpi-errors-foot').textContent = '成功率 ' + (S.stats.total ? Math.round((1 - S.stats.errors / S.stats.total) * 100) : 100) + '%';
  $('#kpi-days').textContent = S.allDays.length;
  $('#kpi-days-foot').textContent = S.allDays.length ? S.allDays[0] + ' 起 · process_logs/' : 'process_logs/ 按自然日分文件';
  $('#side-logdays').textContent = S.allDays.length;
}
function addRow(r, fresh) {
  S.rows.unshift(r);
  if (S.rows.length > 300) S.rows.length = 300;
  S.stats.total += 1;
  if (r.status === 'error') S.stats.errors += 1;
  if (S.agg) {
    S.agg.by_module[r.module] = (S.agg.by_module[r.module] || 0) + 1;
    S.agg.by_status[r.status] = (S.agg.by_status[r.status] || 0) + 1;
    S.agg.by_action[r.action] = (S.agg.by_action[r.action] || 0) + 1;
    const rk = r.role || 'anonymous';
    S.agg.by_role = S.agg.by_role || {};
    S.agg.by_role[rk] = (S.agg.by_role[rk] || 0) + 1;
    if (r.status === 'error') {
      const c = r.error_code || 'UNKNOWN';
      S.agg.by_error_code[c] = (S.agg.by_error_code[c] || 0) + 1;
    }
  }
  if (!S.paused) { renderRows(); updateKpis(); }
}
function setLive(ok, label) {
  S.live = ok;
  const pill = $('#live-pill'), cpill = $('#console-pill');
  pill.className = 'live-pill' + (ok ? '' : ' off');
  cpill.className = 'live-pill' + (ok ? '' : ' off');
  $('#live-text').textContent = ok ? '实时连接' : (label || '轮询补齐');
  $('#side-stream').textContent = ok ? 'SSE 实时流已连接' : (label || 'SSE 断开，轮询补齐中');
  $('#stream-status').textContent = ok
    ? 'SSE 长连接已建立 · 服务端落盘即推送 · 断线自动重连'
    : 'SSE 暂不可用，已切换 2 秒轮询补齐（游标 ' + S.cursor + '）';
}
function startPoll() {
  if (S.pollTimer) return;
  setLive(false);
  S.pollTimer = setInterval(async () => {
    try {
      const r = await api('admin/poll?cursor=' + S.cursor);
      S.cursor = r.cursor;
      if (r.rows && r.rows.length) {
        r.rows.reverse().forEach((x) => addRow(x, false));
        fillModuleFilter();
      }
      $('#stream-status').textContent = 'SSE 暂不可用，已切换 2 秒轮询补齐（游标 ' + S.cursor + '）';
    } catch (_) {}
  }, 2000);
}
function stopPoll() { if (S.pollTimer) { clearInterval(S.pollTimer); S.pollTimer = null; } }
function connectStream() {
  const es = new EventSource('/api/admin/stream');
  S.es = es;
  es.addEventListener('open', () => { stopPoll(); setLive(true); });
  es.addEventListener('snapshot', (e) => {
    const snap = JSON.parse(e.data);
    S.rows = (snap.recent || []).slice(0, 300);
    S.cursor = snap.cursor || 0;
    S.agg = snap.aggregate || { by_module: {}, by_status: {}, by_error_code: {}, by_action: {}, by_role: {}, errors: [] };
    S.allDays = S.agg.window || [];
    S.stats.total = S.agg.total_calls || 0;
    S.stats.errors = S.agg.by_status.error || 0;
    $('#side-version').textContent = String(snap.version || '').replace(/^v/, '');
    fillModuleFilter(); renderRows(); updateKpis();
    $('#stream-status').textContent = 'SSE 长连接已建立 · 已载入最近 ' + S.rows.length + ' 条 · 服务端落盘即推送';
  });
  es.addEventListener('log', (e) => { addRow(JSON.parse(e.data), true); fillModuleFilter(); });
  es.addEventListener('error', () => startPoll());
  es.onerror = () => startPoll();
}

/* ------------------------------ 系统健康 ------------------------------ */
function renderHealth() {
  const o = S.overview; if (!o) return;
  const checks = o.checks || [];
  const okCount = checks.filter((c) => c.ok).length;
  $('#health-summary').textContent = okCount + ' / ' + checks.length + ' 项通过';
  $('#health-summary').className = 'chip ' + (okCount === checks.length ? 'good' : 'warn');
  $('#health-checks').innerHTML = '<div class="check-list">' + checks.map((c) =>
    '<div class="check-row"><span class="check-mark ' + (c.ok ? 'ok' : 'warn') + '">' + (c.ok ? '✓' : '!') + '</span>' +
    '<div class="check-body"><b>' + esc(c.label) + '</b><span>' + esc(c.detail) + '</span></div>' +
    '<span class="tag ' + (c.ok ? 'tag-ok' : 'tag-warn') + '">' + (c.ok ? '通过' : '待达成') + '</span></div>').join('') + '</div>';

  const r = o.resources || {};
  $('#health-resources').innerHTML = '<div class="table-wrap"><table class="table"><tbody>' +
    '<tr><td>运行平台</td><td>' + esc(r.platform || '—') + '</td></tr>' +
    '<tr><td>常驻内存 RSS</td><td class="num">' + (r.rss_mb ?? '—') + ' MB</td></tr>' +
    '<tr><td>堆内存已用 / 总量</td><td class="num">' + (r.heap_used_mb ?? '—') + ' / ' + (r.heap_total_mb ?? '—') + ' MB</td></tr>' +
    '<tr><td>外部内存</td><td class="num">' + (r.external_mb ?? '—') + ' MB</td></tr>' +
    '<tr><td>进程运行时长</td><td>' + esc(durationText(r.uptime_s || 0)) + '</td></tr>' +
    '<tr><td>数据目录</td><td><code>' + esc(r.data_dir || 'data') + '</code></td></tr>' +
    '</tbody></table></div>';
  const h = o.health || {};
  $('#health-meta').innerHTML = '<div class="table-wrap"><table class="table"><tbody>' +
    '<tr><td>服务</td><td>' + esc(h.app || '—') + '</td></tr>' +
    '<tr><td>版本 / Node</td><td>' + esc(h.version || '—') + ' / ' + esc(h.node || '—') + '</td></tr>' +
    '<tr><td>今天</td><td>' + esc(h.today || '—') + '</td></tr>' +
    '<tr><td>日志文件</td><td>' + (h.log_days ?? 0) + ' 天</td></tr>' +
    '<tr><td>账号初始化</td><td>' + (h.initialized ? '已完成' : '未初始化') + '</td></tr>' +
    '<tr><td>实时通道</td><td>' + esc((checks.find((c) => c.key === 'stream') || {}).detail || '—') + '</td></tr>' +
    '</tbody></table></div>';
}

/* ------------------------------ 日志分析 ------------------------------ */
function statCard(color, iconBg, label, num, suffix, foot) {
  return '<div class="stat-card" style="--bar:' + color + ';--icon-bg:' + iconBg + '">' +
    '<div class="stat-top"><span>' + label + '</span></div>' +
    '<div class="stat-num">' + num + (suffix ? '<small> ' + suffix + '</small>' : '') + '</div>' +
    '<div class="stat-foot">' + foot + '</div></div>';
}
function barList(target, entries, emptyText, nameWidth) {
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $(target).innerHTML = entries.length ? entries.map(([k, v]) =>
    '<div class="bar-row"><span class="bar-name" ' + (nameWidth ? 'style="width:' + nameWidth + 'px"' : '') + '>' + esc(k) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + (v / max * 100) + '%"></span></span>' +
    '<span class="bar-val">' + v + '</span></div>').join('')
    : '<div class="table-empty">' + emptyText + '</div>';
}
const ROLE_LABEL = { student: '学生', teacher: '教师', admin: '管理员', anonymous: '未登录' };
function renderAnalytics() {
  const a = S.agg; if (!a) return;
  $('#analytics-stats').innerHTML = [
    statCard('#2563d9', '#eaf1ff', '近 7 天调用', S.stats.total, '次', '覆盖 ' + S.allDays.length + ' 个自然日'),
    statCard('#0d9488', '#e2f6f2', '平均耗时', a.avg_duration_ms, 'ms', 'P95 ' + a.p95_duration_ms + 'ms / 峰值 ' + a.max_duration_ms + 'ms'),
    statCard('#d94a4a', '#fdecec', '报错次数', S.stats.errors, '次', '成功率 ' + (S.stats.total ? Math.round((1 - S.stats.errors / S.stats.total) * 100) : 100) + '%'),
    statCard('#e08a12', '#fff3dc', '日志文件', S.allDays.length, '天', '按自然日写入 process_logs/'),
  ].join('');
  barList('#module-bars', Object.entries(a.by_module || {}).sort((x, y) => y[1] - x[1]).slice(0, 10), '暂无调用数据');
  barList('#action-bars', Object.entries(a.by_action || {}).sort((x, y) => y[1] - x[1]).slice(0, 10), '暂无动作数据', 96);
  barList('#role-calls', Object.entries(a.by_role || {}).map(([k, v]) => [ROLE_LABEL[k] || k, v]).sort((x, y) => y[1] - x[1]), '暂无角色数据', 72);
  $('#error-count').textContent = S.stats.errors + ' 次';
  barList('#error-codes', Object.entries(a.by_error_code || {}).sort((x, y) => y[1] - x[1]), '窗口内无报错 ✓', 112);
  const errs = (a.errors || []).slice().reverse().slice(0, 8);
  $('#error-list').innerHTML = errs.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>模块/动作</th><th>错误码</th></tr></thead><tbody>' +
    errs.map((e) => '<tr><td class="nowrap">' + esc(fmtTime(e.ts)) + '</td><td>' + esc(e.module + ' / ' + e.action) + '</td><td><span class="tag tag-bad">' + esc(e.error_code || '-') + '</span></td></tr>').join('') +
    '</tbody></table></div>' : '<div class="table-empty">当前窗口内没有报错 ✓</div>';

  const selected = S.selectedDay || S.allDays[S.allDays.length - 1] || '';
  $('#log-day-select').innerHTML = (S.allDays.length ? S.allDays.slice().reverse() : [selected])
    .map((d) => '<option value="' + d + '"' + (d === selected ? ' selected' : '') + '>' + d + '</option>').join('');
  $('#export-day').innerHTML = (S.allDays.length ? S.allDays.slice().reverse() : [selected])
    .map((d) => '<option value="' + d + '"' + (d === selected ? ' selected' : '') + '>' + d + '</option>').join('');
  renderDayTable();
}
function renderDayTable() {
  const rows = S.dayRows.slice(-60).reverse();
  $('#log-table').innerHTML = rows.length ? '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>时间</th><th>角色</th><th>模块</th><th>动作</th><th>状态</th><th class="num">耗时</th><th>错误码 / 特征</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td class="nowrap">' + esc(fmtTime(r.ts)) + '</td><td>' + esc(ROLE_LABEL[r.role] || r.role || '-') + '</td>' +
      '<td>' + esc(r.module) + '</td><td>' + esc(r.action) + '</td>' +
      '<td><span class="tag ' + (r.status === 'ok' ? 'tag-ok' : 'tag-bad') + '">' + r.status + '</span></td>' +
      '<td class="num">' + r.duration_ms + ' ms</td><td class="muted">' + esc(feats(r.meta) || r.error_code || '—') + '</td></tr>').join('') +
    '</tbody></table></div>' : '<div class="table-empty">该日期暂无调用记录</div>';
}

/* ------------------------------ 账号与权限 ------------------------------ */
function renderUsers() {
  $('#users-total').textContent = S.users.length + ' 个';
  $('#badge-users').textContent = S.users.length;
  if (!S.users.length) {
    $('#user-table').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-users"/></svg></div><b>还没有账号</b><span>用左侧表单创建第一个学生 / 教师账号</span></div>';
    return;
  }
  const tag = { student: 'tag-blue', teacher: 'tag-ok', admin: 'tag-gray' };
  $('#user-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>账号</th><th>显示名称</th><th>角色</th><th>状态</th><th>创建时间</th><th>最近登录</th><th class="ops">操作</th></tr></thead><tbody>' +
    S.users.map((u) => '<tr><td><b>' + esc(u.username) + '</b></td><td>' + esc(u.display_name) + '</td>' +
      '<td><span class="tag ' + (tag[u.role] || 'tag-gray') + '">' + esc(u.role_label) + '</span></td>' +
      '<td><span class="tag ' + (u.active ? 'tag-ok' : 'tag-bad') + '">' + (u.active ? '启用' : '已停用') + '</span></td>' +
      '<td class="nowrap">' + esc(String(u.created_at).slice(0, 10)) + '</td>' +
      '<td class="nowrap">' + esc(u.last_login_at ? String(u.last_login_at).slice(0, 16).replace('T', ' ') : '—') + '</td>' +
      '<td class="ops nowrap"><button class="btn btn-ghost btn-sm" data-reset="' + esc(u.id) + '">重置密码</button> ' +
      '<button class="btn ' + (u.active ? 'btn-ghost' : 'btn-soft') + ' btn-sm" data-active="' + esc(u.id) + '" data-set="' + (u.active ? '0' : '1') + '">' + (u.active ? '停用' : '启用') + '</button></td></tr>').join('') +
    '</tbody></table></div>';
}
function renderPermMatrix() {
  const rows = [
    ['录入 / 查看自己的通知与错题', true, true, true, '数据按 owner_id 隔离'],
    ['登记器材借出与归还', true, true, true, '库存由服务端校验'],
    ['提交使用反馈', true, true, true, '不代填任何评价'],
    ['查看全部通知 / 错题 / 反馈', false, true, true, '教师用于班级汇总'],
    ['新增 / 删除器材档案', false, true, true, 'CM-FR-201'],
    ['访问实时日志与管理接口', false, false, true, '服务端二次校验'],
    ['创建账号 / 停用 / 重置密码', false, false, true, '仅管理端入口'],
    ['导出脱敏运行日志', false, false, true, 'CM-FR-507'],
    ['查看反馈明细与业务审计', false, false, true, '验收 8.4 / CM-FR-210'],
    ['导出、校验并恢复数据备份', false, false, true, '需显式确认，账号会话不动'],
  ];
  const mark = (v) => v ? '<span class="tag tag-ok">允许</span>' : '<span class="tag tag-gray">—</span>';
  $('#perm-matrix').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>能力</th><th>学生</th><th>教师</th><th>管理员</th><th>说明</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td>' + esc(r[0]) + '</td><td>' + mark(r[1]) + '</td><td>' + mark(r[2]) + '</td><td>' + mark(r[3]) + '</td><td class="muted">' + esc(r[4]) + '</td></tr>').join('') +
    '</tbody></table></div><div class="admin-note">矩阵与 <code>lib/api.js</code> 的 PERMISSIONS 配置一致；管理员为通配权限，但同样受入口 portal 约束。</div>';
}

/* ------------------------------ 反馈收集 / 业务审计 ------------------------------ */
async function refreshFeedback() {
  const r = await api('admin/feedback');
  S.feedback = r.items || [];
  renderFeedback();
}
function renderFeedback() {
  const items = S.feedback || [], n = items.length;
  $('#fb-kpi').textContent = n;
  $('#badge-feedback').textContent = n;
  $('#fb-score-avg').textContent = n
    ? (items.reduce((s, f) => s + (Number(f.score) || 0), 0) / n).toFixed(1) : '—';
  $('#fb-reuse-count').textContent = items.filter((f) => f.reuse === '愿意').length;
  $('#fb-problem-count').textContent = items.filter((f) => String(f.problem || '').trim()).length;
  $('#fb-progress-chip').textContent = n + ' / 8';
  $('#fb-progress-fill').style.width = Math.min(100, n / 8 * 100) + '%';
  $('#fb-slots').innerHTML = Array.from({ length: 8 }, (_, i) =>
    '<span class="fb-slot' + (i < n ? ' on' : '') + '">' +
    (i < n ? '✓' : String(i + 1).padStart(2, '0')) + '</span>').join('');
  if (!n) {
    $('#fb-table').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-heart"/></svg></div>' +
      '<b>还没有收到反馈</b><span>让同学从用户端「使用反馈」实际试用后自行填写；系统不会代填</span></div>';
    return;
  }
  $('#fb-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>#</th><th>身份</th><th>模块</th><th>实际完成的任务</th><th>评分</th><th>遇到的问题</th>' +
    '<th>建议</th><th>再用意愿</th><th>时间</th></tr></thead><tbody>' +
    items.map((f, i) => '<tr><td class="num">' + String(i + 1).padStart(2, '0') + '</td>' +
      '<td>' + esc(f.role) + '</td><td>' + esc(f.module) + '</td>' +
      '<td>' + esc(f.task_done || '—') + '</td><td class="num">' + (f.score || '—') + '</td>' +
      '<td>' + esc(f.problem || '—') + '</td><td>' + esc(f.suggestion || '—') + '</td>' +
      '<td>' + esc(f.reuse || '—') + '</td>' +
      '<td class="nowrap">' + esc(String(f.created_at).slice(0, 16).replace('T', ' ')) + '</td></tr>').join('') +
    '</tbody></table></div>';
}
async function refreshAudit() {
  const r = await api('admin/audit');
  S.audit = r.items || [];
  renderAudit();
}
function renderAudit() {
  const rows = S.audit || [];
  $('#audit-count').textContent = rows.length + ' 条';
  if (!rows.length) {
    $('#audit-table').innerHTML = '<div class="table-empty"><b>暂无审计记录</b><br>任意一次业务写操作（保存通知、借还、归档、反馈等）都会自动留痕</div>';
    return;
  }
  $('#audit-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>时间</th><th>角色</th><th>动作</th><th>对象类型</th><th>对象 ID</th></tr></thead><tbody>' +
    rows.map((r) => '<tr><td class="nowrap">' + esc(String(r.at).slice(0, 19).replace('T', ' ')) + '</td>' +
      '<td><span class="tag tag-gray">' + esc(ROLE_LABEL[r.actor_role] || r.actor_role || '—') + '</span></td>' +
      '<td><code>' + esc(r.action) + '</code></td><td>' + esc(r.target_type) + '</td>' +
      '<td class="muted">' + esc(r.target_id || '—') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

/* ------------------------------ 数据与备份 ------------------------------ */
const DATA_LABEL = {
  notices: '通知 / 待办', equipment: '器材清单', loans: '借还流水',
  mistakes: '错题', feedback: '使用反馈', users: '账号', sessions: '登录会话',
};
function renderOverview() {
  const o = S.overview; if (!o) return;
  const rows = Object.entries(o.datasets || {});
  $('#dataset-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>数据集</th><th>文件</th><th class="num">条数</th></tr></thead><tbody>' +
    rows.map(([k, v]) => '<tr><td><b>' + esc(DATA_LABEL[k] || k) + '</b></td><td><code>data/' + esc(k) + '.json</code></td><td class="num">' + v + '</td></tr>').join('') +
    '</tbody></table></div>';
  const businessEmpty = ['notices', 'equipment', 'loans', 'mistakes', 'feedback']
    .every((k) => (o.datasets[k] || 0) === 0);
  $('#data-zero').classList.toggle('hidden', !businessEmpty);
  $('#health-table').innerHTML = '<div class="table-wrap"><table class="table"><tbody>' +
    '<tr><td>服务</td><td>' + esc(o.health.app) + '</td></tr>' +
    '<tr><td>版本 / Node</td><td>' + esc(o.health.version) + ' / ' + esc(o.health.node) + '</td></tr>' +
    '<tr><td>已运行</td><td>' + esc(durationText(o.health.uptime_s)) + '</td></tr>' +
    '<tr><td>日志文件</td><td>' + o.health.log_days + ' 天</td></tr>' +
    '<tr><td>今天</td><td>' + esc(o.health.today) + '</td></tr>' +
    '</tbody></table></div>';
  const roles = Object.entries(o.users_by_role || {});
  barList('#role-bars', roles.map(([k, v]) => [ROLE_LABEL[k] || k, v]), '暂无账号', 72);

  $('#backup-datasets').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr><th>文件</th><th class="num">条数</th></tr></thead><tbody>' +
    rows.map(([k, v]) => '<tr><td><code>data/' + esc(k) + '.json</code></td><td class="num">' + v + '</td></tr>').join('') +
    '</tbody></table></div>';
  const files = o.report_files || [];
  $('#backup-files').innerHTML = files.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>日报文件</th><th class="num">大小</th></tr></thead><tbody>' +
    files.map((f) => '<tr><td><code>process_logs/' + esc(f.file) + '</code></td><td class="num">' + f.size_kb + ' KB</td></tr>').join('') +
    '</tbody></table></div>' : '<div class="table-empty"><b>还没有生成日报</b><br>点击右上角「生成当日日报」，或运行 node scripts/daily-report.js --sync</div>';
  // 直接从侧栏进入「备份与导出」时，日期下拉也要有值（不依赖先进日志分析页）
  const latest = S.allDays[S.allDays.length - 1] || o.health.today;
  const chosen = S.selectedDay || latest;
  $('#export-day').innerHTML = (S.allDays.length ? S.allDays.slice().reverse() : [chosen])
    .map((d) => '<option value="' + d + '"' + (d === chosen ? ' selected' : '') + '>' + d + '</option>').join('');
  $('#version-current').textContent = o.health.version || '—';
  renderVersionTimeline();
}
function renderVersionTimeline() {
  const list = (S.overview && S.overview.git_commits) || [];
  $('#version-timeline').innerHTML = list.length
    ? '<div class="timeline">' + list.map((c, i) =>
      '<div class="tl-row"><span class="tl-dot' + (i === 0 ? ' latest' : '') + '"></span>' +
      '<span class="tl-date">' + esc(c.date) + '</span>' +
      '<code class="tl-hash">' + esc(c.hash) + '</code>' +
      '<span class="tl-text">' + esc(c.subject) + '</span></div>').join('') + '</div>' +
      '<div class="admin-note">以上由 <code>git log</code> 实时读取，未做任何补写。验收要求的「3 次基于日志的迭代」为 v2 / v3 / v4.0.1，依据与前后对比见 README。</div>'
    : '<div class="table-empty">当前目录不是 Git 仓库或无法读取提交记录，请用 <code>git log --oneline</code> 查看</div>';
}

/* ------------------------------ 加载与切换 ------------------------------ */
async function refreshSummary() {
  const r = await api('admin/summary?days=7');
  S.agg = r; S.allDays = r.all_days || [];
  S.stats.total = Math.max(S.stats.total, r.total_calls);
  S.stats.errors = Math.max(S.stats.errors, r.by_status.error || 0);
  fillModuleFilter(); updateKpis(); renderAnalytics();
}
async function refreshUsers() { const r = await api('admin/users'); S.users = r.items; renderUsers(); }
async function refreshOverview() {
  S.overview = await api('admin/overview');
  renderOverview(); renderHealth(); renderPermMatrix();
  try { await refreshAudit(); } catch (_) {}
}
async function refreshDay(date) {
  S.selectedDay = date;
  const r = await api('admin/day?date=' + encodeURIComponent(date));
  S.dayRows = r.rows; renderDayTable();
}
function switchView(name) {
  if (!TITLES[name]) return;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $('#page-title').textContent = TITLES[name][0];
  $('#page-sub').textContent = TITLES[name][1];
  $('#crumb-group').textContent = TITLES[name][2];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (name === 'analytics') guard(refreshSummary)();
  if (name === 'users') guard(refreshUsers)();
  if (name === 'feedback') guard(refreshFeedback)();
  if (name === 'data' || name === 'backup' || name === 'health' || name === 'about') guard(refreshOverview)();
}
function setVerifyBox(title, detail, ok) {
  const el = $('#backup-verify');
  el.className = 'verify-box' + (ok === null ? '' : (ok ? ' ok' : ' bad'));
  el.innerHTML = '<b>' + esc(title) + '</b>' + detail;
}
function exportLogs(format) {
  const day = $('#export-day').value || S.selectedDay || S.allDays[S.allDays.length - 1] || '';
  if (!day) { toast('暂无可导出的日志日期', true); return; }
  window.location.href = '/api/admin/export?date=' + encodeURIComponent(day) + '&format=' + format;
  toast('正在导出 ' + day + ' 的 ' + format.toUpperCase() + ' 日志');
}
function generateDailyReport() {
  return guard(async () => {
    const r = await api('admin/report', { method: 'POST', body: {} });
    toast(r.ok ? '当日日报已生成到 process_logs/' : '生成失败');
    await refreshOverview();
  })();
}

function bindEvents() {
  $('#nav').addEventListener('click', (e) => {
    const b = e.target.closest('button.nav-item'); if (b) switchView(b.dataset.view);
  });
  $('#user-chip').addEventListener('click', (e) => {
    if (!e.target.closest('.menu-item')) $('#user-menu').classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#user-chip')) $('#user-menu').classList.remove('open');
  });
  $('#btn-logout').addEventListener('click', guard(async () => {
    await api('auth/logout', { method: 'POST', body: {} });
    window.location.href = '/admin/login.html';
  }));

  ['#filter-module', '#filter-status'].forEach((s) => $(s).addEventListener('change', renderRows));
  $('#filter-text').addEventListener('input', renderRows);
  $('#btn-pause').addEventListener('click', () => {
    S.paused = !S.paused;
    $('#btn-pause').classList.toggle('on', S.paused);
    $('#btn-pause').textContent = S.paused ? '继续刷新' : '暂停刷新';
    if (!S.paused) { renderRows(); updateKpis(); }
  });
  $('#btn-clear').addEventListener('click', () => { S.rows = []; renderRows(); });
  $('#btn-live-export').addEventListener('click', () => switchView('backup'));

  $('#log-day-select').addEventListener('change', guard(async (e) => refreshDay(e.target.value)));
  $('#btn-report').addEventListener('click', generateDailyReport);
  $('#btn-report-2').addEventListener('click', generateDailyReport);
  $('#health-refresh').addEventListener('click', guard(async () => { await refreshOverview(); toast('已重新检查'); }));
  $('#btn-export-json').addEventListener('click', () => exportLogs('json'));
  $('#btn-export-csv').addEventListener('click', () => exportLogs('csv'));

  /* 业务数据备份：导出 → 校验 → 显式确认后恢复 */
  $('#btn-backup-export').addEventListener('click', () => {
    window.location.href = '/api/admin/backup';
    toast('正在导出业务数据快照（含 SHA256 校验值）');
  });
  $('#backup-file').addEventListener('change', guard(async (e) => {
    const f = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!f) return;
    if (f.size > 20 * 1024 * 1024) {
      setVerifyBox('文件过大', '超过 20 MB，已拒绝解析。', false);
      S.backup = null; $('#btn-backup-restore').classList.add('hidden'); return;
    }
    let obj;
    try { obj = JSON.parse(await f.text()); }
    catch (err) {
      setVerifyBox('无法解析备份文件', esc(err.message), false);
      S.backup = null; $('#btn-backup-restore').classList.add('hidden'); return;
    }
    S.backup = obj;
    try {
      const r = await api('admin/backup/verify', { method: 'POST', body: { backup: obj } });
      if (r.ok) {
        const counts = Object.entries(r.datasets || {}).map(([k, v]) => k + ':' + v).join(' · ');
        setVerifyBox('校验通过 · 可以恢复',
          'SHA256 匹配，导出于 ' + esc(r.exported_at || '—') + '。<br><code>' +
          esc(r.computed_checksum) + '</code><br>数据集条数：' + esc(counts), true);
        $('#btn-backup-restore').classList.remove('hidden');
      } else {
        setVerifyBox('校验未通过 · 已禁止恢复', esc((r.problems || []).join('；')), false);
        $('#btn-backup-restore').classList.add('hidden');
      }
    } catch (err) {
      setVerifyBox('校验请求失败', esc(err.message), false);
      $('#btn-backup-restore').classList.add('hidden');
    }
    $('#backup-confirm').checked = false;
  }));
  $('#btn-backup-restore').addEventListener('click', guard(async () => {
    if (!$('#backup-confirm').checked) { toast('请先勾选恢复确认', true); return; }
    if (!S.backup) { toast('请先选择并校验一份备份文件', true); return; }
    const r = await api('admin/backup/restore', {
      method: 'POST', body: { backup: S.backup, confirm: 'RESTORE' },
    });
    toast('业务数据已恢复');
    setVerifyBox('恢复完成', esc(r.note || ''), true);
    $('#btn-backup-restore').classList.add('hidden');
    $('#backup-confirm').checked = false;
    await refreshOverview();
  }));
  $('#fb-refresh').addEventListener('click', guard(async () => {
    await refreshFeedback(); toast('反馈已刷新');
  }));

  $('#form-user').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('admin/users', { method: 'POST', body: {
      username: $('#us-username').value.trim(), display_name: $('#us-name').value.trim(),
      role: $('#us-role').value, password: $('#us-pass').value,
    } });
    ['#us-username', '#us-name', '#us-pass'].forEach((s) => { $(s).value = ''; });
    toast('账号已创建'); refreshUsers(); refreshOverview();
  }));
  $('#user-table').addEventListener('click', guard(async (e) => {
    const reset = e.target.closest('[data-reset]'), active = e.target.closest('[data-active]');
    if (reset) {
      const pwd = window.prompt('为账号设置新密码（至少 8 位，含字母与数字）：');
      if (!pwd) return;
      await api('admin/password', { method: 'POST', body: { id: reset.dataset.reset, new_password: pwd } });
      toast('密码已重置，该账号其它会话已失效');
    } else if (active) {
      const set = active.dataset.set === '1';
      if (!set && !window.confirm('停用后该账号将无法登录，确定继续？')) return;
      await api('admin/active', { method: 'POST', body: { id: active.dataset.active, active: set } });
      toast(set ? '账号已启用' : '账号已停用'); refreshUsers(); refreshOverview();
    }
  }));
}

(async function init() {
  try {
    const me = await api('auth/me');
    if (me.user.role !== 'admin') { window.location.href = '/admin/login.html'; return; }
    S.user = me.user;
    $('#user-name').textContent = me.user.display_name || me.user.username;
    $('#user-avatar').textContent = (me.user.display_name || me.user.username).slice(0, 1);
    $('#user-role').textContent = '管理员 · ' + me.user.username;
    $('#side-version').textContent = String(me.version || '').replace(/^v/, '');
  } catch (_) { return; }
  bindEvents();
  await guard(refreshSummary)();
  await guard(refreshOverview)();
  await guard(refreshUsers)();
  await guard(refreshFeedback)();
  const day = S.allDays[S.allDays.length - 1] || (await api('health')).today;
  await guard(() => refreshDay(day))();
  connectStream();
})();
