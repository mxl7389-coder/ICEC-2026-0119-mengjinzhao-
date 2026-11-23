#!/usr/bin/env node
/**
 * CampusDesk 真实运行日志洞察（零依赖）
 *
 * 作用：读取 process_logs/YYYY-MM-DD.jsonl 中由真实 HTTP 请求自动落盘的日志，
 *       计算统计量，并生成：
 *         1. 统计结果.json     —— 可由他人复算的机器可读结果
 *         2. 运行数据看板.html  —— 自包含、无 CDN、内嵌真实数据的 SVG 图表
 *         3. 分析报告.md        —— 由真实数值写成的文字报告
 *
 * 用法：node 02-200Days-Challenge/日志洞察/运行日志分析.js
 *
 * 红线：本脚本不生成、不补齐、不推测任何日志行。缺失日期在图上按 0 显示，
 *       报告如实说明断档；所有数字只来自上面这些文件。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const HERE = __dirname;
const ROOT = path.resolve(HERE, '..', '..');
const LOG_DIR = path.join(ROOT, 'process_logs');
const DAY_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

function die(msg) {
  console.error('[日志洞察] ' + msg);
  process.exit(1);
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

function round(n, d) {
  const k = Math.pow(10, d);
  return Math.round(n * k) / k;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function bump(map, key) {
  const k = key == null || key === '' ? '(空)' : String(key);
  map[k] = (map[k] || 0) + 1;
  return map;
}

function top(map, n) {
  return Object.keys(map).map(k => [k, map[k]])
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
}

function addDays(day, delta) {
  const d = new Date(day + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a, b) {
  const out = [];
  let cur = a;
  let guard = 0;
  while (cur <= b && guard++ < 400) {
    out.push(cur);
    cur = addDays(cur, 1);
  }
  return out;
}

function longestStreak(axis, counts) {
  let best = 0, cur = 0, bestEnd = '';
  for (const d of axis) {
    if (counts[d] > 0) {
      cur += 1;
      if (cur > best) { best = cur; bestEnd = d; }
    } else {
      cur = 0;
    }
  }
  let tail = 0;
  for (let i = axis.length - 1; i >= 0; i--) {
    if (counts[axis[i]] > 0) tail += 1;
    else break;
  }
  return { max: best, max_end: bestEnd, current: tail };
}

/* ---------------- 1. 读取真实日志 ---------------- */

if (!fs.existsSync(LOG_DIR)) die('找不到日志目录：' + LOG_DIR);

const files = fs.readdirSync(LOG_DIR)
  .filter(f => DAY_RE.test(f)).sort();

if (!files.length) die('process_logs/ 下没有任何 YYYY-MM-DD.jsonl 日志，拒绝生成空报告。');

const records = [];
const fileMeta = [];
let badLines = 0;

for (const f of files) {
  const buf = fs.readFileSync(path.join(LOG_DIR, f));
  const text = buf.toString('utf8');
  const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
  let ok = 0, bad = 0;
  const fileDay = f.match(DAY_RE)[1];
  for (const line of lines) {
    try {
      const r = JSON.parse(line);
      r.__file_day = fileDay;
      records.push(r);
      ok += 1;
    } catch (_) {
      bad += 1;
      badLines += 1;
    }
  }
  fileMeta.push({
    file: 'process_logs/' + f,
    bytes: buf.length,
    lines: lines.length,
    parsed: ok,
    parse_errors: bad,
    sha256: sha256(buf)
  });
}

if (!records.length) die('日志文件存在但没有可解析的记录，拒绝生成空报告。');

/* ---------------- 2. 真实统计 ---------------- */

const perDay = {}, bySource = {}, byVersion = {}, byStatus = {},
      byModule = {}, byAction = {}, byError = {}, byRole = {}, byPortal = {};
const durations = [];
let peak = null;

for (const r of records) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(r.day || '')) ? r.day : r.__file_day;
  perDay[day] = (perDay[day] || 0) + 1;
  bump(bySource, r.source);
  bump(byVersion, r.app_version);
  bump(byStatus, r.status);
  bump(byModule, r.module);
  bump(byAction, r.action);
  bump(byError, r.error_code);
  bump(byRole, r.role);
  bump(byPortal, r.portal);
  const ms = Number(r.duration_ms);
  if (Number.isFinite(ms) && ms >= 0) {
    durations.push(ms);
    if (!peak || ms > peak.duration_ms) peak = { duration_ms: ms, module: r.module, action: r.action, day: day };
  }
}

durations.sort((a, b) => a - b);

const dayList = Object.keys(perDay).sort();
const firstDay = dayList[0];
const lastDay = dayList[dayList.length - 1];
const axis = daysBetween(firstDay, lastDay);
const series = axis.map(d => ({ day: d, count: perDay[d] || 0 }));
const streak = longestStreak(axis, perDay);

const buckets = [
  { label: '<5ms', lo: 0, hi: 5 },
  { label: '5-10ms', lo: 5, hi: 10 },
  { label: '10-20ms', lo: 10, hi: 20 },
  { label: '20-50ms', lo: 20, hi: 50 },
  { label: '50-100ms', lo: 50, hi: 100 },
  { label: '100-500ms', lo: 100, hi: 500 },
  { label: '>=500ms', lo: 500, hi: Infinity }
];
const histogram = buckets.map(b => ({
  label: b.label,
  count: durations.filter(v => v >= b.lo && v < b.hi).length
}));

const errored = records.filter(r => r.status !== 'ok').length;

const stats = {
  generated_at: new Date().toISOString(),
  source_note: '全部数值由 process_logs/*.jsonl 逐行解析得出；脚本不写入、不补齐任何日志行。',
  input: { dir: 'process_logs/', file_count: files.length, total_lines: records.length + badLines, parse_errors: badLines, files: fileMeta },
  overview: {
    records: records.length,
    days_with_logs: dayList.length,
    first_day: firstDay,
    last_day: lastDay,
    calendar_days_in_range: axis.length,
    gap_days: axis.length - dayList.length,
    gap_dates: axis.filter(d => !perDay[d]),
    longest_consecutive_days: streak.max,
    longest_consecutive_end: streak.max_end,
    current_consecutive_days: streak.current,
    errored_records: errored,
    error_rate: round(errored / records.length * 100, 2),
    peak_day: top(perDay, 1)[0],
    slowest_request: peak
  },
  per_day: series,
  by_source: top(bySource, 20),
  by_app_version: top(byVersion, 20),
  by_status: top(byStatus, 20),
  by_module: top(byModule, 20),
  by_action: top(byAction, 20),
  by_error_code: top(byError, 20),
  by_role: top(byRole, 20),
  duration_ms: {
    samples: durations.length,
    min: round(durations[0] || 0, 2),
    mean: round(durations.reduce((a, b) => a + b, 0) / (durations.length || 1), 2),
    p50: round(pct(durations, 0.5), 2),
    p90: round(pct(durations, 0.9), 2),
    p95: round(pct(durations, 0.95), 2),
    p99: round(pct(durations, 0.99), 2),
    max: round(durations[durations.length - 1] || 0, 2),
    histogram: histogram
  }
};

/* ---------------- 3. SVG 图表 ---------------- */

function barChartVertical(items, opts) {
  const o = Object.assign({ w: 940, h: 300, padL: 56, padR: 18, padT: 22, padB: 78, color: '#4f6bed', zeroColor: '#e5e9f2' }, opts || {});
  const innerW = o.w - o.padL - o.padR;
  const innerH = o.h - o.padT - o.padB;
  const max = Math.max(1, ...items.map(i => i.value));
  const step = innerW / Math.max(1, items.length);
  const bw = Math.max(4, Math.min(40, step * 0.62));
  const parts = [];
  parts.push('<svg viewBox="0 0 ' + o.w + ' ' + o.h + '" role="img" aria-label="' + esc(o.aria || '柱状图') + '" style="width:100%;height:auto">');
  for (let g = 0; g <= 4; g++) {
    const y = o.padT + innerH * g / 4;
    const val = Math.round(max * (1 - g / 4));
    parts.push('<line x1="' + o.padL + '" y1="' + y + '" x2="' + (o.w - o.padR) + '" y2="' + y + '" stroke="#e8ecf4" stroke-width="1"/>');
    parts.push('<text x="' + (o.padL - 9) + '" y="' + (y + 4) + '" text-anchor="end" font-size="11" fill="#8a93a6">' + val + '</text>');
  }
  items.forEach((it, i) => {
    const x = o.padL + step * i + (step - bw) / 2;
    const h = it.value === 0 ? 0 : Math.max(2, innerH * it.value / max);
    const y = o.padT + innerH - h;
    parts.push('<rect x="' + round(x, 1) + '" y="' + round(y, 1) + '" width="' + round(bw, 1) + '" height="' + round(h, 1) + '" rx="3" fill="' + (it.value === 0 ? o.zeroColor : o.color) + '"><title>' + esc(it.label + ': ' + it.value) + '</title></rect>');
    if (it.value > 0 && items.length <= 20) {
      parts.push('<text x="' + round(x + bw / 2, 1) + '" y="' + round(y - 5, 1) + '" text-anchor="middle" font-size="10.5" fill="#4a5468">' + it.value + '</text>');
    }
    const cx = o.padL + step * i + step / 2;
    parts.push('<text x="' + round(cx, 1) + '" y="' + round(o.padT + innerH + 14, 1) + '" text-anchor="end" font-size="10.5" fill="' + (it.value === 0 ? '#c0392b' : '#6b7488') + '" transform="rotate(-42 ' + round(cx, 1) + ' ' + round(o.padT + innerH + 14, 1) + ')">' + esc(it.label) + '</text>');
    if (it.value === 0) {
      parts.push('<circle cx="' + round(cx, 1) + '" cy="' + round(o.padT + innerH - 4, 1) + '" r="2.5" fill="#c0392b"><title>无日志（断档）</title></circle>');
    }
  });
  parts.push('<line x1="' + o.padL + '" y1="' + (o.padT + innerH) + '" x2="' + (o.w - o.padR) + '" y2="' + (o.padT + innerH) + '" stroke="#c9d1e0" stroke-width="1"/>');
  parts.push('</svg>');
  return parts.join('');
}

function barChartHorizontal(items, opts) {
  const o = Object.assign({ w: 940, rowH: 30, padL: 132, padR: 62, padT: 10, color: '#2f9e8f' }, opts || {});
  const h = o.padT * 2 + items.length * o.rowH;
  const innerW = o.w - o.padL - o.padR;
  const max = Math.max(1, ...items.map(i => i.value));
  const parts = ['<svg viewBox="0 0 ' + o.w + ' ' + h + '" role="img" aria-label="' + esc(o.aria || '横向柱状图') + '" style="width:100%;height:auto">'];
  items.forEach((it, i) => {
    const y = o.padT + i * o.rowH;
    const bw = innerW * it.value / max;
    parts.push('<text x="' + (o.padL - 10) + '" y="' + (y + o.rowH * 0.65) + '" text-anchor="end" font-size="12" fill="#4a5468">' + esc(it.label) + '</text>');
    parts.push('<rect x="' + o.padL + '" y="' + (y + 5) + '" width="' + innerW + '" height="' + (o.rowH - 12) + '" rx="3" fill="#eef1f7"/>');
    parts.push('<rect x="' + o.padL + '" y="' + (y + 5) + '" width="' + round(Math.max(2, bw), 1) + '" height="' + (o.rowH - 12) + '" rx="3" fill="' + o.color + '"><title>' + esc(it.label + ': ' + it.value) + '</title></rect>');
    parts.push('<text x="' + (o.padL + Math.max(2, bw) + 7) + '" y="' + (y + o.rowH * 0.65) + '" font-size="11.5" fill="#4a5468">' + it.value + '</text>');
  });
  parts.push('</svg>');
  return parts.join('');
}

const chartDaily = barChartVertical(series.map(s => ({ label: s.day.slice(5), value: s.count })), { aria: '每日真实日志条数，断档日期为 0' });
const chartModule = barChartHorizontal(top(byModule, 10).map(([k, v]) => ({ label: k, value: v })), { aria: '按模块统计的真实调用次数' });
const chartHist = barChartVertical(histogram.map(b => ({ label: b.label, value: b.count })), { color: '#8a63d2', h: 280, padB: 70, aria: '真实请求耗时分布直方图' });

function table(headers, rows) {
  return '<table><thead><tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map(r => '<tr>' + r.map(c => '<td>' + esc(c) + '</td>').join('') + '</tr>').join('') +
    '</tbody></table>';
}

const srcTable = table(['来源标记', '条数', '占比'],
  top(bySource, 20).map(([k, v]) => [k, v, round(v / records.length * 100, 2) + '%']));
const statusTable = table(['状态 / 错误码', '条数'],
  top(byStatus, 10).map(([k, v]) => [k, v]).concat(top(byError, 10).filter(([k]) => k !== '(空)').map(([k, v]) => ['错误码: ' + k, v])));
const fileTable = table(['日志文件', '字节', '行数', '解析失败', 'SHA256（前 12 位）'],
  fileMeta.map(f => [f.file, f.bytes, f.lines, f.parse_errors, f.sha256.slice(0, 12)]));
const pctTable = table(['分位', '耗时 (ms)'], [
  ['最小', stats.duration_ms.min], ['P50', stats.duration_ms.p50], ['P90', stats.duration_ms.p90],
  ['P95', stats.duration_ms.p95], ['P99', stats.duration_ms.p99], ['最大', stats.duration_ms.max]
]);

const kpis = [
  ['真实日志条数', records.length, '逐行解析，无补造'],
  ['有日志日期', dayList.length, '区间 ' + stats.overview.calendar_days_in_range + ' 天'],
  ['最长连续天数', streak.max, '当前连续 ' + streak.current + ' 天'],
  ['错误率', stats.overview.error_rate + '%', errored + ' 条非 ok'],
  ['P95 耗时', stats.duration_ms.p95 + ' ms', '样本 ' + durations.length + ' 条'],
  ['应用版本数', stats.by_app_version.length, '按 app_version 统计']
];

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CampusDesk 真实运行日志洞察</title>
<style>
:root{--bg:#f5f7fb;--card:#fff;--ink:#1f2738;--sub:#69748a;--line:#e6eaf2;--accent:#4f6bed;--warn:#c0392b}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font-family:"PingFang SC","Microsoft YaHei","Segoe UI",system-ui,sans-serif;line-height:1.65}
.wrap{max-width:1080px;margin:0 auto;padding:32px 20px 64px}
header{margin-bottom:26px}
h1{font-size:27px;margin:0 0 8px;letter-spacing:.4px}
.lead{color:var(--sub);font-size:14px;margin:0}
.meta{margin-top:12px;font-size:12px;color:var(--sub)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:12px;margin:22px 0 28px}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;box-shadow:0 1px 2px rgba(24,38,66,.03)}
.kpi .label{font-size:12px;color:var(--sub)}
.kpi .value{font-size:25px;font-weight:650;margin:4px 0 2px}
.kpi .hint{font-size:11.5px;color:var(--sub)}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px 22px;margin-bottom:18px;box-shadow:0 1px 2px rgba(24,38,66,.03)}
h2{font-size:17px;margin:0 0 6px}
.note{font-size:12.5px;color:var(--sub);margin:0 0 14px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:18px}
@media(max-width:820px){.two{grid-template-columns:1fr}}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line)}
th{color:var(--sub);font-weight:600;background:#fafbfe}
tr:last-child td{border-bottom:0}
.warn{color:var(--warn);font-weight:600}
footer{font-size:12px;color:var(--sub);margin-top:24px}
code{background:#eef1f8;padding:2px 6px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
<header>
  <h1>CampusDesk · 真实运行日志洞察</h1>
  <p class="lead">数据来源：<code>process_logs/YYYY-MM-DD.jsonl</code> —— 由真实 HTTP 请求在服务内自动落盘，非人工填写。</p>
  <p class="meta">生成时间 ${esc(stats.generated_at)} ｜ 脚本 <code>02-200Days-Challenge/日志洞察/运行日志分析.js</code> ｜ 无外部依赖、无 CDN、图表为内嵌 SVG</p>
</header>

<div class="kpis">
${kpis.map(k => '<div class="kpi"><div class="label">' + esc(k[0]) + '</div><div class="value">' + esc(k[1]) + '</div><div class="hint">' + esc(k[2]) + '</div></div>').join('')}
</div>

<section>
  <h2>1. 每日日志量（连续自然日轴）</h2>
  <p class="note">横轴从 ${esc(firstDay)} 到 ${esc(lastDay)} 共 ${axis.length} 个自然日；<span class="warn">没有日志的日期按 0 显示并标红点</span>，不补写、不平滑。断档 ${stats.overview.gap_days} 天：${esc(stats.overview.gap_dates.join('、') || '无')}。</p>
  ${chartDaily}
</section>

<section>
  <h2>2. 调用分布</h2>
  <p class="note">按日志 <code>module</code> 字段统计出现次数，取前 10。</p>
  ${chartModule}
</section>

<div class="two">
  <section>
    <h2>3. 来源与状态</h2>
    <p class="note"><code>source</code> 用于区分真实运行与隔离测试；<code>status</code>/<code>error_code</code> 用于定位异常。</p>
    ${srcTable}
    <div style="height:14px"></div>
    ${statusTable}
  </section>
  <section>
    <h2>4. 耗时分布</h2>
    <p class="note">单位毫秒，仅统计有合法 <code>duration_ms</code> 的记录。</p>
    ${chartHist}
    <div style="height:10px"></div>
    ${pctTable}
  </section>
</div>

<section>
  <h2>5. 数据源校验</h2>
  <p class="note">每个输入文件的字节数、行数与 SHA256 均由脚本实测；任何人可用同一脚本复算。解析失败行数：${badLines}。</p>
  ${fileTable}
  <p class="note" style="margin-top:14px">峰值日：${esc(stats.overview.peak_day[0])}（${stats.overview.peak_day[1]} 条）；最慢请求：${esc(peak ? peak.module + '.' + peak.action + ' @ ' + peak.day + ' = ' + round(peak.duration_ms, 2) + ' ms' : '无')}。</p>
</section>

<footer>
  <strong>真实性声明：</strong>本页所有数字、图表与表格均由脚本逐行解析上述真实日志得出，没有生成、补齐或推测任何日志行。
  复现命令：<code>node 02-200Days-Challenge/日志洞察/运行日志分析.js</code>。
  当前最长连续 ${streak.max} 天、当前连续 ${streak.current} 天；若课程要求「连续 7 天」，须继续真实使用并同步，不得通过改写历史日志达成。
</footer>
</div>
</body>
</html>
`;

/* ---------------- 4. 文字报告 ---------------- */

const md = `# 真实运行日志分析报告

> 生成方式：\`node 02-200Days-Challenge/日志洞察/运行日志分析.js\`
> 数据来源：\`process_logs/YYYY-MM-DD.jsonl\`，共 ${files.length} 个文件，由真实 HTTP 请求自动落盘。
> 生成时间：${stats.generated_at}
> **真实性声明**：本报告所有数值由脚本逐行解析上述日志得出，未生成、未补齐、未推测任何日志行。

## 一、总览

| 指标 | 数值 |
| --- | --- |
| 解析成功的日志条数 | ${records.length} |
| 解析失败行数 | ${badLines} |
| 有日志的自然日 | ${dayList.length} 天（${firstDay} ~ ${lastDay}） |
| 区间自然日总数 | ${axis.length} 天 |
| 断档天数 / 日期 | ${stats.overview.gap_days} 天 ／ ${stats.overview.gap_dates.join('、') || '无'} |
| 最长连续天数 | ${streak.max} 天（结束于 ${streak.max_end}） |
| 当前连续天数 | ${streak.current} 天 |
| 非 ok 状态 | ${errored} 条，错误率 ${stats.overview.error_rate}% |
| 峰值日 | ${stats.overview.peak_day[0]}，${stats.overview.peak_day[1]} 条 |
| 最慢请求 | ${peak ? peak.module + '.' + peak.action + ' @ ' + peak.day + '，' + round(peak.duration_ms, 2) + ' ms' : '无'} |

## 二、来源与版本口径

| 来源标记 | 条数 | 占比 |
| --- | --- | --- |
${top(bySource, 20).map(([k, v]) => '| ' + k + ' | ' + v + ' | ' + round(v / records.length * 100, 2) + '% |').join('\n')}

版本分布：${top(byVersion, 20).map(([k, v]) => k + ' = ' + v).join('、')}。

> 说明：\`source\` 字段用于把真实运行与隔离冒烟测试区分开。若存在 smoke 记录，应单独说明其来源，不能与真实运行混算；本表按日志原样统计，不做剔除。

## 三、调用分布

模块 Top 10：${top(byModule, 10).map(([k, v]) => k + '(' + v + ')').join('、')}。

动作 Top 10：${top(byAction, 10).map(([k, v]) => k + '(' + v + ')').join('、')}。

状态分布：${top(byStatus, 10).map(([k, v]) => k + '(' + v + ')').join('、')}。

错误码分布：${top(byError, 10).map(([k, v]) => k + '(' + v + ')').join('、')}。

## 四、耗时

样本 ${durations.length} 条，最小 ${stats.duration_ms.min} ms，均值 ${stats.duration_ms.mean} ms，
P50 ${stats.duration_ms.p50} ms，P90 ${stats.duration_ms.p90} ms，P95 ${stats.duration_ms.p95} ms，
P99 ${stats.duration_ms.p99} ms，最大 ${stats.duration_ms.max} ms。

| 区间 | 条数 |
| --- | --- |
${histogram.map(b => '| ' + b.label + ' | ' + b.count + ' |').join('\n')}

## 五、结论（只陈述数据能支撑的部分）

1. 日志累计覆盖 ${dayList.length} 个自然日、${records.length} 条记录，但区间内断档 ${stats.overview.gap_days} 天，**最长连续仅 ${streak.max} 天、当前连续 ${streak.current} 天**；若题目按「连续 7 天」评分，目前**未达标**，且不能通过补写历史日期达成。
2. 错误率 ${stats.overview.error_rate}%（${errored} / ${records.length}）。错误码集中在 ${top(byError, 5).filter(([k]) => k !== '(空)').map(([k, v]) => k + '(' + v + ')').join('、')} 等鉴权/参数校验类，多与未登录探测、越权校验和隔离测试有关。${top(bySource, 20).find(([k]) => k === '(空)') ? '注意：早期日志尚无 \`source\` 字段（' + (bySource['(空)'] || 0) + ' 条），无法逐条区分测试与真实访问，因此本报告不把该错误率解释为线上故障率。' : ''}
3. P95 ${stats.duration_ms.p95} ms，最慢一条为 ${peak ? round(peak.duration_ms, 2) + ' ms（' + peak.module + '.' + peak.action + '）' : '无'}；该量级说明本地 JSON 存储与同步写入路径整体轻量，但样本来自开发/试用场景，不能外推为并发性能结论。
4. 峰值日 ${stats.overview.peak_day[0]} 的 ${stats.overview.peak_day[1]} 条记录对应集中开发与回归测试，属于真实运行过程，不是均匀分布的生产流量。

## 六、局限

- 日志按本地开发环境采集，用户规模、并发量与真实部署不同。
- \`duration_ms\` 为服务端单次请求耗时，不含浏览器渲染与网络往返。
- 缺省字段按 \`(空)\` 单列统计，不做填充。
- 本报告不包含账号、通知正文、反馈内容等业务数据，日志本身已脱敏。

## 七、复现

\`\`\`bash
cd E:\\校园软件
node 02-200Days-Challenge/日志洞察/运行日志分析.js
\`\`\`

脚本会重新读取全部 \`process_logs/*.jsonl\`，覆盖生成 \`统计结果.json\`、\`运行数据看板.html\` 与本报告。输入文件的字节数、行数、SHA256 记录于 \`统计结果.json\`，可用于核对数据是否被改动。
`;

/* ---------------- 5. 写出 ---------------- */

fs.writeFileSync(path.join(HERE, '统计结果.json'), JSON.stringify(stats, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(HERE, '运行数据看板.html'), html, 'utf8');
fs.writeFileSync(path.join(HERE, '分析报告.md'), md, 'utf8');

console.log('[日志洞察] 输入文件 ' + files.length + ' 个，解析 ' + records.length + ' 条，失败 ' + badLines + ' 行');
console.log('[日志洞察] 有日志 ' + dayList.length + ' 天，最长连续 ' + streak.max + ' 天，当前连续 ' + streak.current + ' 天，断档 ' + stats.overview.gap_days + ' 天');
console.log('[日志洞察] 已生成 统计结果.json / 运行数据看板.html / 分析报告.md');
