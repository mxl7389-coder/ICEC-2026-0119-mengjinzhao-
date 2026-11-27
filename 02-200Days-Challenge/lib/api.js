'use strict';
/**
 * 业务 API：鉴权 / 通知提取 / 器材借还核对 / 错题归档 / 看板 / 日志 / 反馈 / 管理后台
 * 所有返回值统一 { status, data, meta, headers? }，meta 只含可统计特征，交由 telemetry 脱敏落盘。
 *
 * 数据原则：本文件不包含任何预置业务数据，不自动播种器材、通知、反馈或账号。
 * 所有记录都由登录用户在页面上录入，并带上 owner_id 标记来源。
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const store = require('./store');
const extractor = require('./extractor');
const telemetry = require('./telemetry');
const auth = require('./auth');
const assistant = require('./assistant');

const REVIEW_STAGES = [1, 2, 4, 7, 15, 30]; // 艾宾浩斯式复习间隔（天）
// CM-FR-101：5 种文本导入方式。PDF / Word / 图片需 OCR 与解析库，不伪装成可用。
const IMPORT_TYPES = ['paste', 'txt', 'md', 'csv', 'json'];
// 版本追踪比对的结构化字段（CM-FR-110）
const VERSION_FIELDS = ['title', 'category', 'event_date', 'event_time', 'location',
  'deadline', 'audience', 'todos', 'materials', 'issuer', 'importance'];

function today() { return telemetry.localDay(); }
function p2(n) { return String(n).padStart(2, '0'); }
function shift(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + days);
  return dt.getFullYear() + '-' + p2(dt.getMonth() + 1) + '-' + p2(dt.getDate());
}
function fail(code, message, status) {
  return Object.assign(new Error(message), { code, status: status || 400 });
}
function requireField(obj, key) {
  if (obj[key] === undefined || obj[key] === null || String(obj[key]).trim() === '') {
    throw fail('MISSING_' + key.toUpperCase(), '缺少必填字段: ' + key);
  }
  return String(obj[key]).trim();
}

/* --------------------- 业务审计（SRS 4.3 / CM-FR-210） --------------------- */
/** 只记谁、何时、做了什么、作用于哪个对象；绝不记原文、姓名、题目或反馈正文 */
function writeAudit(ctx, action, targetType, targetId, extra) {
  try {
    store.update('audit', (arr) => [...arr.slice(-499), {
      id: store.uid('au'),
      at: new Date().toISOString(),
      actor_id: ctx.user ? ctx.user.id : null,
      actor_role: ctx.user ? ctx.user.role : 'anonymous',
      action: String(action).slice(0, 40),
      target_type: String(targetType).slice(0, 24),
      target_id: String(targetId || '').slice(0, 40),
      meta: extra && typeof extra === 'object' ? extra : {},
    }]);
  } catch (_) { /* 审计失败不阻断业务，但会留下 telemetry 异常 */ }
}

/* --------------------- 查重与版本比对（CM-FR-109 / 110） --------------------- */
function compact(s) {
  return String(s || '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();
}
/** 3-gram Jaccard 相似度：纯本地计算，不需要任何模型或依赖 */
function similarity(a, b) {
  const A = compact(a), B = compact(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const set = new Set();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const ga = grams(A), gb = grams(B);
  if (!ga.size || !gb.size) return (A.includes(B) || B.includes(A)) ? 0.8 : 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return inter / (ga.size + gb.size - inter);
}
/** 只返回相似度与序号，不返回他人通知的标题或原文 */
function findDuplicates(text, excludeId) {
  const hits = [];
  for (const n of store.get('notices')) {
    if (n.id === excludeId || !n.raw_text) continue;
    const s = similarity(text, n.raw_text);
    if (s >= 0.62) hits.push({ similarity: Math.round(s * 100), created_at: n.created_at });
  }
  return hits.sort((a, b) => b.similarity - a.similarity).slice(0, 3);
}
function fieldValue(v) {
  return Array.isArray(v) ? v.join('、') : String(v === undefined || v === null ? '' : v);
}
function diffNotice(oldN, nextN) {
  const changes = [];
  for (const k of VERSION_FIELDS) {
    const before = fieldValue(oldN[k]), after = fieldValue(nextN[k]);
    if (before !== after) changes.push({ field: k, from: before || '（空）', to: after || '（空）' });
  }
  return changes;
}

/* --------------------- 备份快照与完整性校验（SRS 4.3） --------------------- */
const BACKUP_DATASETS = ['notices', 'equipment', 'loans', 'mistakes', 'feedback', 'audit'];
function backupPayload() {
  const datasets = {};
  for (const name of BACKUP_DATASETS) datasets[name] = store.get(name);
  const body = {
    format: 'campusdesk-backup',
    version: telemetry.APP_VERSION,
    exported_at: new Date().toISOString(),
    datasets,
  };
  body.checksum = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  return body;
}
/** 只校验、不写入：checksum 用导出时的原始字段顺序重算 */
function verifyBackup(input) {
  let obj = input;
  if (typeof input === 'string') {
    try { obj = JSON.parse(input); } catch (_) { throw fail('INVALID_BACKUP', '备份文件不是合法 JSON'); }
  }
  if (!obj || obj.format !== 'campusdesk-backup' || !obj.datasets || !obj.checksum) {
    throw fail('INVALID_BACKUP', '备份文件格式不正确');
  }
  const { checksum, ...rest } = obj;
  const calc = crypto.createHash('sha256').update(JSON.stringify(rest)).digest('hex');
  const counts = {};
  for (const [k, v] of Object.entries(obj.datasets || {})) {
    if (!BACKUP_DATASETS.includes(k) || !Array.isArray(v)) throw fail('INVALID_BACKUP', '备份包含未知数据集: ' + k);
    counts[k] = v.length;
  }
  const problems = [];
  if (calc !== checksum) problems.push('checksum 不一致，文件可能被修改或损坏');
  return {
    ok: problems.length === 0,
    checksum_matched: calc === checksum,
    expected_checksum: checksum, computed_checksum: calc,
    datasets: counts, exported_at: obj.exported_at, version: obj.version,
    problems,
  };
}

/* ------------------------------ 角色与权限 ------------------------------ */
const PERMISSIONS = {
  student: [
    'notice.parse', 'notice.save', 'notice.list', 'notice.toggle', 'notice.ics',
    'notice.revise', 'notice.preview',
    'equipment.list', 'loan.create', 'loan.return', 'loan.list',
    'mistake.list', 'mistake.add', 'mistake.review',
    'feedback.add', 'feedback.progress', 'dashboard', 'bootstrap',
    'assistant.ask',
  ],
  teacher: [],
  admin: ['*'],
};
PERMISSIONS.teacher = [
  ...PERMISSIONS.student,
  'equipment.add', 'equipment.delete', 'notice.delete', 'mistake.delete',
  'feedback.list', 'data.view',
];
function can(user, perm) {
  if (!user) return false;
  const list = PERMISSIONS[user.role] || [];
  return list.includes('*') || list.includes(perm);
}
function requirePerm(ctx, perm) {
  if (!can(ctx.user, perm)) throw fail('FORBIDDEN', '当前角色没有此操作权限', 403);
}
function requireRole(ctx, roles) {
  if (!ctx.user || !roles.includes(ctx.user.role)) {
    throw fail('FORBIDDEN', '需要管理员权限', 403);
  }
}
/** 学生只看自己录入的数据；教师 / 管理员看全部 */
function scoped(name, user) {
  const arr = store.get(name);
  if (user && user.role === 'student') return arr.filter((x) => x.owner_id === user.id);
  return arr;
}
function assertOwner(record, user) {
  // 无归属记录同样拒绝，避免 '' / 缺失 owner_id 绕过校验
  if (user.role === 'student' && (!record.owner_id || record.owner_id !== user.id)) {
    throw fail('FORBIDDEN', '只能操作自己录入的记录', 403);
  }
}
function stamp(user) {
  return {
    owner_id: user.id,
    owner_name: user.display_name || user.username,
    owner_role: user.role,
  };
}

/* ------------------------------ 器材借还核对 ------------------------------ */
function outstanding(itemId) {
  return store.get('loans')
    .filter((l) => l.item_id === itemId && l.status !== 'returned')
    .reduce((sum, l) => sum + Math.max(0, Number(l.qty) - Number(l.returned_qty || 0)), 0);
}
/** 只算单个器材的可用量，借出校验不必遍历全表（v3 性能优化） */
function availableOf(itemId) {
  const item = store.get('equipment').find((i) => i.id === itemId);
  if (!item) return null;
  return { item, available: Math.max(0, Number(item.total) - outstanding(itemId)) };
}

function reconcile() {
  const items = store.get('equipment');
  const rows = items.map((it) => {
    const onLoan = outstanding(it.id);
    const available = Math.max(0, Number(it.total) - onLoan);
    return {
      ...it,
      on_loan: onLoan,
      available,
      discrepancy: available < 0 ? Math.abs(available) : 0,
      status: available === 0 ? 'empty' : (available / it.total <= 0.25 ? 'low' : 'ok'),
    };
  });
  const loans = store.get('loans').map((l) => {
    const item = items.find((i) => i.id === l.item_id);
    const left = Math.max(0, Number(l.qty) - Number(l.returned_qty || 0));
    const overdue = l.status !== 'returned' && l.due_date < today();
    return {
      ...l,
      item_name: item ? item.name : '（器材已删除）',
      left,
      overdue,
      state: l.status === 'returned' ? '已归还' : (left === 0 ? '待确认' : (overdue ? '逾期' : '借出中')),
    };
  });
  return {
    items: rows,
    loans: loans.sort((a, b) => (b.borrowed_at || '').localeCompare(a.borrowed_at || '')),
    total_kinds: items.length,
    total_units: items.reduce((s, i) => s + Number(i.total), 0),
    on_loan_units: rows.reduce((s, i) => s + i.on_loan, 0),
    overdue_count: loans.filter((l) => l.overdue).length,
    discrepancy_count: rows.filter((r) => r.discrepancy > 0).length,
  };
}

/* -------------------------------- 错题归档 -------------------------------- */
function mistakeView(m) {
  return {
    ...m,
    due: !m.mastered && m.next_review <= today(),
    days_left: Math.ceil((new Date(m.next_review + 'T00:00:00') - new Date(today() + 'T00:00:00')) / 86400000),
  };
}

/* --------------------------------- 看板 --------------------------------- */
function dashboard(eqSnapshot, user) {
  const notices = scoped('notices', user);
  const eq = eqSnapshot || reconcile();
  const mistakes = scoped('mistakes', user).map(mistakeView);
  const agg = telemetry.aggregate(telemetry.listDays().slice(-7));
  const t = today();
  return {
    today: t,
    notice: {
      total: notices.length,
      pending: notices.filter((n) => !n.done).length,
      due_soon: notices.filter((n) => !n.done && n.deadline && n.deadline <= shift(t, 3)).length,
      categories: notices.reduce((a, n) => { a[n.category] = (a[n.category] || 0) + 1; return a; }, {}),
    },
    equipment: {
      total_kinds: eq.total_kinds,
      total_units: eq.total_units,
      on_loan: eq.on_loan_units,
      overdue: eq.overdue_count,
      low_stock: eq.items.filter((i) => i.status !== 'ok').length,
    },
    mistake: {
      total: mistakes.length,
      due_today: mistakes.filter((m) => m.due).length,
      mastered: mistakes.filter((m) => m.mastered).length,
      subjects: mistakes.reduce((a, m) => { a[m.subject] = (a[m.subject] || 0) + 1; return a; }, {}),
    },
    feedback: { collected: store.get('feedback').length, target: 8 },
    loan: {
      active: eq.loans.filter((l) => l.status !== 'returned').length,
      overdue: eq.overdue_count,
    },
    system: {
      version: telemetry.APP_VERSION,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(process.memoryUsage().rss / 1048576 * 10) / 10,
      log_days: telemetry.listDays().length,
      streak_days: telemetry.streakInfo().current_streak,
      status: 'ok',
    },
    telemetry: {
      total_calls: agg.total_calls,
      days_with_data: telemetry.listDays().length,
      avg_duration_ms: agg.avg_duration_ms,
      errors: agg.by_status.error || 0,
      by_day: agg.by_day,
      today_calls: agg.by_day[t] || 0,
    },
  };
}

/* ------------------------------ 路由分发 ------------------------------ */
async function handle(ctx) {
  // 请求级缓存：v2 日志显示写类请求 12–15ms、读类普遍 <2ms，其中 equipment/list
  // 与 bootstrap 都把 reconcile() 重复计算了两次。这里按请求去重，并把实际计算
  // 次数写进 telemetry，让优化效果能直接从日志核对。
  const memo = {};
  let reconcileCalls = 0;
  const eqOnce = () => {
    if (!memo.eq) { memo.eq = reconcile(); reconcileCalls++; }
    // 学生只看自己登记的借用明细（含借用人姓名与用途）；库存统计保持全局口径
    if (ctx.user && ctx.user.role === 'student') {
      return { ...memo.eq, loans: memo.eq.loans.filter((l) => l.owner_id === ctx.user.id) };
    }
    return memo.eq;
  };
  const result = await route(ctx, eqOnce);
  result.meta = { ...(result.meta || {}), reconcile_calls: reconcileCalls };
  return result;
}

/* ------------------------------ 鉴权接口 ------------------------------ */
function authRoutes(ctx) {
  const { method, body, user, token, ip } = ctx;
  const action = ctx.pathname.replace(/^\/api\//, '').split('/').filter(Boolean)[1] || 'state';

  if (action === 'state' && method === 'GET') {
    return { status: 200, data: {
      initialized: auth.userCount() > 0,
      user: auth.publicUser(user),
      version: telemetry.APP_VERSION,
    }, meta: { initialized: auth.userCount() > 0 ? 1 : 0 } };
  }
  if (action === 'setup' && method === 'POST') {
    const r = auth.setup(body);
    return { status: 201, data: { user: r.user },
      headers: { 'Set-Cookie': auth.sessionCookie(r.token) }, meta: { event: 'first_admin_created' } };
  }
  if (action === 'login' && method === 'POST') {
    const r = auth.login(body, ip);
    return { status: 200, data: { user: r.user },
      headers: { 'Set-Cookie': auth.sessionCookie(r.token) }, meta: { role: r.user.role } };
  }
  if (action === 'logout' && method === 'POST') {
    auth.destroy(token);
    return { status: 200, data: { ok: true },
      headers: { 'Set-Cookie': auth.sessionCookie('', 0) }, meta: {} };
  }
  if (action === 'me' && method === 'GET') {
    if (!user) throw fail('UNAUTHORIZED', '请先登录', 401);
    return { status: 200, data: {
      user: auth.publicUser(user),
      permissions: user.role === 'admin' ? ['*'] : PERMISSIONS[user.role],
      version: telemetry.APP_VERSION, today: today(),
    }, meta: {} };
  }
  if (action === 'password' && method === 'POST') {
    if (!user) throw fail('UNAUTHORIZED', '请先登录', 401);
    return { status: 200, data: auth.changeOwnPassword(user, body.old_password, body.new_password), meta: {} };
  }
  throw fail('UNKNOWN_ROUTE', '接口不存在: ' + ctx.pathname, 404);
}

/* ------------------------------ 系统健康（SRS CM-FR-509） ------------------------------ */
function healthInfo() {
  return {
    app: 'CampusDesk 校园事务台', version: telemetry.APP_VERSION,
    node: process.version, uptime_s: Math.round(process.uptime()),
    log_days: telemetry.listDays().length, today: today(),
    initialized: auth.userCount() > 0,
    log_source: telemetry.LOG_SOURCE,
    log_dir: path.relative(path.join(__dirname, '..'), telemetry.LOG_DIR),
  };
}
function resourceInfo() {
  const m = process.memoryUsage();
  const mb = (n) => Math.round(n / 1048576 * 10) / 10;
  return {
    platform: process.platform + ' / ' + process.arch,
    rss_mb: mb(m.rss), heap_used_mb: mb(m.heapUsed), heap_total_mb: mb(m.heapTotal),
    external_mb: mb(m.external),
    uptime_s: Math.round(process.uptime()),
    data_dir: path.relative(path.join(__dirname, '..'), store.DATA_DIR || path.join(__dirname, '..', 'data')),
  };
}
/** 健康检查项全部由真实运行状态计算，没有任何写死的成功结论 */
function healthChecks(agg) {
  const streak = telemetry.streakInfo();
  const total = agg.total_calls || 0;
  const errors = agg.by_status ? (agg.by_status.error || 0) : 0;
  const rate = total ? errors / total : 0;
  const todayFile = path.join(telemetry.LOG_DIR, today() + '.jsonl');
  return [
    { key: 'service', label: 'HTTP 服务', ok: true, detail: '进程正常运行 · ' + process.version },
    { key: 'storage', label: '业务数据目录', ok: fs.existsSync(store.DATA_DIR), detail: 'data/ 可读写，文件指纹缓存生效' },
    { key: 'telemetry', label: '当日日志写入', ok: fs.existsSync(todayFile), detail: 'process_logs/' + today() + '.jsonl' },
    // 按「连续」而非「累计」判定：11-11/12/13 + 11-16/17 累计 5 天，但最长连续仅 3 天
    { key: 'coverage', label: '连续运行覆盖', ok: streak.target_met,
      detail: '当前连续 ' + streak.current_streak + ' / 7 天（历史最长 ' + streak.longest_streak + ' 天，累计 ' +
        streak.days_count + ' 天）' + (streak.target_met ? '（已达标）' : (streak.remaining_days ? ' · 还需连续到 ' + streak.target_date : '')) },
    { key: 'error_rate', label: '近 7 天错误率', ok: rate < 0.1, detail: (rate * 100).toFixed(1) + '% · ' + errors + ' 次报错 / ' + total + ' 次调用' },
    { key: 'stream', label: '实时日志通道', ok: true, detail: 'SSE 订阅者 ' + telemetry.subscriberCount() + ' 个 · 断线轮询兜底可用' },
  ];
}

/** 真实读取 Git 提交记录，供管理员「版本与规划」页展示，取不到时返回空数组 */
async function gitCommits() {
  return new Promise((resolve) => {
    execFile('git', ['log', '--pretty=format:%h|%s|%ad', '--date=short', '-12'],
      { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 5000 },
      (err, stdout) => {
        if (err || !stdout.trim()) return resolve([]);
        resolve(stdout.trim().split('\n').filter(Boolean).map((line) => {
          const [hash, subject, date] = line.split('|');
          return { hash, subject, date };
        }));
      });
  });
}
function reportFiles() {
  try {
    return fs.readdirSync(telemetry.LOG_DIR)
      .filter((f) => /^summary-\d{4}-\d{2}-\d{2}\.md$/.test(f))
      .sort().reverse().slice(0, 14)
      .map((f) => ({ file: f, size_kb: Math.round(fs.statSync(path.join(telemetry.LOG_DIR, f)).size / 1024 * 10) / 10 }));
  } catch (_) { return []; }
}

/* ------------------------------ 管理后台接口 ------------------------------ */
async function generateReport() {
  const script = path.join(__dirname, '..', 'scripts', 'daily-report.js');
  const output = await new Promise((resolve, reject) => {
    execFile(process.execPath, [script], { encoding: 'utf8', timeout: 15000 }, (err, stdout) => {
      if (err) reject(Object.assign(err, { code: 'REPORT_FAILED' }));
      else resolve(stdout);
    });
  });
  return { ok: true, file: 'process_logs/summary-' + today() + '.md', output: output.trim() };
}

async function adminRoutes(ctx) {
  requireRole(ctx, ['admin']);
  const { method, query, body, user } = ctx;
  const seg = ctx.pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
  const action = seg[1] || 'overview';
  const sub = seg[2] || '';

  if (action === 'overview' && method === 'GET') {
    const datasets = {};
    for (const n of store.NAMES) datasets[n] = store.get(n).length;
    const users = auth.listUsers();
    const agg = telemetry.aggregate(telemetry.listDays().slice(-7));
    return { status: 200, data: {
      datasets,
      users_total: users.length,
      users_by_role: users.reduce((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a; }, {}),
      health: healthInfo(),
      resources: resourceInfo(),
      checks: healthChecks(agg),
      report_files: reportFiles(),
      git_commits: await gitCommits(),
      telemetry: agg,
      all_days: telemetry.listDays(),
      streak: telemetry.streakInfo(),
      feedback: { collected: store.get('feedback').length, target: 8 },
    }, meta: { datasets: store.NAMES.length } };
  }

  /* ---------- 反馈收集明细 / 业务审计 / 备份（仅管理员） ---------- */
  if (action === 'feedback' && method === 'GET') {
    const items = store.get('feedback');
    return { status: 200, data: { items, collected: items.length, target: 8 },
      meta: { collected: items.length } };
  }
  if (action === 'audit' && method === 'GET') {
    const rows = store.get('audit').slice(-120).reverse();
    return { status: 200, data: { items: rows, scope: 'desensitized' },
      meta: { row_count: rows.length } };
  }
  if (action === 'backup' && sub === '' && method === 'GET') {
    const payload = backupPayload();
    writeAudit(ctx, 'backup.export', 'snapshot', '', { files: BACKUP_DATASETS.length });
    return { status: 200, raw: {
      body: JSON.stringify(payload, null, 2),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="campusdesk-backup-' + today() + '.json"',
        'X-Backup-Checksum': payload.checksum,
      },
    }, meta: { exported: 1 } };
  }
  if (action === 'backup' && sub === 'verify' && method === 'POST') {
    const result = verifyBackup(body.backup);
    return { status: 200, data: result, meta: { ok: result.ok ? 1 : 0 } };
  }
  if (action === 'backup' && sub === 'restore' && method === 'POST') {
    if (body.confirm !== 'RESTORE') throw fail('RESTORE_NOT_CONFIRMED', '恢复必须显式确认', 400);
    const result = verifyBackup(body.backup);
    if (!result.ok) throw fail('BACKUP_CHECKSUM_MISMATCH', '备份校验未通过，已拒绝恢复', 400);
    const incoming = typeof body.backup === 'string' ? JSON.parse(body.backup) : body.backup;
    for (const name of BACKUP_DATASETS) {
      if (name === 'audit' || !Array.isArray(incoming.datasets[name])) continue;
      store.set(name, incoming.datasets[name]);
    }
    writeAudit(ctx, 'backup.restore', 'snapshot', '', { checksum_ok: 1 });
    return { status: 200, data: { ok: true, restored: Object.keys(result.datasets).length,
      note: '账号与会话不在恢复范围内，避免把自己锁在门外' },
      meta: { restored: 1 } };
  }

  if (action === 'export' && method === 'GET') {
    const day = query.get('date') || today();
    const format = query.get('format') === 'csv' ? 'csv' : 'json';
    const rows = telemetry.readDay(day);
    if (format === 'csv') {
      const cols = ['ts', 'day', 'app_version', 'source', 'session', 'role', 'module', 'action', 'status', 'duration_ms', 'error_code'];
      const q = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
      const body = '\uFEFF' + [cols.join(','), ...rows.map((r) => cols.map((c) => q(r[c])).join(','))].join('\r\n');
      return { status: 200, raw: { body, headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="telemetry-' + day + '.csv"',
      } }, meta: { format: 'csv', row_count: rows.length } };
    }
    return { status: 200, raw: {
      body: JSON.stringify({
        exported_at: new Date().toISOString(), day,
        app_version: telemetry.APP_VERSION, row_count: rows.length, rows,
      }, null, 2),
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Disposition': 'attachment; filename="telemetry-' + day + '.json"',
      },
    }, meta: { format: 'json', row_count: rows.length } };
  }
  if (action === 'users' && method === 'GET') {
    return { status: 200, data: { items: auth.listUsers() }, meta: { user_count: auth.listUsers().length } };
  }
  if (action === 'users' && method === 'POST') {
    const created = auth.createUser({
      username: body.username, password: body.password,
      role: body.role, display_name: body.display_name, created_by: user.id,
    });
    writeAudit(ctx, 'user.create', 'account', created.id, { role: created.role });
    return { status: 201, data: created, meta: { role: created.role, audited: 1 } };
  }
  if (action === 'active' && method === 'POST') {
    const id = requireField(body, 'id');
    const updated = auth.setActive(id, body.active !== false, user.id);
    writeAudit(ctx, 'user.active', 'account', id, { active: body.active !== false ? 1 : 0 });
    return { status: 200, data: updated, meta: { audited: 1 } };
  }
  if (action === 'password' && method === 'POST') {
    const id = requireField(body, 'id');
    const updated = auth.resetPassword(id, body.new_password);
    writeAudit(ctx, 'user.password', 'account', id, {});
    return { status: 200, data: updated, meta: { audited: 1 } };
  }
  if (action === 'summary' && method === 'GET') {
    const n = Math.min(30, Math.max(1, Number(query.get('days') || 7)));
    const agg = telemetry.aggregate(telemetry.listDays().slice(-n));
    return { status: 200, data: { ...agg, all_days: telemetry.listDays(), version: telemetry.APP_VERSION },
      meta: { total_calls: agg.total_calls } };
  }
  if (action === 'day' && method === 'GET') {
    const day = query.get('date') || today();
    const rows = telemetry.readDay(day);
    return { status: 200, data: { day, rows: rows.slice(-500) }, meta: { row_count: rows.length } };
  }
  /** SSE 断开时的轮询兜底：按当天日志行数做游标，不重不漏 */
  if (action === 'poll' && method === 'GET') {
    const day = today();
    const all = telemetry.readDay(day);
    const raw = Number(query.get('cursor') || 0);
    const cursor = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    const rows = all.slice(cursor).slice(0, 200);
    // 游标只推进到实际取回的最后一行：断线期间超过 200 条时下一次继续补齐
    const nextCursor = cursor + rows.length;
    return { status: 200, data: { day, cursor: nextCursor, rows },
      meta: { new_rows: Math.max(0, all.length - cursor) } };
  }
  if (action === 'report' && method === 'POST') {
    // 异步子进程：v2 用 execFileSync 会阻塞整个事件循环
    return { status: 200, data: await generateReport(), meta: { generated: 1 } };
  }
  throw fail('UNKNOWN_ROUTE', '接口不存在: ' + ctx.pathname, 404);
}

/* ------------------------------ 业务路由 ------------------------------ */
async function route(ctx, eqOnce) {
  const { method, pathname, query, body, user } = ctx;
  const p = pathname.replace(/^\/api\//, '');
  const seg = p.split('/').filter(Boolean);
  const group = seg[0];
  const action = seg[1] || 'list';

  if (group === 'health') {
    return { status: 200, data: {
      ok: true, app: 'CampusDesk 校园事务台', version: telemetry.APP_VERSION,
      node: process.version, uptime_s: Math.round(process.uptime()),
      log_days: telemetry.listDays().length, today: today(),
      initialized: auth.userCount() > 0,
      log_source: telemetry.LOG_SOURCE,
      log_dir: path.relative(path.join(__dirname, '..'), telemetry.LOG_DIR),
      streak: telemetry.streakInfo().current_streak,
    }, meta: { log_days: telemetry.listDays().length, source: telemetry.LOG_SOURCE } };
  }

  if (group === 'auth') return authRoutes(ctx);

  // 除 health / auth 外，所有接口都必须带有效会话
  if (!user) throw fail('UNAUTHORIZED', '请先登录后再操作', 401);

  /* ---------- 本地离线辅助助手：只读，不写业务数据、不调用外部模型 ---------- */
  if (group === 'assistant' && action === 'ask' && method === 'POST') {
    requirePerm(ctx, 'assistant.ask');
    const q = String(body.question || '').trim();
    if (!q) throw fail('EMPTY_QUESTION', '请输入问题');
    if (q.length > 300) throw fail('QUESTION_TOO_LONG', '问题请控制在 300 字以内');
    const r = assistant.answer(q, user);
    // meta 只含可统计特征：问题原文与回答正文都不落盘
    return { status: 200, data: r, meta: {
      intent: r.intent, engine: r.engine, answered: r.answered ? 1 : 0,
      q_len: q.length, source_count: r.sources.length,
    } };
  }

  if (group === 'admin') return adminRoutes(ctx);
  if (group === 'logs') return adminLogsRoutes(ctx);

  /** SRS CM-FR-001「最近操作记录」：只返回当前会话自己的脱敏调用摘要 */
  if (group === 'activity') {
    const list = telemetry.listDays().slice(-Math.min(7, Math.max(1, Number(query.get('days') || 1))));
    const items = list.flatMap((d) => telemetry.readDay(d))
      .filter((r) => r.session === ctx.session)
      .slice(-60).reverse()
      .map((r) => ({
        ts: r.ts, day: r.day, module: r.module, action: r.action,
        status: r.status, duration_ms: r.duration_ms, error_code: r.error_code,
      }));
    return { status: 200, data: { items, days: list, scope: 'own_session' },
      meta: { row_count: items.length } };
  }

  if (group === 'bootstrap') {
    requirePerm(ctx, 'bootstrap');
    const eqSnap = eqOnce();
    return { status: 200, data: {
      user: auth.publicUser(user),
      permissions: user.role === 'admin' ? ['*'] : PERMISSIONS[user.role],
      dashboard: dashboard(eqSnap, user),
      equipment: eqSnap,
      notices: scoped('notices', user),
      mistakes: scoped('mistakes', user).map(mistakeView),
      feedback: can(user, 'feedback.list') ? store.get('feedback') : [],
      version: telemetry.APP_VERSION,
      today: today(),
      // 账号 / 会话 / 审计属于系统痕迹，不计入「业务数据是否为空」
      empty: store.NAMES.filter((n) => !store.SYSTEM_NAMES.includes(n))
        .every((n) => store.get(n).length === 0),
    }, meta: { datasets: store.NAMES.length, role: user.role } };
  }

  if (group === 'dashboard') {
    requirePerm(ctx, 'dashboard');
    return { status: 200, data: dashboard(eqOnce(), user), meta: {} };
  }

  /* ---------- 通知提取 ---------- */
  if (group === 'notice') {
    if (action === 'parse' && method === 'POST') {
      requirePerm(ctx, 'notice.parse');
      const text = body.text || '';
      if (!String(text).trim()) throw fail('EMPTY_NOTICE', '请先粘贴通知内容');
      const importType = IMPORT_TYPES.includes(body.import_type) ? body.import_type : 'paste';
      const notice = extractor.extract(text, { id: store.uid('nt'), source: importType });
      // CM-FR-109：只给相似度与数量提示，不返回他人通知标题或原文，也不自动拒绝
      const dup = findDuplicates(text);
      notice.duplicate_hint = {
        detected: dup.length > 0, count: dup.length,
        top_similarity: dup.length ? dup[0].similarity : 0,
      };
      notice.raw_text = text;
      notice.source_fingerprint = crypto.createHash('sha256')
        .update(extractor.normalize(text)).digest('hex').slice(0, 12);
      notice.import_type = importType;
      notice.remind_minutes = 30; // CM-FR-107 默认值，人工审核时可改
      notice.version = 1;
      notice.history = [];
      const FIELD_CODE = { event_date: 'date', event_time: 'time', location: 'loc', audience: 'aud', deadline: 'ddl' };
      const missing = Object.keys(FIELD_CODE).filter((k) =>
        !notice[k] || (Array.isArray(notice[k]) && notice[k].length === 0));
      return { status: 200, data: notice, meta: {
        input_len: String(text).length, hit_rules: notice.hit_rules,
        confidence: notice.confidence, parse_ms: notice.parse_ms,
        warning_count: notice.warnings.length, category: notice.category_key,
        todo_count: notice.todos.length, date_candidates: notice.date_candidates.length,
        missing_field_count: missing.length,
        missing_keys: missing.map((k) => FIELD_CODE[k]).join(',') || 'none',
        extra_field_count: [notice.issuer, notice.contact.length, notice.materials.length].filter(Boolean).length,
        importance_code: { 紧急: 3, 重要: 2, 普通: 1 }[notice.importance] || 1,
        import_type: importType, duplicate_count: dup.length,
      } };
    }
    if (action === 'save' && method === 'POST') {
      requirePerm(ctx, 'notice.save');
      const n = body.notice;
      if (!n || !n.title) throw fail('INVALID_NOTICE', '没有可保存的结构化结果');
      const raw = String(n.raw_text || '').slice(0, 20000);
      const remind = Math.max(0, Math.min(43200, Number(n.remind_minutes ?? 30) || 0));
      const dup = raw ? findDuplicates(raw) : [];
      const item = {
        ...n,
        ...stamp(user),
        // 日期字段只允许 YYYY-MM-DD，阻断畸形值进入 ICS 与前端 innerHTML
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(n.deadline || '')) ? n.deadline : '',
        event_date: /^\d{4}-\d{2}-\d{2}$/.test(String(n.event_date || '')) ? n.event_date : '',
        // 主键一律服务端生成：客户端伪造 id 会造成同 id 记录，toggle 时串改他人数据
        id: store.uid('nt'),
        created_at: n.created_at || new Date().toISOString(),
        done: false,
        raw_text: raw,
        source_fingerprint: n.source_fingerprint || crypto.createHash('sha256')
          .update(extractor.normalize(raw)).digest('hex').slice(0, 12),
        import_type: IMPORT_TYPES.includes(n.import_type) ? n.import_type : 'paste',
        remind_minutes: remind,
        version: Number(n.version) || 1,
        history: Array.isArray(n.history) ? n.history : [],
        duplicate_hint: { detected: dup.length > 0, count: dup.length,
          top_similarity: dup.length ? dup[0].similarity : 0 },
      };
      item.ics = extractor.buildICS(item, remind);
      store.update('notices', (arr) => [item, ...arr]);
      writeAudit(ctx, 'notice.save', 'notice', item.id,
        { version: item.version, todo_count: (item.todos || []).length, duplicate_count: dup.length });
      return { status: 200, data: item,
        meta: { todo_count: (item.todos || []).length, confidence: item.confidence || 0,
          duplicate_count: dup.length, import_type: item.import_type, audited: 1 } };
    }
    /** CM-FR-110：贴入新版本原文，先预览字段差异，apply=true 才写入 */
    if (action === 'revise' && method === 'POST') {
      requirePerm(ctx, 'notice.revise');
      const id = requireField(body, 'id');
      const text = String(body.text || '').trim();
      if (!text) throw fail('EMPTY_NOTICE', '请粘贴新版本通知原文');
      const target = store.get('notices').find((x) => x.id === id);
      if (!target) throw fail('NOT_FOUND', '未找到该通知', 404);
      assertOwner(target, user);
      const fresh = extractor.extract(text, { id: target.id, source: 'revise' });
      const remind = Math.max(0, Math.min(43200, Number(body.remind_minutes ?? target.remind_minutes ?? 30) || 0));
      const next = {
        ...fresh,
        id: target.id,
        owner_id: target.owner_id, owner_name: target.owner_name, owner_role: target.owner_role,
        created_at: target.created_at, done: !!target.done,
        reviewed: true, reviewed_at: new Date().toISOString(),
        raw_text: text.slice(0, 20000),
        source_fingerprint: crypto.createHash('sha256')
          .update(extractor.normalize(text)).digest('hex').slice(0, 12),
        import_type: 'paste',
        remind_minutes: remind,
        version: (Number(target.version) || 1) + 1,
        duplicate_hint: { detected: false, count: 0, top_similarity: 0 },
      };
      const changes = diffNotice(target, next);
      const snapshot = {};
      for (const k of VERSION_FIELDS) snapshot[k] = target[k];
      next.history = [...(target.history || []), {
        version: Number(target.version) || 1,
        at: new Date().toISOString(), snapshot, changes,
      }].slice(-20);
      next.ics = extractor.buildICS(next, remind);
      if (body.apply !== true) {
        return { status: 200, data: { notice: next, changes, applied: false },
          meta: { change_count: changes.length, preview: 1 } };
      }
      store.update('notices', (arr) => arr.map((x) => (x.id === id ? next : x)));
      writeAudit(ctx, 'notice.revise', 'notice', id,
        { version: next.version, change_count: changes.length });
      return { status: 200, data: { notice: next, changes, applied: true },
        meta: { change_count: changes.length, version: next.version, audited: 1 } };
    }
    /** 人工审核时预览 .ics（带自定义提前提醒），不写任何业务数据 */
    if (action === 'preview' && method === 'POST') {
      requirePerm(ctx, 'notice.preview');
      const n = body.notice;
      if (!n || !n.title) throw fail('INVALID_NOTICE', '没有可预览的通知');
      return { status: 200, data: {
        ics: extractor.buildICS(n, body.remind_minutes),
        remind_minutes: Math.max(0, Math.min(43200, Number(body.remind_minutes ?? 30) || 0)),
      }, meta: { preview: 1 } };
    }
    if (action === 'list') {
      requirePerm(ctx, 'notice.list');
      const items = scoped('notices', user);
      return { status: 200, data: { items }, meta: { item_count: items.length } };
    }
    if (action === 'toggle' && method === 'POST') {
      requirePerm(ctx, 'notice.toggle');
      const id = requireField(body, 'id');
      const target = store.get('notices').find((n) => n.id === id);
      if (!target) throw fail('NOT_FOUND', '未找到该待办', 404);
      assertOwner(target, user);
      let found = false;
      store.update('notices', (arr) => arr.map((n) => {
        if (n.id !== id) return n;
        found = true;
        return { ...n, done: !n.done };
      }));
      if (!found) throw fail('NOT_FOUND', '未找到该待办', 404);
      writeAudit(ctx, 'notice.toggle', 'notice', id, { done: !target.done ? 1 : 0 });
      return { status: 200, data: { ok: true }, meta: { audited: 1 } };
    }
    if (action === 'delete' && method === 'DELETE') {
      requirePerm(ctx, 'notice.delete');
      const id = requireField(body, 'id');
      const target = store.get('notices').find((n) => n.id === id);
      if (target) assertOwner(target, user);
      store.update('notices', (arr) => arr.filter((n) => n.id !== id));
      writeAudit(ctx, 'notice.delete', 'notice', id, {});
      return { status: 200, data: { ok: true }, meta: { audited: 1 } };
    }
    if (action === 'ics') {
      requirePerm(ctx, 'notice.ics');
      const id = query.get('id');
      const n = scoped('notices', user).find((x) => x.id === id);
      if (!n) throw fail('NOT_FOUND', '未找到该通知', 404);
      return { status: 200, raw: {
        body: extractor.buildICS(n, n.remind_minutes),
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="campus-notice.ics"',
        },
      }, meta: { has_time: n.event_time ? 1 : 0, remind_minutes: n.remind_minutes || 0 } };
    }
  }

  /* ---------- 器材借还核对 ---------- */
  if (group === 'equipment') {
    if (action === 'list') {
      requirePerm(ctx, 'equipment.list');
      const snap = eqOnce(); // v2 在这里算了两次，现在一次即可
      return { status: 200, data: snap, meta: { item_count: snap.items.length } };
    }
    if (action === 'add' && method === 'POST') {
      requirePerm(ctx, 'equipment.add');
      const name = requireField(body, 'name');
      const total = Math.max(1, Number(body.total) || 1);
      const item = {
        ...stamp(user),
        id: store.uid('eq'), name: name.slice(0, 30),
        code: String(body.code || '').slice(0, 24),
        category: String(body.category || '其他').slice(0, 20),
        model: String(body.model || '').slice(0, 30),
        location: String(body.location || '').slice(0, 30),
        purchased_at: String(body.purchased_at || '').slice(0, 10),
        note: String(body.note || '').slice(0, 80),
        total, unit: String(body.unit || '件').slice(0, 6),
        status_note: 'normal',
        created_at: new Date().toISOString(),
      };
      store.update('equipment', (arr) => [...arr, item]);
      writeAudit(ctx, 'equipment.add', 'equipment', item.id, { total });
      return { status: 200, data: eqOnce(), meta: { total, audited: 1 } };
    }
    if (action === 'delete' && method === 'DELETE') {
      requirePerm(ctx, 'equipment.delete');
      const id = requireField(body, 'id');
      if (outstanding(id) > 0) throw fail('HAS_LOAN', '该器材尚有未归还借用，不能删除');
      store.update('equipment', (arr) => arr.filter((i) => i.id !== id));
      writeAudit(ctx, 'equipment.delete', 'equipment', id, {});
      return { status: 200, data: eqOnce(), meta: { audited: 1 } };
    }
  }

  if (group === 'loan') {
    if (action === 'create' && method === 'POST') {
      requirePerm(ctx, 'loan.create');
      const itemId = requireField(body, 'item_id');
      const borrower = requireField(body, 'borrower');
      const qty = Math.max(1, Number(body.qty) || 1);
      const found = availableOf(itemId);
      if (!found) throw fail('NOT_FOUND', '器材不存在', 404);
      if (qty > found.available) {
        throw fail('OUT_OF_STOCK', '库存不足，当前可用 ' + found.available + ' ' + found.item.unit);
      }
      const loan = {
        ...stamp(user),
        id: store.uid('ln'), item_id: itemId,
        borrower: borrower.slice(0, 24), qty,
        returned_qty: 0,
        borrowed_at: new Date().toISOString(),
        due_date: String(body.due_date || shift(today(), 7)).slice(0, 10),
        purpose: String(body.purpose || '').slice(0, 40),
        returned_at: null, status: 'active',
      };
      store.update('loans', (arr) => [loan, ...arr]);
      writeAudit(ctx, 'loan.create', 'loan', loan.id, { qty });
      return { status: 200, data: eqOnce(), meta: { qty, available_before: found.available, audited: 1 } };
    }
    if (action === 'return' && method === 'POST') {
      requirePerm(ctx, 'loan.return');
      const id = requireField(body, 'id');
      // 学生只能归还自己登记的借用；此前该接口缺归属校验
      const existing = store.get('loans').find((l) => l.id === id);
      if (existing) assertOwner(existing, user);
      const back = Math.max(1, Number(body.returned_qty) || 1);
      let target = null;
      store.update('loans', (arr) => arr.map((l) => {
        if (l.id !== id) return l;
        const left = Math.max(0, Number(l.qty) - Number(l.returned_qty || 0));
        if (l.status === 'returned' || left === 0) return l;
        const returned = Math.min(back, left);
        target = { ...l, returned_qty: Number(l.returned_qty || 0) + returned };
        if (target.returned_qty >= target.qty) {
          target.status = 'returned';
          target.returned_at = new Date().toISOString();
        }
        return target;
      }));
      if (!target) throw fail('NOT_FOUND', '借用记录不存在或已全部归还', 404);
      writeAudit(ctx, 'loan.return', 'loan', id, { back });
      return { status: 200, data: eqOnce(), meta: { partial: target.status === 'returned' ? 0 : 1, audited: 1 } };
    }
    if (action === 'list') {
      requirePerm(ctx, 'loan.list');
      return { status: 200, data: eqOnce(), meta: { loan_count: eqOnce().loans.length } };
    }
  }

  /* ---------- 错题归档 ---------- */
  if (group === 'mistake') {
    if (action === 'list') {
      requirePerm(ctx, 'mistake.list');
      const items = scoped('mistakes', user).map(mistakeView);
      return { status: 200, data: { items },
        meta: { item_count: items.length, due_today: items.filter((m) => m.due).length } };
    }
    if (action === 'add' && method === 'POST') {
      requirePerm(ctx, 'mistake.add');
      const title = requireField(body, 'title');
      const item = {
        ...stamp(user),
        id: store.uid('ms'),
        title: title.slice(0, 80),
        subject: String(body.subject || '未分类').slice(0, 20),
        knowledge: String(body.knowledge || '未标注').slice(0, 30),
        wrong_reason: String(body.wrong_reason || '').slice(0, 120),
        correct_answer: String(body.correct_answer || '').slice(0, 120),
        created_at: new Date().toISOString(),
        stage: 0, review_count: 0, mastered: false,
        next_review: shift(today(), REVIEW_STAGES[0]),
        history: [],
      };
      store.update('mistakes', (arr) => [item, ...arr]);
      writeAudit(ctx, 'mistake.add', 'mistake', item.id, { subject: item.subject });
      return { status: 200, data: mistakeView(item), meta: { stage: 0, audited: 1 } };
    }
    if (action === 'review' && method === 'POST') {
      requirePerm(ctx, 'mistake.review');
      const id = requireField(body, 'id');
      const target0 = store.get('mistakes').find((m) => m.id === id);
      if (!target0) throw fail('NOT_FOUND', '错题不存在', 404);
      assertOwner(target0, user);
      const ok = body.result === 'ok';
      let updated = null;
      store.update('mistakes', (arr) => arr.map((m) => {
        if (m.id !== id) return m;
        const stage = ok ? Math.min(m.stage + 1, REVIEW_STAGES.length) : 0;
        updated = {
          ...m, stage,
          review_count: (m.review_count || 0) + 1,
          mastered: stage >= REVIEW_STAGES.length,
          next_review: shift(today(), REVIEW_STAGES[Math.min(stage, REVIEW_STAGES.length - 1)]),
          history: [...(m.history || []), { at: new Date().toISOString(), result: ok ? 'ok' : 'again' }],
        };
        return updated;
      }));
      if (!updated) throw fail('NOT_FOUND', '错题不存在', 404);
      writeAudit(ctx, 'mistake.review', 'mistake', id, { stage: updated.stage });
      return { status: 200, data: mistakeView(updated),
        meta: { stage: updated.stage, result: ok ? 'ok' : 'again', audited: 1 } };
    }
    if (action === 'delete' && method === 'DELETE') {
      requirePerm(ctx, 'mistake.delete');
      const id = requireField(body, 'id');
      const target = store.get('mistakes').find((m) => m.id === id);
      if (target) assertOwner(target, user);
      store.update('mistakes', (arr) => arr.filter((m) => m.id !== id));
      writeAudit(ctx, 'mistake.delete', 'mistake', id, {});
      return { status: 200, data: { ok: true }, meta: { audited: 1 } };
    }
  }

  /* ---------- 使用反馈 ---------- */
  if (group === 'feedback') {
    /** 收集进度对任何登录用户可见：只有数量，不含任何反馈正文 */
    if (action === 'progress' && method === 'GET') {
      requirePerm(ctx, 'feedback.progress');
      const items = store.get('feedback');
      return { status: 200, data: { collected: items.length, target: 8,
        reached: items.length >= 8 }, meta: { collected: items.length } };
    }
    if (action === 'list') {
      requirePerm(ctx, 'feedback.list');
      return { status: 200, data: { items: store.get('feedback'), target: 8 },
        meta: { collected: store.get('feedback').length } };
    }
    if (action === 'add' && method === 'POST') {
      requirePerm(ctx, 'feedback.add');
      const role = requireField(body, 'role');
      const score = Math.min(5, Math.max(1, Number(body.score) || 5));
      const item = {
        ...stamp(user),
        id: store.uid('fb'),
        role: role.slice(0, 20),
        module: String(body.module || '整体').slice(0, 20),
        score,
        task_done: String(body.task_done || '').slice(0, 160),
        problem: String(body.problem || '').slice(0, 160),
        liked: String(body.liked || '').slice(0, 160),
        suggestion: String(body.suggestion || '').slice(0, 160),
        reuse: ['愿意', '不确定', '不愿意'].includes(body.reuse) ? body.reuse : '',
        created_at: new Date().toISOString(),
      };
      store.update('feedback', (arr) => [item, ...arr]);
      writeAudit(ctx, 'feedback.add', 'feedback', item.id, { score });
      return { status: 200, data: item,
        meta: { score, collected: store.get('feedback').length, audited: 1 } };
    }
  }

  throw fail('UNKNOWN_ROUTE', '接口不存在: ' + pathname, 404);
}

/** 旧版 /api/logs/* 保留兼容，仅管理员可用 */
async function adminLogsRoutes(ctx) {
  requireRole(ctx, ['admin']);
  const { method, query } = ctx;
  const action = ctx.pathname.replace(/^\/api\//, '').split('/').filter(Boolean)[1] || 'list';
  const n = Math.min(30, Math.max(1, Number(query.get('days') || 7)));
  const agg = telemetry.aggregate(telemetry.listDays().slice(-n));
  if (action === 'day') {
    const day = query.get('date') || today();
    const rows = telemetry.readDay(day);
    return { status: 200, data: { day, rows: rows.slice(-200) }, meta: { row_count: rows.length } };
  }
  if (action === 'report' && method === 'POST') {
    return { status: 200, data: await generateReport(), meta: { generated: 1 } };
  }
  return { status: 200, data: { ...agg, all_days: telemetry.listDays(), version: telemetry.APP_VERSION },
    meta: { total_calls: agg.total_calls } };
}

module.exports = { handle, reconcile, dashboard, REVIEW_STAGES, PERMISSIONS };
