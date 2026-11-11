'use strict';
/**
 * Telemetry Logs —— 程序自动化运行日志。
 *
 * 设计原则（对应作业「防摆拍」要求）：
 *  1. 由服务端在每次请求结束时自动落盘，不依赖人工填写；
 *  2. 按自然日分文件写到 process_logs/YYYY-MM-DD.jsonl，便于每日同步 GitHub；
 *  3. 严格脱敏：不写通知原文、姓名、学号、题目内容、反馈正文，
 *     只记录可统计的特征（长度、条数、命中规则数、错误码等）；
 *  4. 记录调用频次、耗时(ms)、状态与报错，用于驱动后续 Git 迭代。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const LOG_DIR = path.join(__dirname, '..', 'process_logs');
const APP_VERSION = process.env.APP_VERSION || 'v1.0.0';

/** 这些字段一律不进日志，防止把原文/个人信息带出来 */
const FORBIDDEN_KEYS = new Set([
  'text', 'raw', 'content', 'body', 'title', 'name', 'username', 'student', 'student_no',
  'answer', 'my_answer', 'note', 'remark', 'query', 'input', 'source', 'question',
  'detail', 'contact', 'phone', 'email', 'id_card', 'comment', 'description', 'payload',
  'items', 'result', 'data', 'html', 'markdown',
]);

function localDay(d) {
  const t = d || new Date();
  const p = (n) => String(n).padStart(2, '0');
  return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate());
}

function fingerprint(v) {
  const s = String(v);
  return {
    len: s.length,
    hash: crypto.createHash('sha256').update(s).digest('hex').slice(0, 10),
  };
}

/** 兜底脱敏：即便调用方误传了内容，也只留下长度与不可逆摘要 */
function sanitize(meta) {
  const out = {};
  if (!meta || typeof meta !== 'object') return out;
  for (const [key, value] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'number' || typeof value === 'boolean') {
      out[key] = Number.isFinite(value) ? value : 0;
    } else if (typeof value === 'string') {
      // 短枚举值（模块名、错误码、学科等）保留，长文本一律摘要化
      out[key] = value.length <= 24 && !/[\u4e00-\u9fa5]/.test(value)
        ? value
        : fingerprint(value);
    } else if (Array.isArray(value)) {
      out[key + '_count'] = value.length;
    } else if (typeof value === 'object') {
      const inner = sanitize(value);
      out[key] = Object.keys(inner).length ? inner : undefined;
    }
    if (out[key] === undefined) delete out[key];
  }
  return out;
}

function ensureDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}

function logFile(day) {
  return path.join(LOG_DIR, day + '.jsonl');
}

/**
 * 写一条日志。entry: { module, action, status, duration_ms, error_code, session, meta }
 */
function log(entry) {
  ensureDir();
  const now = new Date();
  const day = localDay(now);
  const record = {
    ts: now.toISOString(),
    day,
    app_version: APP_VERSION,
    session: entry.session ? String(entry.session).slice(0, 16) : 'anonymous',
    module: String(entry.module || 'unknown').slice(0, 32),
    action: String(entry.action || 'unknown').slice(0, 32),
    status: entry.status === 'error' ? 'error' : 'ok',
    duration_ms: Math.round(Number(entry.duration_ms || 0) * 100) / 100,
    error_code: entry.error_code ? String(entry.error_code).slice(0, 64) : null,
    meta: sanitize(entry.meta || {}),
  };
  fs.appendFileSync(logFile(day), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

function listDays() {
  ensureDir();
  return fs.readdirSync(LOG_DIR)
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map((f) => f.slice(0, 10))
    .sort();
}

function readDay(day) {
  const file = logFile(day);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/** 汇总任意天数窗口的日志，供「运行日志」页面与每日报告使用 */
function aggregate(days) {
  const wanted = Array.isArray(days) && days.length ? days : listDays().slice(-7);
  const rows = wanted.flatMap(readDay);
  const durations = rows.map((r) => r.duration_ms).sort((a, b) => a - b);
  const byModule = {}, byAction = {}, byStatus = {}, byDay = {}, errors = [];
  for (const r of rows) {
    byModule[r.module] = (byModule[r.module] || 0) + 1;
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byDay[r.day] = (byDay[r.day] || 0) + 1;
    if (r.status === 'error') {
      errors.push({ ts: r.ts, module: r.module, action: r.action, error_code: r.error_code });
    }
  }
  return {
    window: wanted,
    total_calls: rows.length,
    days_with_data: Object.keys(byDay).length,
    by_module: byModule,
    by_action: byAction,
    by_status: byStatus,
    by_day: byDay,
    avg_duration_ms: durations.length
      ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length * 100) / 100 : 0,
    p95_duration_ms: percentile(durations, 0.95),
    max_duration_ms: durations.length ? durations[durations.length - 1] : 0,
    errors: errors.slice(-50),
    recent: rows.slice(-30).reverse(),
  };
}

module.exports = { log, listDays, readDay, aggregate, localDay, LOG_DIR, APP_VERSION };
