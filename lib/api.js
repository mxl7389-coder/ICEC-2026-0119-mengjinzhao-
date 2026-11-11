'use strict';
/**
 * 业务 API：鉴权 / 通知提取 / 器材借还核对 / 错题归档 / 看板 / 日志 / 反馈 / 管理后台
 * 所有返回值统一 { status, data, meta, headers? }，meta 只含可统计特征，交由 telemetry 脱敏落盘。
 *
 * 数据原则：本文件不包含任何预置业务数据，不自动播种器材、通知、反馈或账号。
 * 所有记录都由登录用户在页面上录入，并带上 owner_id 标记来源。
 */
const path = require('path');
const { execFile } = require('child_process');
const store = require('./store');
const extractor = require('./extractor');
const telemetry = require('./telemetry');
const auth = require('./auth');

const REVIEW_STAGES = [1, 2, 4, 7, 15, 30]; // 艾宾浩斯式复习间隔（天）

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

/* ------------------------------ 角色与权限 ------------------------------ */
const PERMISSIONS = {
  student: [
    'notice.parse', 'notice.save', 'notice.list', 'notice.toggle', 'notice.ics',
    'equipment.list', 'loan.create', 'loan.return', 'loan.list',
    'mistake.list', 'mistake.add', 'mistake.review',
    'feedback.add', 'dashboard', 'bootstrap',
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
  if (user.role === 'student' && record.owner_id && record.owner_id !== user.id) {
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
    telemetry: {
      total_calls: agg.total_calls,
      days_with_data: telemetry.listDays().length,
      avg_duration_ms: agg.avg_duration_ms,
      errors: agg.by_status.error || 0,
      by_day: agg.by_day,
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
  const action = ctx.pathname.replace(/^\/api\//, '').split('/').filter(Boolean)[1] || 'overview';

  if (action === 'overview' && method === 'GET') {
    const datasets = {};
    for (const n of store.NAMES) datasets[n] = store.get(n).length;
    const users = auth.listUsers();
    const agg = telemetry.aggregate(telemetry.listDays().slice(-7));
    return { status: 200, data: {
      datasets,
      users_total: users.length,
      users_by_role: users.reduce((a, u) => { a[u.role] = (a[u.role] || 0) + 1; return a; }, {}),
      health: {
        app: 'CampusDesk 校园事务台', version: telemetry.APP_VERSION,
        node: process.version, uptime_s: Math.round(process.uptime()),
        log_days: telemetry.listDays().length, today: today(),
      },
      telemetry: agg,
      all_days: telemetry.listDays(),
    }, meta: { datasets: store.NAMES.length } };
  }
  if (action === 'users' && method === 'GET') {
    return { status: 200, data: { items: auth.listUsers() }, meta: { user_count: auth.listUsers().length } };
  }
  if (action === 'users' && method === 'POST') {
    const created = auth.createUser({
      username: body.username, password: body.password,
      role: body.role, display_name: body.display_name, created_by: user.id,
    });
    return { status: 201, data: created, meta: { role: created.role } };
  }
  if (action === 'active' && method === 'POST') {
    const id = requireField(body, 'id');
    return { status: 200, data: auth.setActive(id, body.active !== false, user.id), meta: {} };
  }
  if (action === 'password' && method === 'POST') {
    const id = requireField(body, 'id');
    return { status: 200, data: auth.resetPassword(id, body.new_password), meta: {} };
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
    const cursor = Math.max(0, Number(query.get('cursor') || 0));
    return { status: 200, data: { day, cursor: all.length, rows: all.slice(cursor).slice(0, 200) },
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
    }, meta: { log_days: telemetry.listDays().length } };
  }

  if (group === 'auth') return authRoutes(ctx);

  // 除 health / auth 外，所有接口都必须带有效会话
  if (!user) throw fail('UNAUTHORIZED', '请先登录后再操作', 401);

  if (group === 'admin') return adminRoutes(ctx);
  if (group === 'logs') return adminLogsRoutes(ctx);

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
      empty: store.NAMES.filter((n) => n !== 'users' && n !== 'sessions')
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
      const notice = extractor.extract(text, { id: store.uid('nt'), source: 'manual' });
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
      } };
    }
    if (action === 'save' && method === 'POST') {
      requirePerm(ctx, 'notice.save');
      const n = body.notice;
      if (!n || !n.title) throw fail('INVALID_NOTICE', '没有可保存的结构化结果');
      const item = {
        ...n,
        ...stamp(user),
        id: n.id || store.uid('nt'),
        created_at: n.created_at || new Date().toISOString(),
        done: false,
      };
      store.update('notices', (arr) => [item, ...arr]);
      return { status: 200, data: item,
        meta: { todo_count: (item.todos || []).length, confidence: item.confidence || 0 } };
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
      return { status: 200, data: { ok: true }, meta: {} };
    }
    if (action === 'delete' && method === 'DELETE') {
      requirePerm(ctx, 'notice.delete');
      const id = requireField(body, 'id');
      const target = store.get('notices').find((n) => n.id === id);
      if (target) assertOwner(target, user);
      store.update('notices', (arr) => arr.filter((n) => n.id !== id));
      return { status: 200, data: { ok: true }, meta: {} };
    }
    if (action === 'ics') {
      requirePerm(ctx, 'notice.ics');
      const id = query.get('id');
      const n = scoped('notices', user).find((x) => x.id === id);
      if (!n) throw fail('NOT_FOUND', '未找到该通知', 404);
      const ics = n.ics || extractor.buildICS(n);
      return { status: 200, raw: {
        body: ics,
        headers: {
          'Content-Type': 'text/calendar; charset=utf-8',
          'Content-Disposition': 'attachment; filename="campus-notice.ics"',
        },
      }, meta: { has_time: n.event_time ? 1 : 0 } };
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
        category: String(body.category || '其他').slice(0, 20),
        total, unit: String(body.unit || '件').slice(0, 6),
        created_at: new Date().toISOString(),
      };
      store.update('equipment', (arr) => [...arr, item]);
      return { status: 200, data: eqOnce(), meta: { total } };
    }
    if (action === 'delete' && method === 'DELETE') {
      requirePerm(ctx, 'equipment.delete');
      const id = requireField(body, 'id');
      if (outstanding(id) > 0) throw fail('HAS_LOAN', '该器材尚有未归还借用，不能删除');
      store.update('equipment', (arr) => arr.filter((i) => i.id !== id));
      return { status: 200, data: eqOnce(), meta: {} };
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
      return { status: 200, data: eqOnce(), meta: { qty, available_before: found.available } };
    }
    if (action === 'return' && method === 'POST') {
      requirePerm(ctx, 'loan.return');
      const id = requireField(body, 'id');
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
      return { status: 200, data: eqOnce(), meta: { partial: target.status === 'returned' ? 0 : 1 } };
    }
    if (action === 'list') {
      requirePerm(ctx, 'loan.list');
      return { status: 200, data: eqOnce(), meta: { loan_count: store.get('loans').length } };
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
      return { status: 200, data: mistakeView(item), meta: { stage: 0 } };
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
      return { status: 200, data: mistakeView(updated),
        meta: { stage: updated.stage, result: ok ? 'ok' : 'again' } };
    }
    if (action === 'delete' && method === 'DELETE') {
      requirePerm(ctx, 'mistake.delete');
      const id = requireField(body, 'id');
      const target = store.get('mistakes').find((m) => m.id === id);
      if (target) assertOwner(target, user);
      store.update('mistakes', (arr) => arr.filter((m) => m.id !== id));
      return { status: 200, data: { ok: true }, meta: {} };
    }
  }

  /* ---------- 使用反馈 ---------- */
  if (group === 'feedback') {
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
        liked: String(body.liked || '').slice(0, 160),
        suggestion: String(body.suggestion || '').slice(0, 160),
        created_at: new Date().toISOString(),
      };
      store.update('feedback', (arr) => [item, ...arr]);
      return { status: 200, data: item,
        meta: { score, collected: store.get('feedback').length } };
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
