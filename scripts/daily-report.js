'use strict';
/**
 * 每日日志汇总 + 一键同步到 Git（对应作业「每日同步至 process_logs/」）
 *
 *   node scripts/daily-report.js                 # 汇总今天，生成 summary-YYYY-MM-DD.md
 *   node scripts/daily-report.js --day 2026-11-11
 *   node scripts/daily-report.js --sync          # 汇总后自动 git add + commit（不 push）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const telemetry = require('../lib/telemetry');

const ROOT = path.join(__dirname, '..');
const args = process.argv.slice(2);
const dayIdx = args.indexOf('--day');
const day = dayIdx >= 0 && args[dayIdx + 1] ? args[dayIdx + 1] : telemetry.localDay();
const doSync = args.includes('--sync');

const rows = telemetry.readDay(day);
const prevDay = (() => {
  const d = new Date(day + 'T00:00:00'); d.setDate(d.getDate() - 1);
  return telemetry.localDay(d);
})();
const prevRows = telemetry.readDay(prevDay);

function stat(list) {
  const byModule = {}, byAction = {}, byStatus = {};
  let errs = [];
  for (const r of list) {
    byModule[r.module] = (byModule[r.module] || 0) + 1;
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    if (r.status === 'error') errs.push(r);
  }
  const ds = list.map((r) => r.duration_ms).sort((a, b) => a - b);
  const avg = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
  return {
    total: list.length, byModule, byAction, byStatus, errs,
    avg: Math.round(avg * 100) / 100,
    p95: ds.length ? ds[Math.floor(ds.length * 0.95)] : 0,
    max: ds.length ? ds[ds.length - 1] : 0,
    first: list.length ? list[0].ts : '-',
    last: list.length ? list[list.length - 1].ts : '-',
  };
}

const s = stat(rows), ps = stat(prevRows);
const table = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n') || '| （无） | 0 |';
const delta = s.total - ps.total;

const md = [
  '# 运行日志日报 · ' + day,
  '',
  '> 由 `node scripts/daily-report.js` 自动生成，源文件 `process_logs/' + day + '.jsonl`。',
  '> 日志均为程序自动采集并已脱敏：不含通知原文、姓名、学号、题目与反馈正文。',
  '',
  '## 概览',
  '',
  '| 指标 | 今日 | 昨日 | 变化 |',
  '| --- | ---: | ---: | ---: |',
  '| 调用总次数 | ' + s.total + ' | ' + ps.total + ' | ' + (delta >= 0 ? '+' : '') + delta + ' |',
  '| 平均耗时 (ms) | ' + s.avg + ' | ' + ps.avg + ' | ' + (s.avg - ps.avg >= 0 ? '+' : '') + Math.round((s.avg - ps.avg) * 100) / 100 + ' |',
  '| P95 耗时 (ms) | ' + s.p95 + ' | ' + ps.p95 + ' | — |',
  '| 最慢一次 (ms) | ' + s.max + ' | ' + ps.max + ' | — |',
  '| 报错次数 | ' + (s.byStatus.error || 0) + ' | ' + (ps.byStatus.error || 0) + ' | — |',
  '| 首次 / 末次调用 | ' + s.first + ' | — | ' + s.last + ' |',
  '',
  '## 调用频次 · 按模块',
  '', '| 模块 | 次数 |', '| --- | ---: |', table(s.byModule),
  '', '## 调用频次 · 按动作',
  '', '| 动作 | 次数 |', '| --- | ---: |', table(s.byAction),
  '', '## 报错记录',
];
if (s.errs.length) {
  md.push('', '| 时间 | 模块 | 动作 | 错误码 |', '| --- | --- | --- | --- |');
  for (const e of s.errs) md.push('| ' + e.ts + ' | ' + e.module + ' | ' + e.action + ' | ' + (e.error_code || '-') + ' |');
} else {
  md.push('', '今日无报错。');
}
md.push('', '## 数据文件状态', '', '| 数据集 | 条数 |', '| --- | ---: |');
for (const name of ['notices', 'equipment', 'loans', 'mistakes', 'feedback']) {
  const file = path.join(ROOT, 'data', name + '.json');
  let count = 0;
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); count = Array.isArray(v) ? v.length : 0; } catch (_) {}
  md.push('| ' + name + '.json | ' + count + ' |');
}
md.push('', '---', '', '生成时间：' + new Date().toISOString(), '');

const outFile = path.join(telemetry.LOG_DIR, 'summary-' + day + '.md');
fs.writeFileSync(outFile, md.join('\n'), 'utf8');
console.log('[daily-report] 已生成 ' + outFile);
console.log('[daily-report] 今日调用 ' + s.total + ' 次，平均 ' + s.avg + 'ms，报错 ' + (s.byStatus.error || 0) + ' 次');

if (doSync) {
  try {
    execFileSync('git', ['add', 'process_logs/', 'data/'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', 'chore(logs): 同步 ' + day + ' 自动化运行日报'], { cwd: ROOT, stdio: 'inherit' });
    console.log('[daily-report] 已提交到本地 Git；推送请执行 git push');
  } catch (err) {
    console.log('[daily-report] Git 提交跳过：' + err.message.split('\n')[0]);
  }
}
