'use strict';
/* 校园事务台前端：原生 JS，无框架、无 CDN，断网也能用 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const SESSION_KEY = 'campusdesk-session';
let sessionId = localStorage.getItem(SESSION_KEY);
if (!sessionId) {
  sessionId = 's' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  localStorage.setItem(SESSION_KEY, sessionId);
}

const S = {
  view: 'dashboard', dashboard: null, notices: [], equipment: null,
  mistakes: [], feedback: [], logs: null, dayRows: [], samples: [],
  parsed: null, today: '', version: '',
};

const ICON = {
  home: '<svg><use href="#i-home"/></svg>',
  notice: '<svg><use href="#i-notice"/></svg>',
  box: '<svg><use href="#i-box"/></svg>',
  book: '<svg><use href="#i-book"/></svg>',
  chart: '<svg><use href="#i-chart"/></svg>',
  chat: '<svg><use href="#i-chat"/></svg>',
  alert: '<svg><use href="#i-alert"/></svg>',
  clock: '<svg><use href="#i-clock"/></svg>',
};
const TITLES = {
  dashboard: ['总览看板', '把通知、器材、错题三件高频小事，收进一个地方'],
  notice: ['通知提取', '把一段通知拆成可执行的待办'],
  equipment: ['器材借还核对', '借出、归还、逾期与库存差异自动对账'],
  mistake: ['错题归档', '按遗忘曲线排队复习，直到真正掌握'],
  logs: ['运行日志', '程序自动采集的调用频次、耗时与报错（已脱敏）'],
  feedback: ['使用反馈', '来自真实使用者的评价与改进建议'],
  about: ['项目说明', '对应项目四的评分要求与技术说明'],
};

async function api(path, opts = {}) {
  const res = await fetch('/api/' + path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': sessionId },
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
function guard(fn) {
  return async (...args) => {
    try { return await fn(...args); }
    catch (err) { toast(err.message || '操作失败', true); console.error(err); }
  };
}
function fmtDate(iso) { return iso ? String(iso).slice(5).replace('-', '/') : '—'; }
function fmtTime(ts) {
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
}
function lastDays(n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(); d.setDate(d.getDate() - i);
    out.push(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'));
  }
  return out;
}
function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function downloadText(filename, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------- 视图切换 ------------------------------- */
function switchView(name) {
  if (!TITLES[name]) return;
  S.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $('#page-title').textContent = TITLES[name][0];
  $('#page-sub').textContent = TITLES[name][1];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  refreshView(name);
}

async function refreshView(name) {
  try {
    if (name === 'dashboard') {
      // 总览的待办/复习列表来自业务数据，必须与看板一起刷新，否则新增后回到首页仍是旧列表
      const [d, n, m] = await Promise.all([
        api('dashboard'), api('notice/list'), api('mistake/list'),
      ]);
      S.dashboard = d; S.notices = n.items; S.mistakes = m.items;
      renderDashboard();
    } else if (name === 'notice') {
      const r = await api('notice/list'); S.notices = r.items; renderNoticeList();
    } else if (name === 'equipment') {
      S.equipment = await api('equipment/list'); renderEquipment();
    } else if (name === 'mistake') {
      const r = await api('mistake/list'); S.mistakes = r.items; renderMistakes();
    } else if (name === 'logs') {
      const [agg, day] = await Promise.all([api('logs?days=7'), api('logs/day?date=' + S.today)]);
      S.logs = agg; S.dayRows = day.rows; renderLogs();
    } else if (name === 'feedback') {
      const r = await api('feedback/list'); S.feedback = r.items; renderFeedback();
    }
  } catch (err) { toast(err.message, true); }
  refreshBadges();
}

async function refreshBadges() {
  try {
    const d = await api('dashboard');
    S.dashboard = d;
    $('#badge-notice').textContent = d.notice.pending;
    $('#badge-loan').textContent = d.equipment.overdue;
    $('#badge-mistake').textContent = d.mistake.due_today;
    $('#hero-calls').textContent = d.telemetry.total_calls;
    $('#hero-days').textContent = d.telemetry.days_with_data;
    $('#side-logdays').textContent = d.telemetry.days_with_data;
  } catch (_) {}
}

/* -------------------------------- 总览 -------------------------------- */
function statCard(color, iconBg, icon, label, num, suffix, foot) {
  return '<div class="stat-card" style="--bar:' + color + ';--icon-bg:' + iconBg + '">' +
    '<div class="stat-top"><span>' + label + '</span><span class="stat-icon">' + ICON[icon] + '</span></div>' +
    '<div class="stat-num">' + num + (suffix ? '<small> ' + suffix + '</small>' : '') + '</div>' +
    '<div class="stat-foot">' + foot + '</div></div>';
}

function renderDashboard() {
  const d = S.dashboard; if (!d) return;
  $('#today-text').textContent = d.today + ' · ' + ['周日','周一','周二','周三','周四','周五','周六'][new Date().getDay()];
  $('#hero-calls').textContent = d.telemetry.total_calls;
  $('#hero-days').textContent = d.telemetry.days_with_data;
  $('#side-logdays').textContent = d.telemetry.days_with_data;
  $('#stat-grid').innerHTML = [
    statCard('#2563d9', '#eaf1ff', 'notice', '待处理通知', d.notice.pending, '条', '其中近 3 天到期 ' + d.notice.due_soon + ' 条'),
    statCard('#d94a4a', '#fdecec', 'box', '逾期未还', d.equipment.overdue, '笔', '在借 ' + d.equipment.on_loan + ' 件 / 共 ' + d.equipment.total_units + ' 件'),
    statCard('#0d9488', '#e2f6f2', 'book', '今日待复习', d.mistake.due_today, '题', '已掌握 ' + d.mistake.mastered + ' / 归档 ' + d.mistake.total + ' 题'),
    statCard('#e08a12', '#fff3dc', 'chat', '真实反馈', d.feedback.collected, '/ 8', d.feedback.collected >= 8 ? '已达成收集目标' : '还差 ' + (8 - d.feedback.collected) + ' 位同学'),
  ].join('');

  const days = lastDays(7), byDay = d.telemetry.by_day || {};
  const vals = days.map((x) => byDay[x] || 0);
  const max = Math.max(1, ...vals);
  $('#trend-chart').innerHTML = days.map((day, i) =>
    '<div class="trend-col"><span class="trend-val">' + (vals[i] || '') + '</span>' +
    '<div class="trend-bar' + (vals[i] ? '' : ' zero') + '" style="height:' + (vals[i] ? 8 + vals[i] / max * 86 : 3) + 'px"></div>' +
    '<span class="trend-label">' + day.slice(5) + '</span></div>').join('');

  const pending = S.notices.filter((n) => !n.done).slice(0, 4);
  $('#dash-todos').innerHTML = pending.length ? pending.map((n) =>
    '<div class="mini-item"><i class="dot' + (n.deadline && n.deadline <= addDays(d.today, 2) ? ' warn' : '') + '"></i>' +
    '<span class="txt">' + esc(n.title) + '</span><span class="date">' + (n.deadline ? '截止 ' + fmtDate(n.deadline) : fmtDate(n.event_date)) + '</span></div>').join('')
    : '<div class="mini-empty">暂无待办，去「通知提取」添加一条 →</div>';

  const due = S.mistakes.filter((m) => m.due).slice(0, 4);
  $('#dash-reviews').innerHTML = due.length ? due.map((m) =>
    '<div class="mini-item"><i class="dot"></i><span class="txt">' + esc(m.title) + '</span>' +
    '<span class="date">' + esc(m.subject) + '</span></div>').join('')
    : '<div class="mini-empty">今天没有到期的复习任务 ✓</div>';
}

/* ------------------------------ 通知提取 ------------------------------ */
function renderSamples() {
  $('#sample-row').innerHTML = S.samples.map((s, i) =>
    '<button class="sample-btn" data-sample="' + i + '">示例：' + esc(s.label) + '</button>').join('');
}

function renderParseResult(n) {
  const fields = [
    ['分类', n.category, true],
    ['日期', n.event_date ? n.event_date + (n.event_time ? ' ' + n.event_time + (n.event_end_time ? '–' + n.event_end_time : '') : '') : '未识别'],
    ['地点', n.location || '未识别'],
    ['面向对象', (n.audience || []).join('、') || '未指定'],
    ['截止日期', n.deadline || '无'],
    ['置信度', n.confidence + '%（命中 ' + n.hit_rules + '/8 项规则）'],
  ];
  let html = '<div class="result-head"><div><h4>' + esc(n.title) + '</h4>' +
    '<div class="muted">共识别 ' + n.date_candidates.length + ' 个日期、' + n.locations.length + ' 处地点，耗时 ' + n.parse_ms + 'ms</div>' +
    '<div class="conf-track"><div class="conf-fill" style="width:' + n.confidence + '%"></div></div></div>' +
    '<span class="tag ' + (n.confidence >= 75 ? 'tag-ok' : 'tag-warn') + '">' + (n.confidence >= 75 ? '解析良好' : '建议复核') + '</span></div>';
  html += '<div class="field-grid">' + fields.map(([k, v, em]) =>
    '<div class="field"><label>' + k + '</label><strong class="' + (em ? 'em' : '') + '">' + esc(v) + '</strong></div>').join('') + '</div>';
  if ((n.tags || []).length) html += '<div class="tag-row">' + n.tags.map((t) => '<span class="tag tag-blue">' + esc(t) + '</span>').join('') + '</div>';
  html += '<div class="result-sub">自动生成的待办</div>' + n.todos.map((t, i) =>
    '<div class="todo-item"><i>' + (i + 1) + '</i><span>' + esc(t) + '</span></div>').join('');
  if (n.warnings.length) html += '<div class="warn-list">' + n.warnings.map((w) => '<div>· ' + esc(w) + '</div>').join('') + '</div>';
  html += '<div class="result-actions">' +
    '<button class="btn btn-primary" id="btn-save-notice"><svg><use href="#i-plus"/></svg>保存到待办</button>' +
    '<button class="btn btn-ghost" id="btn-ics-preview"><svg><use href="#i-download"/></svg>导出日历 .ics</button>' +
    '<button class="btn btn-ghost" id="btn-copy-md">复制为 Markdown</button></div>';
  $('#parse-result').innerHTML = html;
  $('#parse-conf').textContent = '置信度 ' + n.confidence + '%';
  $('#parse-conf').className = 'chip ' + (n.confidence >= 75 ? 'good' : 'warn');
}

function renderNoticeList() {
  $('#notice-total').textContent = S.notices.length + ' 条';
  if (!S.notices.length) {
    $('#notice-list').innerHTML = '<div class="table-empty">还没有保存的通知，先在上方解析一条吧</div>';
    return;
  }
  $('#notice-list').innerHTML = S.notices.map((n) =>
    '<div class="notice-item ' + (n.done ? 'done' : '') + '">' +
    '<div class="notice-check ' + (n.done ? 'on' : '') + '" data-toggle="' + esc(n.id) + '">' + (n.done ? '<svg><use href="#i-check"/></svg>' : '') + '</div>' +
    '<div class="notice-body"><div class="notice-title">' + esc(n.title) + '</div>' +
    '<div class="notice-meta"><span class="tag tag-blue">' + esc(n.category) + '</span>' +
    (n.event_date ? '<span><b>时间</b> ' + esc(n.event_date + (n.event_time ? ' ' + n.event_time : '')) + '</span>' : '') +
    (n.location ? '<span><b>地点</b> ' + esc(n.location) + '</span>' : '') +
    (n.deadline ? '<span><b>截止</b> ' + esc(n.deadline) + '</span>' : '') +
    '<span>提取于 ' + esc(String(n.created_at).slice(0, 10)) + '</span></div>' +
    '<ul class="notice-todos">' + (n.todos || []).map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></div>' +
    '<div class="notice-ops"><a class="btn btn-ghost btn-sm" href="/api/notice/ics?id=' + encodeURIComponent(n.id) + '" download>日历</a>' +
    '<button class="btn btn-ghost btn-sm" data-del-notice="' + esc(n.id) + '">删除</button></div></div>').join('');
}

/* ------------------------------ 器材借还 ------------------------------ */
function renderEquipment() {
  const e = S.equipment; if (!e) return;
  const issue = e.overdue_count > 0 || e.discrepancy_count > 0;
  $('#recon-bar').className = 'recon-bar' + (issue ? ' has-issue' : '');
  $('#recon-bar').innerHTML = ICON[issue ? 'alert' : 'box'] +
    '<span>库存核对：<b>' + e.total_kinds + '</b> 类器材 / 共 <b>' + e.total_units + '</b> 件，当前在借 <b>' + e.on_loan_units + '</b> 件，' +
    '逾期 <b>' + e.overdue_count + '</b> 笔，库存差异 <b>' + e.discrepancy_count + '</b> 项。' +
    (issue ? '请优先处理标红记录。' : '账实一致，无需处理。') + '</span>';
  $('#eq-count').textContent = e.total_kinds + ' 类';
  $('#eq-grid').innerHTML = e.items.length ? e.items.map((it) => {
    const ratio = it.total ? Math.round(it.available / it.total * 100) : 0;
    return '<div class="eq-card ' + (it.status === 'ok' ? '' : it.status) + '">' +
      '<div class="eq-top"><strong>' + esc(it.name) + '</strong><span>' + esc(it.category) + '</span></div>' +
      '<div class="eq-nums"><b>' + it.available + '</b><small>/ ' + it.total + ' ' + esc(it.unit) + ' 可用</small></div>' +
      '<div class="eq-bar"><div style="width:' + ratio + '%"></div></div>' +
      '<div class="eq-foot"><span>借出 ' + it.on_loan + '</span><span>' + (it.status === 'ok' ? '充足' : it.status === 'low' ? '偏少' : '已借空') + '</span></div></div>';
  }).join('') : '<div class="table-empty">还没有器材，用左侧表单添加</div>';

  const sel = $('#loan-item');
  const prev = sel.value;
  sel.innerHTML = e.items.map((it) =>
    '<option value="' + esc(it.id) + '">' + esc(it.name) + '（可用 ' + it.available + ' ' + esc(it.unit) + '）</option>').join('');
  if (prev && e.items.some((i) => i.id === prev)) sel.value = prev;

  $('#loan-count').textContent = e.loans.length + ' 条';
  if (!e.loans.length) {
    $('#loan-table').innerHTML = '<div class="table-empty">暂无借还记录</div>';
    return;
  }
  $('#loan-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>器材</th><th>借用人</th><th>数量</th><th>借出时间</th><th>应还</th><th>状态</th><th>核对</th></tr></thead><tbody>' +
    e.loans.map((l) => '<tr><td><b>' + esc(l.item_name) + '</b></td><td>' + esc(l.borrower) + '</td>' +
      '<td>' + l.qty + (l.returned_qty ? '（已还 ' + l.returned_qty + '）' : '') + '</td>' +
      '<td class="nowrap">' + esc(String(l.borrowed_at).slice(0, 16).replace('T', ' ')) + '</td>' +
      '<td class="nowrap">' + esc(l.due_date) + '</td>' +
      '<td><span class="tag ' + (l.overdue ? 'tag-bad' : l.state === '已归还' ? 'tag-ok' : 'tag-blue') + '">' + esc(l.state) + '</span></td>' +
      '<td class="nowrap">' + (l.status === 'returned' ? '<span class="muted">已核对</span>' :
        '<button class="btn btn-soft btn-sm" data-return="' + esc(l.id) + '" data-left="' + l.left + '">归还 ' + l.left + '</button> ' +
        (l.left > 1 ? '<button class="btn btn-ghost btn-sm" data-partial="' + esc(l.id) + '" data-left="' + l.left + '">部分</button>' : '')) +
      '</td></tr>').join('') + '</tbody></table></div>';
}

/* ------------------------------ 错题归档 ------------------------------ */
function renderMistakes() {
  const due = S.mistakes.filter((m) => m.due);
  $('#due-count').textContent = due.length + ' 题';
  $('#ms-total').textContent = S.mistakes.length + ' 题';
  $('#due-list').innerHTML = due.length ? due.slice(0, 6).map((m) =>
    '<div class="due-item"><h4>' + esc(m.title) + '</h4>' +
    '<p>' + esc(m.subject) + ' · ' + esc(m.knowledge) + ' · 第 ' + (m.stage + 1) + ' 轮复习' + (m.wrong_reason ? ' · 错因：' + esc(m.wrong_reason) : '') + '</p>' +
    '<div class="due-actions"><button class="btn btn-soft btn-sm" data-review="ok" data-id="' + esc(m.id) + '">已掌握，下一轮</button>' +
    '<button class="btn btn-ghost btn-sm" data-review="again" data-id="' + esc(m.id) + '">还没记住，重来</button></div></div>').join('')
    : '<div class="table-empty">今天没有到期的复习任务 ✓</div>';

  const subjects = {};
  S.mistakes.forEach((m) => { subjects[m.subject] = (subjects[m.subject] || 0) + 1; });
  const entries = Object.entries(subjects).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $('#subject-bars').innerHTML = entries.length ? entries.map(([k, v]) =>
    '<div class="bar-row"><span class="bar-name">' + esc(k) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + (v / max * 100) + '%"></span></span><span class="bar-val">' + v + '</span></div>').join('')
    : '<div class="table-empty">还没有归档错题</div>';

  if (!S.mistakes.length) {
    $('#mistake-table').innerHTML = '<div class="table-empty">还没有错题，用左侧表单录入第一题</div>';
    return;
  }
  $('#mistake-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>题目摘要</th><th>学科 / 知识点</th><th>错因</th><th>复习</th><th>下次复习</th><th>状态</th><th></th></tr></thead><tbody>' +
    S.mistakes.map((m) => '<tr><td><b>' + esc(m.title) + '</b></td><td>' + esc(m.subject) + ' / ' + esc(m.knowledge) + '</td>' +
      '<td>' + esc(m.wrong_reason || '—') + '</td><td>' + m.review_count + ' 次</td>' +
      '<td class="nowrap">' + esc(m.next_review) + '</td>' +
      '<td><span class="tag ' + (m.mastered ? 'tag-ok' : m.due ? 'tag-warn' : 'tag-gray') + '">' + (m.mastered ? '已掌握' : m.due ? '待复习' : '排队中') + '</span></td>' +
      '<td><button class="btn btn-ghost btn-sm" data-del-mistake="' + esc(m.id) + '">删除</button></td></tr>').join('') +
    '</tbody></table></div>';
}

/* ------------------------------ 运行日志 ------------------------------ */
function renderLogs() {
  const a = S.logs; if (!a) return;
  $('#log-stats').innerHTML = [
    statCard('#2563d9', '#eaf1ff', 'chart', '近 7 天调用', a.total_calls, '次', '覆盖 ' + a.days_with_data + ' 个自然日'),
    statCard('#0d9488', '#e2f6f2', 'clock', '平均耗时', a.avg_duration_ms, 'ms', 'P95 ' + a.p95_duration_ms + 'ms / 峰值 ' + a.max_duration_ms + 'ms'),
    statCard('#d94a4a', '#fdecec', 'alert', '报错次数', a.by_status.error || 0, '次', '成功率 ' + (a.total_calls ? Math.round((1 - (a.by_status.error || 0) / a.total_calls) * 100) : 100) + '%'),
    statCard('#e08a12', '#fff3dc', 'box', '日志文件', a.all_days.length, '天', '每日自动写入 process_logs/'),
  ].join('');

  const mods = Object.entries(a.by_module).sort((x, y) => y[1] - x[1]);
  const max = Math.max(1, ...mods.map((m) => m[1]));
  $('#module-bars').innerHTML = mods.length ? mods.map(([k, v]) =>
    '<div class="bar-row"><span class="bar-name">' + esc(k) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + (v / max * 100) + '%"></span></span><span class="bar-val">' + v + '</span></div>').join('')
    : '<div class="table-empty">暂无调用数据</div>';

  $('#error-count').textContent = (a.by_status.error || 0) + ' 次';
  const codes = Object.entries(a.by_error_code || {}).sort((x, y) => y[1] - x[1]);
  const codeMax = Math.max(1, ...codes.map((c) => c[1]));
  $('#error-codes').innerHTML = codes.length ? codes.map(([k, v]) =>
    '<div class="bar-row"><span class="bar-name" style="width:112px">' + esc(k) + '</span>' +
    '<span class="bar-track"><span class="bar-fill" style="width:' + (v / codeMax * 100) + '%"></span></span>' +
    '<span class="bar-val">' + v + '</span></div>').join('')
    : '<div class="table-empty">窗口内无报错 ✓</div>';
  $('#error-list').innerHTML = a.errors.length ? '<div class="table-wrap"><table class="table"><thead><tr><th>时间</th><th>模块/动作</th><th>错误码</th></tr></thead><tbody>' +
    a.errors.slice().reverse().slice(0, 8).map((e) => '<tr><td class="nowrap">' + esc(fmtTime(e.ts)) + '</td><td>' + esc(e.module + ' / ' + e.action) + '</td><td><span class="tag tag-bad">' + esc(e.error_code || '-') + '</span></td></tr>').join('') +
    '</tbody></table></div>' : '<div class="table-empty">当前窗口内没有报错 ✓</div>';

  // 保留用户当前选中的日期，避免 renderLogs 重绘后跳回今天
  const selectedDay = $('#log-day-select').value || S.today;
  const dayOptions = a.all_days.slice().reverse();
  $('#log-day-select').innerHTML = (dayOptions.length ? dayOptions : [S.today])
    .map((d) => '<option value="' + d + '"' + (d === selectedDay ? ' selected' : '') + '>' + d + '</option>').join('');

  const rows = S.dayRows.slice(-25).reverse();
  $('#log-table').innerHTML = rows.length ? '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>时间</th><th>模块</th><th>动作</th><th>状态</th><th>耗时</th><th>错误码</th><th>脱敏特征</th></tr></thead><tbody>' +
    rows.map((r) => {
      const feats = Object.entries(r.meta || {}).filter(([, v]) => typeof v === 'number' || typeof v === 'boolean').slice(0, 3)
        .map(([k, v]) => k + '=' + v).join(' · ');
      return '<tr><td class="nowrap">' + esc(fmtTime(r.ts)) + '</td><td>' + esc(r.module) + '</td><td>' + esc(r.action) + '</td>' +
        '<td><span class="tag ' + (r.status === 'ok' ? 'tag-ok' : 'tag-bad') + '">' + r.status + '</span></td>' +
        '<td class="nowrap">' + r.duration_ms + 'ms</td><td>' + esc(r.error_code || '—') + '</td>' +
        '<td class="muted">' + esc(feats || '—') + '</td></tr>';
    }).join('') + '</tbody></table></div>' : '<div class="table-empty">今天还没有调用记录</div>';
}

/* ------------------------------ 使用反馈 ------------------------------ */
function renderFeedback() {
  const n = S.feedback.length;
  $('#fb-progress').textContent = n + ' / 8';
  $('#fb-progress-bar').style.width = Math.min(100, n / 8 * 100) + '%';
  $('#fb-list').innerHTML = n ? S.feedback.map((f) =>
    '<div class="fb-card"><div class="fb-head"><span>' + esc(f.role) + ' · ' + esc(f.module) + '</span>' +
    '<span class="tag ' + (f.score >= 4 ? 'tag-ok' : f.score >= 3 ? 'tag-warn' : 'tag-bad') + '">' + f.score + ' 分</span></div>' +
    (f.liked ? '<p><b>有帮助：</b>' + esc(f.liked) + '</p>' : '') +
    (f.suggestion ? '<p><b>建议：</b>' + esc(f.suggestion) + '</p>' : '') +
    '<p class="muted">' + esc(String(f.created_at).slice(0, 16).replace('T', ' ')) + '</p></div>').join('')
    : '<div class="table-empty">还没有收到反馈，请邀请同学真实试用后填写</div>';
}

/* -------------------------------- 事件 -------------------------------- */
function bindEvents() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('.nav-item'); if (btn) switchView(btn.dataset.view);
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) switchView(go.dataset.go);
  });

  $('#sample-row').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sample]'); if (!b) return;
    $('#notice-input').value = S.samples[Number(b.dataset.sample)].text;
    $('#notice-count').textContent = $('#notice-input').value.length;
    toast('已填入示例通知，点「结构化提取」试试');
  });
  $('#notice-input').addEventListener('input', (e) => { $('#notice-count').textContent = e.target.value.length; });
  $('#btn-parse').addEventListener('click', guard(async () => {
    const text = $('#notice-input').value.trim();
    if (!text) { toast('请先粘贴通知内容', true); return; }
    const n = await api('notice/parse', { method: 'POST', body: { text } });
    S.parsed = n; renderParseResult(n); toast('解析完成，置信度 ' + n.confidence + '%');
  }));
  $('#parse-result').addEventListener('click', guard(async (e) => {
    if (e.target.closest('#btn-save-notice')) {
      await api('notice/save', { method: 'POST', body: { notice: S.parsed } });
      toast('已保存到待办'); refreshView('notice'); switchView('notice');
    } else if (e.target.closest('#btn-ics-preview')) {
      downloadText('campus-notice.ics', S.parsed.ics, 'text/calendar;charset=utf-8');
      toast('已导出日历文件');
    } else if (e.target.closest('#btn-copy-md')) {
      const n = S.parsed;
      const md = '## ' + n.title + '\n\n- 分类：' + n.category + '\n- 时间：' + (n.event_date || '未识别') + ' ' + (n.event_time || '') +
        '\n- 地点：' + (n.location || '未识别') + '\n- 对象：' + (n.audience.join('、') || '未指定') +
        '\n- 截止：' + (n.deadline || '无') + '\n\n' + n.todos.map((t, i) => (i + 1) + '. [ ] ' + t).join('\n');
      try { await navigator.clipboard.writeText(md); toast('已复制为 Markdown'); }
      catch (_) { downloadText('notice.md', md, 'text/markdown;charset=utf-8'); toast('已导出 Markdown 文件'); }
    }
  }));

  $('#notice-list').addEventListener('click', guard(async (e) => {
    const tg = e.target.closest('[data-toggle]');
    const del = e.target.closest('[data-del-notice]');
    if (tg) { await api('notice/toggle', { method: 'POST', body: { id: tg.dataset.toggle } }); refreshView('notice'); }
    else if (del) { await api('notice/delete', { method: 'DELETE', body: { id: del.dataset.delNotice } }); toast('已删除'); refreshView('notice'); }
  }));

  $('#form-loan').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('loan/create', { method: 'POST', body: {
      item_id: $('#loan-item').value, borrower: $('#loan-borrower').value,
      qty: Number($('#loan-qty').value), due_date: $('#loan-due').value,
      purpose: $('#loan-purpose').value,
    } });
    $('#loan-borrower').value = ''; $('#loan-purpose').value = '';
    toast('借出登记成功，库存已同步'); refreshView('equipment');
  }));
  $('#form-equipment').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('equipment/add', { method: 'POST', body: {
      name: $('#eq-name').value, total: Number($('#eq-total').value), category: $('#eq-category').value,
    } });
    $('#eq-name').value = ''; toast('器材已添加'); refreshView('equipment');
  }));
  $('#loan-table').addEventListener('click', guard(async (e) => {
    const r = e.target.closest('[data-return]'), p = e.target.closest('[data-partial]');
    if (r) { await api('loan/return', { method: 'POST', body: { id: r.dataset.return, returned_qty: Number(r.dataset.left) } }); toast('归还已核对'); refreshView('equipment'); }
    else if (p) {
      const input = window.prompt('本次归还数量（最多 ' + p.dataset.left + '）', '1');
      if (input === null) return;
      const n = Number(input);
      if (!Number.isInteger(n) || n < 1 || n > Number(p.dataset.left)) { toast('数量不合法', true); return; }
      await api('loan/return', { method: 'POST', body: { id: p.dataset.partial, returned_qty: n } });
      toast('部分归还已记录'); refreshView('equipment');
    }
  }));

  $('#form-mistake').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('mistake/add', { method: 'POST', body: {
      title: $('#ms-title').value, subject: $('#ms-subject').value,
      knowledge: $('#ms-knowledge').value, wrong_reason: $('#ms-reason').value,
      correct_answer: $('#ms-answer').value,
    } });
    $('#ms-title').value = ''; $('#ms-reason').value = ''; $('#ms-answer').value = '';
    toast('已加入复习队列，明天第一次复习'); refreshView('mistake');
  }));
  $('#due-list').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-review]'); if (!b) return;
    await api('mistake/review', { method: 'POST', body: { id: b.dataset.id, result: b.dataset.review } });
    toast(b.dataset.review === 'ok' ? '已安排下一轮复习' : '已重置为第一轮');
    refreshView('mistake');
  }));
  $('#mistake-table').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-del-mistake]'); if (!b) return;
    await api('mistake/delete', { method: 'DELETE', body: { id: b.dataset.delMistake } });
    toast('已删除'); refreshView('mistake');
  }));

  $('#log-day-select').addEventListener('change', guard(async (e) => {
    const r = await api('logs/day?date=' + encodeURIComponent(e.target.value));
    S.dayRows = r.rows; renderLogs();
  }));
  $('#btn-report').addEventListener('click', guard(async () => {
    const r = await api('logs/report', { method: 'POST', body: {} });
    toast(r.ok ? '当日日报已生成到 process_logs/' : '生成失败');
  }));

  $('#form-feedback').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('feedback/add', { method: 'POST', body: {
      role: $('#fb-role').value, module: $('#fb-module').value,
      score: Number($('#fb-score').value), liked: $('#fb-liked').value,
      suggestion: $('#fb-suggestion').value,
    } });
    $('#fb-role').value = ''; $('#fb-liked').value = ''; $('#fb-suggestion').value = '';
    toast('感谢反馈，已记录'); refreshView('feedback');
  }));
}

/* -------------------------------- 启动 -------------------------------- */
(async function init() {
  bindEvents();
  try {
    const b = await api('bootstrap');
    S.dashboard = b.dashboard; S.notices = b.notices; S.equipment = b.equipment;
    S.mistakes = b.mistakes; S.feedback = b.feedback; S.samples = b.samples;
    S.today = b.today; S.version = b.version;
    $('#side-version').textContent = S.version.replace(/^v/, '');
    $('#today-text').textContent = S.today;
    $('#loan-due').value = addDays(S.today, 7);
    renderSamples(); renderDashboard(); renderNoticeList();
    $('#badge-notice').textContent = b.dashboard.notice.pending;
    $('#badge-loan').textContent = b.dashboard.equipment.overdue;
    $('#badge-mistake').textContent = b.dashboard.mistake.due_today;
  } catch (err) {
    toast('服务未响应：' + err.message + '，请确认 node server.js 正在运行', true);
  }
})();
