'use strict';
/* 学生 / 教师工作台：原生 JS，无框架、无 CDN，断网也能用
   v6 · 按 SRS 功能域重构信息架构；所有展示值来自真实接口，无演示填充 */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = (v) => String(v === null || v === undefined ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const S = {
  view: 'dashboard', user: null, permissions: [], dashboard: null,
  notices: [], equipment: null, mistakes: [], feedback: [], activity: [],
  parsed: null, today: '', version: '', empty: true,
  filter: { text: '', category: '', state: '' },
  importType: 'paste', feedbackProgress: 0, revise: null,
};

const IMPORT_LABEL = { paste: '手动粘贴', txt: '.txt', md: '.md', csv: '.csv', json: '.json' };
const FIELD_LABEL = {
  title: '标题', category: '分类', event_date: '活动日期', event_time: '时间',
  location: '地点', deadline: '截止日期', audience: '面向对象', todos: '待办事项',
  materials: '所需材料', issuer: '发布单位', importance: '重要程度',
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
  server: '<svg><use href="#i-server"/></svg>',
  trace: '<svg><use href="#i-trace"/></svg>',
  spark: '<svg><use href="#i-spark"/></svg>',
};
const TITLES = {
  dashboard: ['总览看板', '七项指标与最近操作，全部来自本机真实数据', '概览'],
  notice: ['通知与任务', '导入 → 提取 → 人工审核 → 生成待办', '事务处理'],
  equipment: ['实验器材', '档案、借出、归还、库存与逾期自动核对', '事务处理'],
  mistake: ['错题归档', '按遗忘曲线排队复习，直到真正掌握', '事务处理'],
  assistant: ['智能助手', '本地离线问答 · 回答附来源 · 资料不足明确拒答', '智能服务'],
  activity: ['我的足迹', '仅显示当前账号的脱敏调用摘要', '智能服务'],
  feedback: ['使用反馈', '来自真实使用者的评价与改进建议', '协作与系统'],
  about: ['项目与功能地图', 'SRS 功能编号与实现状态逐项对照', '协作与系统'],
};
const ACTION_LABEL = {
  parse: '结构化提取', save: '保存通知', list: '查看清单', toggle: '标记待办',
  ics: '导出日历', dashboard: '打开看板', bootstrap: '载入工作台',
  create: '登记借出', return: '归还核对', add: '新增记录', review: '复习打卡',
  delete: '删除记录', me: '读取账号', state: '读取状态', activity: '查看足迹',
  password: '修改密码', login: '登录', logout: '退出', equipment: '查看器材',
  notice: '查看通知', mistake: '查看错题', feedback: '查看反馈', loan: '查看借还',
  health: '健康检查', index: '打开工作台', home: '打开封面',
  revise: '版本比对', preview: '预览日历', progress: '查看反馈进度',
  audit: '查看审计', backup: '备份导出', ask: '询问助手',
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
  if (res.status === 401) { window.location.href = '/user/login.html'; throw new Error('登录已失效'); }
  if (!res.ok) throw new Error(data.message || data.error || '请求失败 (' + res.status + ')');
  return data;
}
function can(perm) { return S.permissions.includes('*') || S.permissions.includes(perm); }

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
function fmtClock(ts) {
  const d = new Date(ts), p = (n) => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '/' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
function localISO() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}
function deadlineText(iso) {
  const d = Math.round((Date.parse(iso + 'T00:00:00') - Date.parse(localISO() + 'T00:00:00')) / 86400000);
  if (d < 0) return '已逾期 ' + (-d) + ' 天';
  if (d === 0) return '今天截止';
  if (d === 1) return '明天截止';
  return '还剩 ' + d + ' 天';
}

/** CM-FR-101：5 种文本导入，全部在本机浏览器完成，不上传、不依赖第三方库 */
function parseImportedText(name, raw) {
  const ext = (String(name).split('.').pop() || '').toLowerCase();
  const type = ext === 'csv' ? 'csv' : ext === 'json' ? 'json'
    : (ext === 'md' || ext === 'markdown') ? 'md' : 'txt';
  let text = raw, note = '';
  if (type === 'json') {
    try {
      const obj = JSON.parse(raw);
      if (Array.isArray(obj)) {
        text = obj.map((x) => typeof x === 'string' ? x
          : (x.text || x.content || x.body || x.notice || JSON.stringify(x))).join('\n');
        note = '数组 ' + obj.length + ' 项';
      } else if (obj && typeof obj === 'object') {
        const picked = obj.text || obj.content || obj.body || obj.notice || obj.raw;
        text = String(picked || raw);
        note = picked ? '已取文本字段' : '未找到文本字段，按原始 JSON 导入';
      }
    } catch (_) { note = 'JSON 解析失败，按纯文本导入'; }
  } else if (type === 'csv') {
    text = raw.split(/\r?\n/).map((line) => line
      .split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/)
      .map((c) => c.replace(/^"|"$/g, '').trim()).filter(Boolean).join(' '))
      .filter(Boolean).join('\n');
    note = '按行合并单元格';
  }
  return { type, text: String(text).trim(), note };
}
function importFile(file) {
  if (!file) return;
  const ext = (String(file.name).split('.').pop() || '').toLowerCase();
  if (!['txt', 'text', 'md', 'markdown', 'csv', 'json'].includes(ext)) {
    toast('仅支持 .txt / .md / .csv / .json 文本格式', true); return;
  }
  if (file.size > 512 * 1024) { toast('文件超过 512 KB，请拆分后再导入', true); return; }
  const reader = new FileReader();
  reader.onload = () => {
    const r = parseImportedText(file.name, String(reader.result || ''));
    if (!r.text) { toast('文件内没有可提取的文本', true); return; }
    $('#notice-input').value = r.text;
    $('#notice-input').dispatchEvent(new Event('input'));
    S.importType = r.type;
    $('#import-info').textContent = file.name + ' · ' + (Math.round(file.size / 1024 * 10) / 10) +
      ' KB · ' + IMPORT_LABEL[r.type] + (r.note ? ' · ' + r.note : '');
    toast('已导入 ' + file.name + '，请核对原文后点击「结构化提取」');
  };
  reader.onerror = () => toast('文件读取失败', true);
  reader.readAsText(file, 'utf-8');
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type: type || 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function durationText(s) {
  if (s < 3600) return Math.floor(s / 60) + ' 分钟';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时 ' + Math.floor(s % 3600 / 60) + ' 分';
  return Math.floor(s / 86400) + ' 天 ' + Math.floor(s % 86400 / 3600) + ' 小时';
}

/* ------------------------------- 视图切换 ------------------------------- */
function switchView(name) {
  if (!TITLES[name]) return;
  S.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $('#page-title').textContent = TITLES[name][0];
  $('#page-sub').textContent = TITLES[name][1];
  $('#crumb-group').textContent = TITLES[name][2];
  window.scrollTo({ top: 0, behavior: 'smooth' });
  refreshView(name);
}

async function refreshView(name) {
  try {
    if (name === 'dashboard') {
      const [d, n, m, a] = await Promise.all([
        api('dashboard'), api('notice/list'), api('mistake/list'), api('activity?days=7'),
      ]);
      S.dashboard = d; S.notices = n.items; S.mistakes = m.items; S.activity = a.items || [];
      renderDashboard();
    } else if (name === 'notice') {
      const r = await api('notice/list'); S.notices = r.items;
      fillNoticeFilter(); renderNoticeList();
    } else if (name === 'equipment') {
      S.equipment = await api('equipment/list'); renderEquipment();
    } else if (name === 'mistake') {
      const r = await api('mistake/list'); S.mistakes = r.items; renderMistakes();
    } else if (name === 'feedback') {
      if (can('feedback.list')) { const r = await api('feedback/list'); S.feedback = r.items; }
      try { const p = await api('feedback/progress'); S.feedbackProgress = p.collected; } catch (_) {}
      renderFeedback();
    } else if (name === 'activity') {
      const a = await api('activity?days=7'); S.activity = a.items || []; renderActivity();
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
  $('#today-text').textContent = d.today + ' · ' + ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date().getDay()];
  $('#side-logdays').textContent = d.telemetry.days_with_data;

  // CM-FR-001 的七项指标（第八张为验收进度）
  $('#stat-grid').innerHTML = [
    statCard('#2563d9', '#eaf1ff', 'notice', '今日待办', d.notice.pending, '条', '其中近 3 天到期 ' + d.notice.due_soon + ' 条'),
    statCard('#e08a12', '#fff3dc', 'clock', '即将到期通知', d.notice.due_soon, '条', '按截止日期 ≤ 3 天统计'),
    statCard('#d94a4a', '#fdecec', 'box', '未归还借用', d.loan.active, '笔', '其中逾期 ' + d.loan.overdue + ' 笔'),
    statCard('#0d9488', '#e2f6f2', 'server', '器材库存概况', d.equipment.total_units, '件', d.equipment.total_kinds + ' 类 · 在借 ' + d.equipment.on_loan + ' 件'),
    statCard('#5b6bd6', '#eef0ff', 'chart', '近 7 天程序调用', d.telemetry.total_calls, '次', '今日 ' + d.telemetry.today_calls + ' 次 · 平均 ' + d.telemetry.avg_duration_ms + 'ms'),
    statCard('#0f766e', '#e2f6f2', 'server', '软件运行状态', '正常', '', 'v' + d.system.version.replace(/^v/, '') + ' · 已运行 ' + durationText(d.system.uptime_s)),
    statCard('#2563d9', '#eaf1ff', 'trace', '最近操作记录', S.activity.length, '条', '仅统计当前账号的脱敏调用'),
    statCard('#b45309', '#fff3dc', 'chat', '真实反馈进度', d.feedback.collected, '/ 8', d.feedback.collected >= 8 ? '已达成收集目标' : '还差 ' + (8 - d.feedback.collected) + ' 位同学'),
  ].join('');

  const sys = d.system;
  $('#sys-strip').innerHTML =
    '<span class="sys-item"><i class="status-dot ok"></i> 服务 <b>' + esc(sys.status === 'ok' ? '正常' : sys.status) + '</b></span>' +
    '<span class="sys-item">版本 <b>' + esc(sys.version) + '</b></span>' +
    '<span class="sys-item">运行 <b>' + esc(durationText(sys.uptime_s)) + '</b></span>' +
    '<span class="sys-item">内存 <b>' + sys.rss_mb + ' MB</b></span>' +
    '<span class="sys-item">日志 <b>' + sys.log_days + ' 天</b></span>' +
    '<span class="sys-item">连续 <b>' + (sys.streak_days ?? 0) + ' / 7 天</b></span>' +
    '<span class="sys-item">数据 <b>' + (S.empty ? '全部为空 · 由你录入' : '由使用者录入') + '</b></span>';

  const days = lastDays(7), byDay = d.telemetry.by_day || {};
  const vals = days.map((x) => byDay[x] || 0);
  const max = Math.max(1, ...vals);
  $('#trend-chart').innerHTML = days.map((day, i) =>
    '<div class="trend-col"><span class="trend-val">' + (vals[i] || '') + '</span>' +
    '<div class="trend-bar' + (vals[i] ? '' : ' zero') + '" style="height:' + (vals[i] ? 8 + vals[i] / max * 86 : 3) + 'px"></div>' +
    '<span class="trend-label">' + day.slice(5) + '</span></div>').join('');

  renderDashActivity();

  const pending = S.notices.filter((n) => !n.done)
    .sort((a, b) => String(a.deadline || '9999').localeCompare(String(b.deadline || '9999'))).slice(0, 4);
  $('#dash-todos').innerHTML = pending.length ? pending.map((n) =>
    '<div class="mini-item"><i class="dot' + (n.deadline && n.deadline <= addDays(d.today, 2) ? ' warn' : '') + '"></i>' +
    '<span class="txt">' + esc(n.title) + '</span><span class="date">' + (n.deadline ? '截止 ' + esc(fmtDate(n.deadline)) : esc(fmtDate(n.event_date))) + '</span></div>').join('')
    : '<div class="mini-empty">暂无待办，去「通知与任务」粘贴一条通知 →</div>';

  const due = S.mistakes.filter((m) => m.due).slice(0, 4);
  $('#dash-reviews').innerHTML = due.length ? due.map((m) =>
    '<div class="mini-item"><i class="dot"></i><span class="txt">' + esc(m.title) + '</span>' +
    '<span class="date">' + esc(m.subject) + '</span></div>').join('')
    : '<div class="mini-empty">今天没有到期的复习任务 ✓</div>';
}

function renderDashActivity() {
  const rows = S.activity.slice(0, 6);
  $('#dash-activity').innerHTML = rows.length ? rows.map((r) =>
    '<div class="mini-item"><i class="dot' + (r.status === 'error' ? ' red' : '') + '"></i>' +
    '<span class="txt">' + esc(ACTION_LABEL[r.action] || r.action) + ' · ' + esc(r.module) + '/' + esc(r.action) + '</span>' +
    '<span class="date">' + esc(fmtClock(r.ts)) + '</span></div>').join('')
    : '<div class="mini-empty">暂无操作记录，任意操作后会自动出现在这里</div>';
}

/* ------------------------------ 我的足迹 ------------------------------ */
function renderActivity() {
  $('#activity-count').textContent = S.activity.length + ' 条';
  if (!S.activity.length) {
    $('#activity-list').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-trace"/></svg></div><b>暂无操作记录</b><span>打开任意页面或完成一次操作后，服务端会自动写入脱敏日志</span></div>';
    return;
  }
  $('#activity-list').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>时间</th><th>模块</th><th>动作</th><th>状态</th><th class="num">耗时</th><th>错误码</th></tr></thead><tbody>' +
    S.activity.map((r) => '<tr><td class="nowrap">' + esc(fmtClock(r.ts)) + '</td>' +
      '<td>' + esc(r.module) + '</td><td>' + esc(ACTION_LABEL[r.action] || r.action) + ' <code>' + esc(r.action) + '</code></td>' +
      '<td><span class="tag ' + (r.status === 'ok' ? 'tag-ok' : 'tag-bad') + '">' + esc(r.status) + '</span></td>' +
      '<td class="num">' + r.duration_ms + ' ms</td><td>' + (r.error_code ? '<span class="tag tag-bad">' + esc(r.error_code) + '</span>' : '—') + '</td></tr>').join('') +
    '</tbody></table></div>';
}

/* ------------------------------ 通知提取 ------------------------------ */
function importanceTag(v) {
  const cls = v === '紧急' ? 'tag-bad' : v === '重要' ? 'tag-warn' : 'tag-gray';
  return '<span class="tag ' + cls + '">' + esc(v || '普通') + '</span>';
}
function renderParseResult(n) {
  const fields = [
    ['通知类别', n.category, true],
    ['重要程度 · 规则判定', n.importance || '普通'],
    ['发布单位', n.issuer || '未识别'],
    ['活动时间', n.event_date ? n.event_date + (n.event_time ? ' ' + n.event_time + (n.event_end_time ? '–' + n.event_end_time : '') : '') : '未识别'],
    ['活动地点', n.location || '未识别'],
    ['面向对象', (n.audience || []).join('、') || '未指定'],
    ['截止日期', n.deadline || '无', true],
    ['联系方式 / 咨询', (n.contact || []).join(' / ') || '未识别'],
    ['所需材料', (n.materials || []).join('、') || '未识别'],
    ['置信度', n.confidence + '%（命中 ' + n.hit_rules + '/8 项规则）'],
  ];
  let html = '<div class="result-head"><div><h4>' + esc(n.title) + '</h4>' +
    '<div class="muted">共识别 ' + n.date_candidates.length + ' 个日期、' + n.locations.length + ' 处地点，耗时 ' + n.parse_ms + 'ms · 引擎 ' + esc(n.extract_engine || 'local-rules') + ' · 导入 ' + esc(IMPORT_LABEL[n.import_type] || '手动粘贴') + '</div>' +
    '<div class="conf-track"><div class="conf-fill" style="width:' + n.confidence + '%"></div></div></div>' +
    '<span class="tag ' + (n.confidence >= 75 ? 'tag-ok' : 'tag-warn') + '">' + (n.confidence >= 75 ? '解析良好' : '建议复核') + '</span></div>';
  html += '<div class="field-grid">' + fields.map(([k, v, em]) =>
    '<div class="field"><label>' + k + '</label><strong class="' + (em ? 'em' : '') + '">' + esc(v) + '</strong></div>').join('') + '</div>';
  if ((n.tags || []).length) html += '<div class="tag-row">' + n.tags.map((t) => '<span class="tag tag-blue">' + esc(t) + '</span>').join('') + '</div>';

  if (n.duplicate_hint && n.duplicate_hint.detected) {
    html += '<div class="band band-warn"><svg><use href="#i-alert"/></svg><div>' +
      '<b>疑似重复通知 · CM-FR-109</b><span>检测到 ' + n.duplicate_hint.count +
      ' 条相似记录，最高相似度 ' + n.duplicate_hint.top_similarity +
      '%。系统不会自动拒绝，也不会展示他人通知内容，请人工核对后再决定是否保存。</span></div></div>';
  }

  html += '<div class="result-sub">自动生成的待办 · ' + n.todos.length + ' 项</div>' +
    n.todos.map((t, i) => '<div class="todo-item"><i>' + (i + 1) + '</i><span>' + esc(t) + '</span></div>').join('');
  if (n.warnings.length) html += '<div class="warn-list">' + n.warnings.map((w) => '<div>· ' + esc(w) + '</div>').join('') + '</div>';

  // CM-FR-105：人工审核 —— 可修改标题与截止日期，勾选确认后才允许入库
  html += '<div class="review-box"><div class="review-head"><svg><use href="#i-shield"/></svg><b>③ 人工审核</b><span>规则结果不得未经确认直接执行</span></div>' +
    '<div class="form-row"><label>校正标题<input id="review-title" maxlength="60" value="' + esc(n.title) + '"></label>' +
    '<label>校正截止日期<input id="review-deadline" type="date" value="' + esc(n.deadline || '') + '"></label></div>' +
    '<div class="form-row"><label>提前提醒（分钟 · CM-FR-107）<input id="review-remind" type="number" min="0" max="43200" step="30" value="' + esc(n.remind_minutes ?? 30) + '"></label>' +
    '<label>导入方式<input value="' + esc(IMPORT_LABEL[n.import_type] || '手动粘贴') + '" readonly></label></div>' +
    '<div class="hint">0 = 不提醒；1440 = 提前 1 天。提醒会写入导出的 .ics 日历（VALARM）。</div>' +
    '<label class="review-check"><input type="checkbox" id="review-confirm"><span>我已核对以上字段，确认按此结果生成待办</span></label>' +
    '<div class="result-actions">' +
    '<button class="btn btn-primary" id="btn-save-notice"><svg><use href="#i-check"/></svg>确认并保存</button>' +
    '<button class="btn btn-ghost" id="btn-ics-preview"><svg><use href="#i-download"/></svg>导出日历 .ics</button>' +
    '<button class="btn btn-ghost" id="btn-copy-md">复制为 Markdown</button>' +
    '<button class="btn btn-danger" id="btn-reject-notice">拒绝本次结果</button></div></div>';
  $('#parse-result').innerHTML = html;
  $('#parse-conf').textContent = '置信度 ' + n.confidence + '%';
  $('#parse-conf').className = 'chip ' + (n.confidence >= 75 ? 'good' : 'warn');
}

function fillReviseSelect() {
  const sel = $('#revise-notice');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = S.notices.length
    ? S.notices.map((n) => '<option value="' + esc(n.id) + '">' + esc(n.title) +
      ' · v' + (n.version || 1) + '</option>').join('')
    : '<option value="">（还没有已保存的通知）</option>';
  if (prev && S.notices.some((n) => n.id === prev)) sel.value = prev;
}
function renderReviseResult(data) {
  const changes = data.changes || [];
  const rows = changes.length
    ? '<div class="table-wrap"><table class="table"><thead><tr><th>字段</th><th>原版本</th><th>新版本</th></tr></thead><tbody>' +
      changes.map((c) => '<tr><td><b>' + esc(FIELD_LABEL[c.field] || c.field) + '</b></td>' +
        '<td>' + esc(c.from) + '</td><td>' + esc(c.to) + '</td></tr>').join('') + '</tbody></table></div>'
    : '<div class="table-empty"><b>新旧版本字段完全一致</b><br>无需更新，也可以重新贴入不同的原文</div>';
  $('#revise-result').innerHTML = '<div class="card-head"><h3>字段差异 · ' + changes.length + ' 处</h3>' +
    '<span class="chip ' + (data.applied ? 'good' : '') + '">' + (data.applied ? '已更新' : '预览中') + '</span></div>' +
    rows + '<div class="band ' + (data.applied ? 'band-ok' : 'band-info') + '"><svg><use href="#i-info"/></svg><div><b>' +
    (data.applied ? '已写入 v' + data.notice.version : '尚未写入任何数据') + '</b><span>' +
    (data.applied ? '旧版本字段快照已保留在该通知的 history 中，可追溯。' :
      '核对上方差异后点击「确认并更新版本」，才会真正写入。') + '</span></div></div>';
  $('#btn-revise-apply').classList.toggle('hidden', !!data.applied || !changes.length);
}

function fillNoticeFilter() {
  const sel = $('#notice-filter'), prev = sel.value;
  const cats = [...new Set(S.notices.map((n) => n.category).filter(Boolean))].sort();
  sel.innerHTML = '<option value="">全部类别</option>' + cats.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
  if (cats.includes(prev)) sel.value = prev;
}
function filteredNotices() {
  const { text, category, state } = S.filter;
  const q = text.trim().toLowerCase();
  return S.notices.filter((n) => {
    if (category && n.category !== category) return false;
    if (state === 'done' && !n.done) return false;
    if (state === 'pending' && n.done) return false;
    if (q && !(String(n.title) + ' ' + (n.todos || []).join(' ') + ' ' + String(n.owner_name || '')).toLowerCase().includes(q)) return false;
    return true;
  });
}
function renderNoticeList() {
  fillReviseSelect();
  $('#notice-total').textContent = S.notices.length + ' 条';
  const list = filteredNotices();
  if (!S.notices.length) {
    $('#notice-list').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-notice"/></svg></div><b>还没有保存的通知</b><span>粘贴一条真实通知 → 结构化提取 → 人工审核 → 保存到待办</span></div>';
    return;
  }
  if (!list.length) {
    $('#notice-list').innerHTML = '<div class="table-empty"><b>没有匹配的通知</b><br>换个关键词或清空筛选条件再试</div>';
    return;
  }
  const canDelete = can('notice.delete');
  $('#notice-list').innerHTML = list.map((n) =>
    '<div class="notice-item ' + (n.done ? 'done' : '') + '">' +
    '<div class="notice-check ' + (n.done ? 'on' : '') + '" data-toggle="' + esc(n.id) + '">' + (n.done ? '<svg><use href="#i-check"/></svg>' : '') + '</div>' +
    '<div class="notice-body"><div class="notice-title">' + esc(n.title) + ' ' + importanceTag(n.importance) + '</div>' +
    '<div class="notice-meta"><span class="tag tag-blue">' + esc(n.category) + '</span>' +
    (n.issuer ? '<span><b>发布</b> ' + esc(n.issuer) + '</span>' : '') +
    (n.event_date ? '<span><b>时间</b> ' + esc(n.event_date + (n.event_time ? ' ' + n.event_time : '')) + '</span>' : '') +
    (n.location ? '<span><b>地点</b> ' + esc(n.location) + '</span>' : '') +
    (n.deadline ? '<span><b>截止</b> ' + esc(n.deadline) + ' · ' + esc(deadlineText(n.deadline)) + '</span>' : '') +
    '<span><b>版本</b> v' + (n.version || 1) + '</span>' +
    '<span><b>导入</b> ' + esc(IMPORT_LABEL[n.import_type] || '手动粘贴') + '</span>' +
    (n.duplicate_hint && n.duplicate_hint.detected
      ? '<span class="tag tag-warn">疑似重复 ' + n.duplicate_hint.top_similarity + '%</span>' : '') +
    (n.owner_name ? '<span><b>录入</b> ' + esc(n.owner_name) + '</span>' : '') +
    '<span>提取于 ' + esc(String(n.created_at).slice(0, 10)) + '</span></div>' +
    ((n.materials || []).length ? '<div class="notice-meta"><span><b>所需材料</b> ' + esc(n.materials.join('、')) + '</span></div>' : '') +
    '<ul class="notice-todos">' + (n.todos || []).map((t) => '<li>' + esc(t) + '</li>').join('') + '</ul></div>' +
    '<div class="notice-ops"><a class="btn btn-ghost btn-sm" href="/api/notice/ics?id=' + encodeURIComponent(n.id) + '" download>日历</a>' +
    (canDelete ? '<button class="btn btn-ghost btn-sm" data-del-notice="' + esc(n.id) + '">删除</button>' : '') +
    '</div></div>').join('');
}

/* ------------------------------ 器材借还 ------------------------------ */
function renderEquipment() {
  const e = S.equipment; if (!e) return;
  const issue = e.overdue_count > 0 || e.discrepancy_count > 0;
  $('#recon-bar').className = 'recon-bar' + (issue ? ' has-issue' : '');
  $('#recon-bar').innerHTML = ICON[issue ? 'alert' : 'box'] +
    '<span>库存核对：<b>' + e.total_kinds + '</b> 类器材 / 共 <b>' + e.total_units + '</b> 件，当前在借 <b>' + e.on_loan_units + '</b> 件，' +
    '逾期 <b>' + e.overdue_count + '</b> 笔，库存差异 <b>' + e.discrepancy_count + '</b> 项。' +
    (e.total_kinds === 0 ? '清单为空，请由教师或管理员先添加器材。' : issue ? '请优先处理标红记录。' : '账实一致，无需处理。') + '</span>';
  $('#eq-count').textContent = e.total_kinds + ' 类';
  $('#eq-grid').innerHTML = e.items.length ? e.items.map((it) => {
    const ratio = it.total ? Math.round(it.available / it.total * 100) : 0;
    return '<div class="eq-card ' + (it.status === 'ok' ? '' : it.status) + '">' +
      '<div class="eq-top"><strong>' + esc(it.name) + '</strong><span>' + esc(it.category) + '</span></div>' +
      (it.code || it.model || it.location ? '<div class="eq-archive">' +
        (it.code ? '<span>编号 ' + esc(it.code) + '</span>' : '') +
        (it.model ? '<span>' + esc(it.model) + '</span>' : '') +
        (it.location ? '<span>' + esc(it.location) + '</span>' : '') + '</div>' : '') +
      '<div class="eq-nums"><b>' + it.available + '</b><small>/ ' + it.total + ' ' + esc(it.unit) + ' 可用</small></div>' +
      '<div class="eq-bar"><div style="width:' + ratio + '%"></div></div>' +
      '<div class="eq-foot"><span>借出 ' + it.on_loan + '</span><span>' + (it.status === 'ok' ? '充足' : it.status === 'low' ? '偏少' : '已借空') + '</span></div>' +
      (can('equipment.delete') ? '<button class="btn btn-ghost btn-sm eq-del" data-del-eq="' + esc(it.id) + '">删除</button>' : '') + '</div>';
  }).join('') : '<div class="empty-v2" style="grid-column:1/-1"><div class="empty-icon"><svg><use href="#i-box"/></svg></div><b>器材清单为空</b><span>系统不会预置器材，请由教师或管理员在左侧「新增器材档案」录入</span></div>';

  const sel = $('#loan-item'), prev = sel.value;
  sel.innerHTML = e.items.map((it) =>
    '<option value="' + esc(it.id) + '">' + esc(it.name) + '（可用 ' + it.available + ' ' + esc(it.unit) + '）</option>').join('');
  if (prev && e.items.some((i) => i.id === prev)) sel.value = prev;

  $('#loan-count').textContent = e.loans.length + ' 条';
  if (!e.loans.length) {
    $('#loan-table').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-box"/></svg></div><b>暂无借还记录</b><span>先有器材清单，再由使用者登记借出</span></div>';
    return;
  }
  $('#loan-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>器材</th><th>借用人</th><th class="num">数量</th><th>借出时间</th><th>应还</th><th>状态</th><th class="ops">核对操作</th></tr></thead><tbody>' +
    e.loans.map((l) => '<tr><td><b>' + esc(l.item_name) + '</b></td><td>' + esc(l.borrower) + '</td>' +
      '<td class="num">' + l.qty + (l.returned_qty ? '（已还 ' + l.returned_qty + '）' : '') + '</td>' +
      '<td class="nowrap">' + esc(String(l.borrowed_at).slice(0, 16).replace('T', ' ')) + '</td>' +
      '<td class="nowrap">' + esc(l.due_date) + '</td>' +
      '<td><span class="tag ' + (l.overdue ? 'tag-bad' : l.state === '已归还' ? 'tag-ok' : 'tag-blue') + '">' + esc(l.state) + '</span></td>' +
      '<td class="ops nowrap">' + (l.status === 'returned' ? '<span class="muted">已核对</span>' :
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
    : '<div class="table-empty"><b>今天没有到期的复习任务</b><br>录入第一道错题后，明天会进入复习队列</div>';

  const stat = {};
  S.mistakes.forEach((m) => {
    const k = m.subject || '未分类';
    stat[k] = stat[k] || { total: 0, mastered: 0 };
    stat[k].total++; if (m.mastered) stat[k].mastered++;
  });
  const mastery = Object.entries(stat).sort((a, b) => b[1].total - a[1].total);
  $('#mastery-bars').innerHTML = mastery.length ? mastery.map(([k, v]) => {
    const p = Math.round(v.mastered / v.total * 100);
    return '<div class="bar-row"><span class="bar-name">' + esc(k) + '</span>' +
      '<span class="bar-track"><span class="bar-fill" style="width:' + p + '%"></span></span>' +
      '<span class="bar-val">' + p + '%</span></div>';
  }).join('') + '<div class="hint">掌握率 = 已完成 6 轮复习的题数 / 该学科归档题数</div>'
    : '<div class="table-empty">还没有归档错题</div>';

  const entries = mastery.map(([k, v]) => [k, v.total]);
  const max = Math.max(1, ...entries.map((e) => e[1]));
  $('#subject-bars').innerHTML = entries.length ? entries.map(([k, v]) =>
    '<div class="bar-row"><span class="bar-name">' + esc(k) + '</span><span class="bar-track"><span class="bar-fill" style="width:' + (v / max * 100) + '%"></span></span><span class="bar-val">' + v + '</span></div>').join('')
    : '<div class="table-empty">还没有归档错题</div>';

  if (!S.mistakes.length) {
    $('#mistake-table').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-book"/></svg></div><b>还没有错题</b><span>用左侧表单录入第一题，所有内容由你填写</span></div>';
    return;
  }
  const canDelete = can('mistake.delete');
  $('#mistake-table').innerHTML = '<div class="table-wrap"><table class="table"><thead><tr>' +
    '<th>题目摘要</th><th>学科 / 知识点</th><th>错因</th><th class="num">复习</th><th>下次复习</th><th>状态</th>' + (canDelete ? '<th class="ops">操作</th>' : '') + '</tr></thead><tbody>' +
    S.mistakes.map((m) => '<tr><td><b>' + esc(m.title) + '</b></td><td>' + esc(m.subject) + ' / ' + esc(m.knowledge) + '</td>' +
      '<td>' + esc(m.wrong_reason || '—') + '</td><td class="num">' + m.review_count + '</td>' +
      '<td class="nowrap">' + esc(m.next_review) + '</td>' +
      '<td><span class="tag ' + (m.mastered ? 'tag-ok' : m.due ? 'tag-warn' : 'tag-gray') + '">' + (m.mastered ? '已掌握' : m.due ? '待复习' : '排队中') + '</span></td>' +
      (canDelete ? '<td class="ops"><button class="btn btn-ghost btn-sm" data-del-mistake="' + esc(m.id) + '">删除</button></td>' : '') + '</tr>').join('') +
    '</tbody></table></div>';
}

/* ------------------------------ 使用反馈 ------------------------------ */
function renderFeedback() {
  // 进度是全局真实条数；明细仍按角色隔离（学生看不到他人反馈正文）
  const n = Math.max(S.feedback.length, S.feedbackProgress);
  $('#fb-progress').textContent = n + ' / 8';
  $('#fb-progress-bar').style.width = Math.min(100, n / 8 * 100) + '%';
  if (!can('feedback.list')) return;
  $('#fb-list').innerHTML = S.feedback.length ? S.feedback.map((f) =>
    '<div class="fb-card"><div class="fb-head"><span>' + esc(f.role) + ' · ' + esc(f.module) + '</span>' +
    '<span class="tag ' + (f.score >= 4 ? 'tag-ok' : f.score >= 3 ? 'tag-warn' : 'tag-bad') + '">' + f.score + ' 分</span></div>' +
    (f.task_done ? '<p><b>实际任务：</b>' + esc(f.task_done) + '</p>' : '') +
    (f.liked ? '<p><b>有帮助：</b>' + esc(f.liked) + '</p>' : '') +
    (f.problem ? '<p><b>问题：</b>' + esc(f.problem) + '</p>' : '') +
    (f.suggestion ? '<p><b>建议：</b>' + esc(f.suggestion) + '</p>' : '') +
    (f.reuse ? '<p><b>再用意愿：</b>' + esc(f.reuse) + '</p>' : '') +
    '<p class="muted">' + esc(String(f.created_at).slice(0, 16).replace('T', ' ')) + '</p></div>').join('')
    : '<div class="table-empty">还没有收到反馈，请邀请同学真实试用后填写</div>';
}

/* ---------------------------- 本地离线辅助助手 ---------------------------- */
const AI_SAMPLES = ['最近的截止是什么', '我还有哪些待办没完成', '示波器还有几台',
  '有没有逾期的借用', '今天要复习哪些错题', '你能做什么'];

function aiBubble(role, text, sources) {
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-bot');
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  bubble.textContent = text; // 纯文本写入，绝不拼接 HTML
  wrap.appendChild(bubble);
  if (sources && sources.length) {
    const box = document.createElement('div');
    box.className = 'ai-src';
    const title = document.createElement('b');
    title.textContent = '资料来源（' + sources.length + '）';
    box.appendChild(title);
    const list = document.createElement('ul');
    for (const s of sources) {
      const li = document.createElement('li');
      li.textContent = '[' + (s.type || '记录') + '] ' + (s.title || s.id)
        + (s.field ? ' · ' + s.field : '') + (s.value ? '：' + s.value : '');
      list.appendChild(li);
    }
    box.appendChild(list);
    wrap.appendChild(box);
  }
  const log = $('#ai-log');
  log.appendChild(wrap);
  log.scrollTop = log.scrollHeight;
}

async function askAssistant(q) {
  const question = String(q || '').trim();
  if (!question) return;
  const btn = $('#btn-ai-ask');
  if (btn.disabled) return; // 示例按钮连点时同样防重复提交
  aiBubble('user', question);
  $('#ai-question').value = '';
  btn.disabled = true;
  btn.textContent = '查询中…';
  try {
    const r = await api('assistant/ask', { method: 'POST', body: { question } });
    aiBubble('bot', r.text || '（没有返回内容）', r.sources);
  } catch (err) {
    aiBubble('bot', '查询失败：' + (err.message || '服务未响应'));
  } finally {
    btn.disabled = false;
    btn.textContent = '提问';
    $('#ai-question').focus();
  }
}

function initAssistant() {
  const box = $('#ai-samples');
  for (const s of AI_SAMPLES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn btn-soft btn-sm';
    b.textContent = s;
    b.addEventListener('click', () => askAssistant(s));
    box.appendChild(b);
  }
  $('#btn-ai-ask').addEventListener('click', () => askAssistant($('#ai-question').value));
  $('#ai-question').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); askAssistant($('#ai-question').value); }
  });
}

/* -------------------------------- 事件 -------------------------------- */
function bindEvents() {
  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button.nav-item'); if (btn) switchView(btn.dataset.view);
  });
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (go) switchView(go.dataset.go);
  });

  $('#user-chip').addEventListener('click', (e) => {
    if (e.target.closest('.menu-item')) return;
    $('#user-menu').classList.toggle('open');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#user-chip')) $('#user-menu').classList.remove('open');
  });
  $('#btn-logout').addEventListener('click', guard(async () => {
    await api('auth/logout', { method: 'POST', body: {} });
    window.location.href = '/user/login.html';
  }));
  $('#btn-pass').addEventListener('click', () => {
    $('#user-menu').classList.remove('open');
    $('#pass-modal').classList.add('open');
  });
  $('#btn-pass-cancel').addEventListener('click', () => $('#pass-modal').classList.remove('open'));
  $('#pass-modal').addEventListener('click', (e) => {
    if (e.target.id === 'pass-modal') $('#pass-modal').classList.remove('open');
  });
  $('#form-pass').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    const a = $('#pass-new').value, b = $('#pass-new2').value;
    if (a !== b) { toast('两次输入的新密码不一致', true); return; }
    await api('auth/password', { method: 'POST', body: { old_password: $('#pass-old').value, new_password: a } });
    $('#form-pass').reset(); $('#pass-modal').classList.remove('open'); toast('密码已修改');
  }));

  /* 通知：提取 + 人工审核 */
  $('#notice-input').addEventListener('input', (e) => {
    $('#notice-count').textContent = e.target.value.length;
    // 用户手动改动原文时回到「粘贴」；文件导入触发的合成事件不重置来源
    if (e.isTrusted) {
      S.importType = 'paste';
      $('#import-info').textContent = '手动粘贴 · 未选择文件';
    }
  });
  $('#notice-file').addEventListener('change', (e) => {
    importFile(e.target.files && e.target.files[0]);
    e.target.value = ''; // 允许重复选择同一文件
  });
  const ta = $('#notice-input');
  ta.addEventListener('dragover', (e) => { e.preventDefault(); ta.classList.add('drag-over'); });
  ta.addEventListener('dragleave', () => ta.classList.remove('drag-over'));
  ta.addEventListener('drop', (e) => {
    e.preventDefault(); ta.classList.remove('drag-over');
    importFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
  });
  $('#btn-parse').addEventListener('click', guard(async () => {
    const text = $('#notice-input').value.trim();
    if (!text) { toast('请先粘贴或导入通知内容', true); return; }
    const n = await api('notice/parse', { method: 'POST', body: { text, import_type: S.importType } });
    S.parsed = n; renderParseResult(n); toast('解析完成，置信度 ' + n.confidence + '%，请人工审核');
  }));
  $('#parse-result').addEventListener('click', guard(async (e) => {
    if (e.target.closest('#btn-save-notice')) {
      if (!$('#review-confirm') || !$('#review-confirm').checked) { toast('请先勾选人工审核确认', true); return; }
      const n = {
        ...S.parsed,
        title: ($('#review-title').value || '').trim() || S.parsed.title,
        deadline: $('#review-deadline').value || '',
        remind_minutes: Math.max(0, Math.min(43200, Number($('#review-remind').value) || 0)),
        reviewed: true, reviewed_at: new Date().toISOString(),
      };
      await api('notice/save', { method: 'POST', body: { notice: n } });
      toast('已确认并保存到待办'); refreshView('notice'); switchView('notice');
    } else if (e.target.closest('#btn-ics-preview')) {
      const r = await api('notice/preview', { method: 'POST', body: {
        notice: S.parsed,
        remind_minutes: Math.max(0, Math.min(43200, Number($('#review-remind').value) || 0)),
      } });
      downloadText('campus-notice.ics', r.ics, 'text/calendar;charset=utf-8');
      toast('已导出日历文件（提前 ' + r.remind_minutes + ' 分钟提醒）');
    } else if (e.target.closest('#btn-copy-md')) {
      const n = S.parsed;
      const md = '## ' + n.title + '\n\n- 分类：' + n.category + '\n- 重要程度：' + (n.importance || '普通') +
        '\n- 发布单位：' + (n.issuer || '未识别') + '\n- 时间：' + (n.event_date || '未识别') + ' ' + (n.event_time || '') +
        '\n- 地点：' + (n.location || '未识别') + '\n- 对象：' + (n.audience.join('、') || '未指定') +
        '\n- 截止：' + (n.deadline || '无') + '\n- 联系方式：' + ((n.contact || []).join(' / ') || '未识别') +
        '\n- 所需材料：' + ((n.materials || []).join('、') || '未识别') + '\n\n' +
        n.todos.map((t, i) => (i + 1) + '. [ ] ' + t).join('\n');
      try { await navigator.clipboard.writeText(md); toast('已复制为 Markdown'); }
      catch (_) { downloadText('notice.md', md, 'text/markdown;charset=utf-8'); toast('已导出 Markdown 文件'); }
    } else if (e.target.closest('#btn-reject-notice')) {
      S.parsed = null;
      $('#parse-result').innerHTML = '<div class="empty-v2"><div class="empty-icon"><svg><use href="#i-notice"/></svg></div><b>本次提取结果已拒绝</b><span>可修改原文后重新提取；被拒绝的结果不会写入任何业务数据</span></div>';
      $('#parse-conf').textContent = '等待输入'; $('#parse-conf').className = 'chip';
      toast('已拒绝，未写入任何数据');
    }
  }));

  $('#notice-search').addEventListener('input', (e) => { S.filter.text = e.target.value; renderNoticeList(); });
  $('#notice-filter').addEventListener('change', (e) => { S.filter.category = e.target.value; renderNoticeList(); });
  $('#notice-state').addEventListener('change', (e) => { S.filter.state = e.target.value; renderNoticeList(); });
  $('#notice-list').addEventListener('click', guard(async (e) => {
    const tg = e.target.closest('[data-toggle]'), del = e.target.closest('[data-del-notice]');
    if (tg) { await api('notice/toggle', { method: 'POST', body: { id: tg.dataset.toggle } }); refreshView('notice'); }
    else if (del) { await api('notice/delete', { method: 'DELETE', body: { id: del.dataset.delNotice } }); toast('已删除'); refreshView('notice'); }
  }));

  /* 版本比对：先预览差异，人工确认后才写入（CM-FR-110） */
  $('#btn-revise-preview').addEventListener('click', guard(async () => {
    const id = $('#revise-notice').value, text = $('#revise-text').value.trim();
    if (!id) { toast('请先保存一条通知，再比对新版本', true); return; }
    if (!text) { toast('请粘贴修订后的通知原文', true); return; }
    const r = await api('notice/revise', { method: 'POST', body: { id, text } });
    S.revise = { id, text };
    renderReviseResult(r);
    toast('已生成字段差异，请核对后再确认');
  }));
  $('#btn-revise-apply').addEventListener('click', guard(async () => {
    if (!S.revise) { toast('请先比对字段差异', true); return; }
    const r = await api('notice/revise', { method: 'POST', body: { ...S.revise, apply: true } });
    renderReviseResult(r);
    S.revise = null;
    await refreshView('notice');
    toast('已更新为 v' + r.notice.version + '，旧版本快照已保留');
  }));

  /* 器材 */
  $('#form-loan').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    if (!$('#loan-item').value) { toast('器材清单为空，请先由教师或管理员添加器材', true); return; }
    await api('loan/create', { method: 'POST', body: {
      item_id: $('#loan-item').value, borrower: $('#loan-borrower').value,
      qty: Number($('#loan-qty').value), due_date: $('#loan-due').value, purpose: $('#loan-purpose').value,
    } });
    $('#loan-borrower').value = ''; $('#loan-purpose').value = '';
    toast('借出登记成功，库存已同步'); refreshView('equipment');
  }));
  $('#form-equipment').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('equipment/add', { method: 'POST', body: {
      name: $('#eq-name').value, code: $('#eq-code').value, total: Number($('#eq-total').value),
      category: $('#eq-category').value, model: $('#eq-model').value, location: $('#eq-location').value,
      purchased_at: $('#eq-purchased').value, unit: $('#eq-unit').value, note: $('#eq-note').value,
    } });
    ['#eq-name', '#eq-code', '#eq-model', '#eq-location', '#eq-purchased', '#eq-note'].forEach((s) => { $(s).value = ''; });
    $('#eq-total').value = '1'; toast('器材档案已添加'); refreshView('equipment');
  }));
  $('#eq-grid').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-del-eq]'); if (!b) return;
    await api('equipment/delete', { method: 'DELETE', body: { id: b.dataset.delEq } });
    toast('器材已删除'); refreshView('equipment');
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

  /* 错题 */
  $('#form-mistake').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('mistake/add', { method: 'POST', body: {
      title: $('#ms-title').value, subject: $('#ms-subject').value, knowledge: $('#ms-knowledge').value,
      wrong_reason: $('#ms-reason').value, correct_answer: $('#ms-answer').value,
    } });
    ['#ms-title', '#ms-reason', '#ms-answer'].forEach((s) => { $(s).value = ''; });
    toast('已加入复习队列，明天第一次复习'); refreshView('mistake');
  }));
  $('#due-list').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-review]'); if (!b) return;
    await api('mistake/review', { method: 'POST', body: { id: b.dataset.id, result: b.dataset.review } });
    toast(b.dataset.review === 'ok' ? '已安排下一轮复习' : '已重置为第一轮'); refreshView('mistake');
  }));
  $('#mistake-table').addEventListener('click', guard(async (e) => {
    const b = e.target.closest('[data-del-mistake]'); if (!b) return;
    await api('mistake/delete', { method: 'DELETE', body: { id: b.dataset.delMistake } });
    toast('已删除'); refreshView('mistake');
  }));

  $('#activity-refresh').addEventListener('click', guard(async () => { await refreshView('activity'); toast('已刷新'); }));

  $('#form-feedback').addEventListener('submit', guard(async (e) => {
    e.preventDefault();
    await api('feedback/add', { method: 'POST', body: {
      role: $('#fb-role').value, module: $('#fb-module').value, score: Number($('#fb-score').value),
      task_done: $('#fb-task').value, problem: $('#fb-problem').value,
      liked: $('#fb-liked').value, suggestion: $('#fb-suggestion').value,
      reuse: $('#fb-reuse').value,
    } });
    ['#fb-role', '#fb-task', '#fb-problem', '#fb-liked', '#fb-suggestion', '#fb-reuse']
      .forEach((s) => { $(s).value = ''; });
    toast('感谢反馈，已记录'); refreshView('feedback');
  }));
}

/* ------------------------------ 角色界面 ------------------------------ */
function applyRole() {
  const u = S.user;
  $('#user-name').textContent = u.display_name || u.username;
  $('#user-role').textContent = u.role_label + ' · ' + u.username;
  $('#user-avatar').textContent = (u.display_name || u.username).slice(0, 1);
  $$('.role-only').forEach((el) => {
    const roles = (el.dataset.roles || '').split(',').filter(Boolean);
    el.classList.toggle('hidden', !roles.includes(u.role));
  });
  $('#zero-banner').classList.toggle('hidden', !S.empty);
}

/* -------------------------------- 启动 -------------------------------- */
(async function init() {
  try {
    const me = await api('auth/me');
    S.user = me.user; S.permissions = me.permissions || [];
  } catch (_) { return; }
  bindEvents();
  initAssistant();
  try {
    const [b, a] = await Promise.all([api('bootstrap'), api('activity?days=7')]);
    S.dashboard = b.dashboard; S.notices = b.notices; S.equipment = b.equipment;
    S.mistakes = b.mistakes; S.feedback = b.feedback || []; S.activity = a.items || [];
    S.today = b.today; S.version = b.version; S.empty = b.empty;
    $('#side-version').textContent = S.version.replace(/^v/, '');
    $('#today-text').textContent = S.today;
    $('#loan-due').value = addDays(S.today, 7);
    applyRole();
    renderDashboard(); fillNoticeFilter(); renderNoticeList();
    $('#badge-notice').textContent = b.dashboard.notice.pending;
    $('#badge-loan').textContent = b.dashboard.equipment.overdue;
    $('#badge-mistake').textContent = b.dashboard.mistake.due_today;
  } catch (err) {
    toast('服务未响应：' + err.message + '，请确认 node server.js 正在运行', true);
  }
})();
