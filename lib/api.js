'use strict';
/**
 * 业务 API：通知提取 / 器材借还核对 / 错题归档 / 看板 / 日志 / 反馈
 * 所有返回值统一 { status, data, meta }，meta 只含可统计特征，交由 telemetry 脱敏落盘。
 */
const path = require('path');
const { execFileSync } = require('child_process');
const store = require('./store');
const extractor = require('./extractor');
const telemetry = require('./telemetry');

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

/* ------------------------------ 器材借还核对 ------------------------------ */
function outstanding(itemId) {
  return store.get('loans')
    .filter((l) => l.item_id === itemId && l.status !== 'returned')
    .reduce((sum, l) => sum + Math.max(0, Number(l.qty) - Number(l.returned_qty || 0)), 0);
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
function seedEquipment() {
  if (store.get('equipment').length) return false;
  const defaults = [
    { name: '篮球', category: '体育器材', total: 20, unit: '个' },
    { name: '跳绳', category: '体育器材', total: 30, unit: '根' },
    { name: '羽毛球拍', category: '体育器材', total: 16, unit: '副' },
    { name: '示波器', category: '实验设备', total: 6, unit: '台' },
    { name: '投影仪', category: '教学设备', total: 4, unit: '台' },
    { name: '扩音器', category: '教学设备', total: 8, unit: '个' },
  ];
  store.set('equipment', defaults.map((d) => ({
    ...d, id: store.uid('eq'), created_at: new Date().toISOString(),
  })));
  return true;
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
function dashboard() {
  const notices = store.get('notices');
  const eq = reconcile();
  const mistakes = store.get('mistakes').map(mistakeView);
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
  const { method, pathname, query, body } = ctx;
  const p = pathname.replace(/^\/api\//, '');
  const seg = p.split('/').filter(Boolean);
  const group = seg[0];
  const action = seg[1] || 'list';

  if (group === 'health') {
    return { status: 200, data: {
      ok: true, app: 'CampusDesk 校园事务台', version: telemetry.APP_VERSION,
      node: process.version, uptime_s: Math.round(process.uptime()),
      log_days: telemetry.listDays().length, today: today(),
    }, meta: { log_days: telemetry.listDays().length } };
  }

  if (group === 'bootstrap') {
    seedEquipment();
    return { status: 200, data: {
      dashboard: dashboard(),
      equipment: reconcile(),
      notices: store.get('notices'),
      mistakes: store.get('mistakes').map(mistakeView),
      feedback: store.get('feedback'),
      samples: extractor.SAMPLES,
      version: telemetry.APP_VERSION,
      today: today(),
    }, meta: { datasets: store.NAMES.length } };
  }

  if (group === 'dashboard') {
    return { status: 200, data: dashboard(), meta: {} };
  }

  /* ---------- 通知提取 ---------- */
  if (group === 'notice') {
    if (action === 'parse' && method === 'POST') {
      const text = body.text || '';
      if (!String(text).trim()) throw fail('EMPTY_NOTICE', '请先粘贴通知内容');
      const notice = extractor.extract(text, { id: store.uid('nt'), source: 'manual' });
      // 把「哪些字段没解析出来」也写进日志（只记字段代号，不记内容），
      // 这样后续迭代可以直接从 telemetry 判断规则缺口，而不必肉眼复核每条通知。
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
      const n = body.notice;
      if (!n || !n.title) throw fail('INVALID_NOTICE', '没有可保存的结构化结果');
      const item = {
        ...n,
        id: n.id || store.uid('nt'),
        created_at: n.created_at || new Date().toISOString(),
        done: false,
      };
      store.update('notices', (arr) => [item, ...arr]);
      return { status: 200, data: item, meta: { todo_count: (item.todos || []).length, confidence: item.confidence || 0 } };
    }
    if (action === 'list') {
      return { status: 200, data: { items: store.get('notices') }, meta: { item_count: store.get('notices').length } };
    }
    if (action === 'toggle' && method === 'POST') {
      const id = requireField(body, 'id');
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
      const id = requireField(body, 'id');
      store.update('notices', (arr) => arr.filter((n) => n.id !== id));
      return { status: 200, data: { ok: true }, meta: {} };
    }
    if (action === 'ics') {
      const id = query.get('id');
      const n = store.get('notices').find((x) => x.id === id);
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
    if (action === 'seed' && method === 'POST') {
      const created = seedEquipment();
      return { status: 200, data: reconcile(), meta: { created: created ? 1 : 0 } };
    }
    if (action === 'list') {
      seedEquipment();
      return { status: 200, data: reconcile(), meta: { item_count: reconcile().items.length } };
    }
    if (action === 'add' && method === 'POST') {
      const name = requireField(body, 'name');
      const total = Math.max(1, Number(body.total) || 1);
      const item = {
        id: store.uid('eq'), name: name.slice(0, 30),
        category: String(body.category || '其他').slice(0, 20),
        total, unit: String(body.unit || '件').slice(0, 6),
        created_at: new Date().toISOString(),
      };
      store.update('equipment', (arr) => [...arr, item]);
      return { status: 200, data: reconcile(), meta: { total } };
    }
    if (action === 'delete' && method === 'DELETE') {
      const id = requireField(body, 'id');
      if (outstanding(id) > 0) throw fail('HAS_LOAN', '该器材尚有未归还借用，不能删除');
      store.update('equipment', (arr) => arr.filter((i) => i.id !== id));
      return { status: 200, data: reconcile(), meta: {} };
    }
  }

  if (group === 'loan') {
    if (action === 'create' && method === 'POST') {
      const itemId = requireField(body, 'item_id');
      const borrower = requireField(body, 'borrower');
      const qty = Math.max(1, Number(body.qty) || 1);
      const item = store.get('equipment').find((i) => i.id === itemId);
      if (!item) throw fail('NOT_FOUND', '器材不存在', 404);
      const eq = reconcile();
      const row = eq.items.find((i) => i.id === itemId);
      if (qty > row.available) throw fail('OUT_OF_STOCK', '库存不足，当前可用 ' + row.available + ' ' + item.unit);
      const loan = {
        id: store.uid('ln'), item_id: itemId,
        borrower: borrower.slice(0, 24), qty,
        returned_qty: 0,
        borrowed_at: new Date().toISOString(),
        due_date: String(body.due_date || shift(today(), 7)).slice(0, 10),
        purpose: String(body.purpose || '').slice(0, 40),
        returned_at: null, status: 'active',
      };
      store.update('loans', (arr) => [loan, ...arr]);
      return { status: 200, data: reconcile(), meta: { qty, available_before: row.available } };
    }
    if (action === 'return' && method === 'POST') {
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
      return { status: 200, data: reconcile(), meta: { partial: target.status === 'returned' ? 0 : 1 } };
    }
    if (action === 'list') {
      return { status: 200, data: reconcile(), meta: { loan_count: store.get('loans').length } };
    }
  }

  /* ---------- 错题归档 ---------- */
  if (group === 'mistake') {
    if (action === 'list') {
      const items = store.get('mistakes').map(mistakeView);
      return { status: 200, data: { items }, meta: { item_count: items.length, due_today: items.filter((m) => m.due).length } };
    }
    if (action === 'add' && method === 'POST') {
      const title = requireField(body, 'title');
      const item = {
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
      const id = requireField(body, 'id');
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
      return { status: 200, data: mistakeView(updated), meta: { stage: updated.stage, result: ok ? 'ok' : 'again' } };
    }
    if (action === 'delete' && method === 'DELETE') {
      const id = requireField(body, 'id');
      store.update('mistakes', (arr) => arr.filter((m) => m.id !== id));
      return { status: 200, data: { ok: true }, meta: {} };
    }
  }

  /* ---------- 运行日志 ---------- */
  if (group === 'logs') {
    const n = Math.min(30, Math.max(1, Number(query.get('days') || 7)));
    const days = telemetry.listDays().slice(-n);
    const agg = telemetry.aggregate(days);
    if (action === 'day') {
      const day = query.get('date') || today();
      return { status: 200, data: { day, rows: telemetry.readDay(day).slice(-200) }, meta: { row_count: telemetry.readDay(day).length } };
    }
    if (action === 'report' && method === 'POST') {
      const script = path.join(__dirname, '..', 'scripts', 'daily-report.js');
      const output = execFileSync(process.execPath, [script], { encoding: 'utf8', timeout: 15000 });
      return { status: 200, data: { ok: true, file: 'process_logs/summary-' + today() + '.md', output: output.trim() }, meta: { generated: 1 } };
    }
    return { status: 200, data: { ...agg, all_days: telemetry.listDays(), version: telemetry.APP_VERSION }, meta: { total_calls: agg.total_calls } };
  }

  /* ---------- 使用反馈 ---------- */
  if (group === 'feedback') {
    if (action === 'list') {
      return { status: 200, data: { items: store.get('feedback'), target: 8 }, meta: { collected: store.get('feedback').length } };
    }
    if (action === 'add' && method === 'POST') {
      const role = requireField(body, 'role');
      const score = Math.min(5, Math.max(1, Number(body.score) || 5));
      const item = {
        id: store.uid('fb'),
        role: role.slice(0, 20),
        module: String(body.module || '整体').slice(0, 20),
        score,
        liked: String(body.liked || '').slice(0, 160),
        suggestion: String(body.suggestion || '').slice(0, 160),
        created_at: new Date().toISOString(),
      };
      store.update('feedback', (arr) => [item, ...arr]);
      return { status: 200, data: item, meta: { score, collected: store.get('feedback').length } };
    }
  }

  throw fail('UNKNOWN_ROUTE', '接口不存在: ' + pathname, 404);
}

module.exports = { handle, reconcile, dashboard, REVIEW_STAGES };
