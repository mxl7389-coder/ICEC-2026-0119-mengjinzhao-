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
  const byModule = {}, byAction = {}, byStatus = {}, byErrorCode = {}, byRole = {}, bySource = {};
  let errs = [];
  for (const r of list) {
    const src = r.source || 'legacy';
    bySource[src] = (bySource[src] || 0) + 1;
    byModule[r.module] = (byModule[r.module] || 0) + 1;
    byAction[r.action] = (byAction[r.action] || 0) + 1;
    byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    byRole[r.role || 'anonymous'] = (byRole[r.role || 'anonymous'] || 0) + 1;
    if (r.status === 'error') {
      const code = r.error_code || 'UNKNOWN';
      byErrorCode[code] = (byErrorCode[code] || 0) + 1;
      errs.push(r);
    }
  }
  const ds = list.map((r) => r.duration_ms).sort((a, b) => a - b);
  const avg = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
  return {
    total: list.length, byModule, byAction, byStatus, byErrorCode, byRole, bySource, errs,
    avg: Math.round(avg * 100) / 100,
    p95: ds.length ? ds[Math.floor(ds.length * 0.95)] : 0,
    max: ds.length ? ds[ds.length - 1] : 0,
    first: list.length ? list[0].ts : '-',
    last: list.length ? list[list.length - 1].ts : '-',
  };
}

const s = stat(rows), ps = stat(prevRows);
const streak = telemetry.streakInfo();
const generatedAt = new Date().toISOString();
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
  '| 截至行数 / 日志来源 | ' + rows.length + ' 行 | — | ' +
    Object.entries(s.bySource).map(([k, v]) => k + ':' + v).join(' / ') + ' |',
  '',
  '> 本文件是 **' + generatedAt + '** 生成时的静态快照：此后新产生的访问不会回写本日报，' +
  '次日或收工前重新运行 `node scripts/daily-report.js` 会覆盖为最新口径。原始记录以 `process_logs/' + day + '.jsonl` 为准。',
  '',
  '## 连续运行达标自检 · 验收指标 8.2',
  '',
  '| 项目 | 当前值 | 说明 |',
  '| --- | ---: | --- |',
  '| 已有日期文件 | ' + streak.days_count + ' 天 | ' + (streak.days.join('、') || '（无）') + ' |',
  '| **当前连续天数** | **' + streak.current_streak + ' 天** | 验收要求连续 ≥ 7 天，按「连续」而非「累计」判定 |',
  '| 历史最长连续 | ' + streak.longest_streak + ' 天 | ' + (streak.longest_start ? streak.longest_start + ' → ' + streak.longest_end : '—') + ' |',
  '| 达标状态 | ' + (streak.target_met ? '已达标' : '未达标') + ' | ' +
    (streak.target_met ? '可提交 7 天运行报告' : '从 ' + (streak.current_start || day) +
      ' 起还需连续使用到 **' + streak.target_date + '**（再 ' + streak.remaining_days + ' 天）') + ' |',
  '',
  '断档明细：' + (streak.gaps.length
    ? streak.gaps.map((g) => g.from + ' → ' + g.to + ' 缺 ' + g.missing + ' 天').join('；')
    : '无'),
  '',
  '> 断档不能用「累计天数」代替，也不能补造历史日志。每天实际使用一次并运行 `node scripts/daily-report.js --sync` 即可自然累积。',
  '',
  '## 日志来源与口径',
  '',
  '| 来源 | 今日次数 |', '| --- | ---: |', table(s.bySource),
  '',
  '> `live` = 真实页面/接口访问；`legacy` = v6.1 之前写入、未带来源标记的历史记录；' +
  '`smoke` = 冒烟测试。自 v6.1 起测试进程通过 `CAMPUSDESK_LOG_DIR` 写入隔离目录，**不再进入本日报**。' +
  '历史 `legacy` 记录中含测试故意触发的 `FORBIDDEN` / `BAD_CREDENTIALS` / `OUT_OF_STOCK` 等错误码，' +
  '因此累计错误率会偏高，评估程序稳定性时请以新日志为准。',
  '',
  '## 调用频次 · 按模块',
  '', '| 模块 | 次数 |', '| --- | ---: |', table(s.byModule),
  '', '## 调用频次 · 按动作',
  '', '| 动作 | 次数 |', '| --- | ---: |', table(s.byAction),
  '', '## 调用频次 · 按角色',
  '', '| 角色 | 次数 |', '| --- | ---: |', table(s.byRole),
  '', '## 报错记录',
];
if (s.errs.length) {
  md.push('', '| 时间 | 模块 | 动作 | 错误码 |', '| --- | --- | --- | --- |');
  for (const e of s.errs) md.push('| ' + e.ts + ' | ' + e.module + ' | ' + e.action + ' | ' + (e.error_code || '-') + ' |');
} else {
  md.push('', '今日无报错。');
}
const errRows = Object.entries(s.byErrorCode).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => '| ' + k + ' | ' + v + ' |').join('\n');
md.push('', '### 错误码分布', '', '| 错误码 | 次数 |', '| --- | ---: |', errRows || '| （无） | 0 |');
md.push('', '## 数据文件状态', '', '| 数据集 | 条数 |', '| --- | ---: |');
for (const name of ['notices', 'equipment', 'loans', 'mistakes', 'feedback', 'audit']) {
  const file = path.join(ROOT, 'data', name + '.json');
  let count = 0;
  try { const v = JSON.parse(fs.readFileSync(file, 'utf8')); count = Array.isArray(v) ? v.length : 0; } catch (_) {}
  md.push('| ' + name + '.json | ' + count + ' |');
}
md.push('', '---', '', '生成时间：' + generatedAt,
  '数据口径：原始 jsonl 为准；业务数据 data/ 已被 .gitignore 排除，本日报只统计条数。', '');

const outFile = path.join(telemetry.LOG_DIR, 'summary-' + day + '.md');
fs.writeFileSync(outFile, md.join('\n'), 'utf8');
console.log('[daily-report] 已生成 ' + outFile);
console.log('[daily-report] 今日调用 ' + s.total + ' 次，平均 ' + s.avg + 'ms，报错 ' + (s.byStatus.error || 0) + ' 次');
console.log('[daily-report] 连续运行 ' + streak.current_streak + '/7 天' +
  (streak.target_met ? '（已达标）' : '（未达标，需连续到 ' + streak.target_date + '）') +
  '；历史最长 ' + streak.longest_streak + ' 天，断档 ' + streak.gaps.length + ' 处');

if (doSync) {
  try {
    // 只提交日志目录：业务数据 data/ 由 .gitignore 排除，目录不存在时也不应让同步失败
    execFileSync('git', ['add', 'process_logs/'], { cwd: ROOT, stdio: 'inherit' });
    execFileSync('git', ['commit', '-m', 'chore(logs): 同步 ' + day + ' 自动化运行日报'], { cwd: ROOT, stdio: 'inherit' });
    console.log('[daily-report] 已提交到本地 Git；推送请执行 git push');
  } catch (err) {
    console.log('[daily-report] Git 提交跳过：' + err.message.split('\n')[0]);
  }
}
