#!/usr/bin/env node
/* 课题04 排队时序分析：零依赖，只读取本人实测 CSV，绝不生成虚构数据。
 * 用法：node scripts/analyze.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSV = path.join(ROOT, 'raw_data', '排队时序记录表.csv');
const OUT_SVG = path.join(ROOT, 'report', '排队时序图.svg');
const OUT_MD = path.join(ROOT, 'report', '统计摘要.md');
const TOTAL = 15;
const WINDOW_MIN = 30;

function parseCsv(text) {
  const clean = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  const lines = clean.split('\n').filter((l) => l.trim().length);
  const head = lines[0].split(',').map((s) => s.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => { row[h] = (cells[i] || '').trim(); });
    return row;
  });
}

function num(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmt(n, d) { return Number(n).toFixed(d === undefined ? 2 : d); }

if (!fs.existsSync(CSV)) {
  console.error('[analyze] 找不到 raw_data/排队时序记录表.csv');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const filled = rows.filter((r) => num(r['队列长度_人']) !== null && num(r['区间到达人数_人']) !== null);

if (filled.length < TOTAL) {
  console.log('[analyze] 排队数据 ' + filled.length + '/' + TOTAL + ' 行，还差 ' + (TOTAL - filled.length) + ' 行。');
  console.log('[analyze] 未生成图表或统计：请先在 CSV 填入本人实测数据后再运行。');
  process.exit(0);
}

const x = filled.map((r) => num(r['相对分钟']));
const q = filled.map((r) => num(r['队列长度_人']));
const arrivals = filled.map((r) => num(r['区间到达人数_人']));
const service = filled.map((r) => num(r['单次服务耗时_秒'])).filter((v) => v !== null && v > 0);
const windows = filled.map((r) => num(r['服务窗口数_个'])).filter((v) => v !== null && v > 0);

const sum = (a) => a.reduce((s, v) => s + v, 0);
const avg = (a) => sum(a) / a.length;
const L = avg(q);
const peak = Math.max.apply(null, q);
const peakAt = x[q.indexOf(peak)];
const lambda = sum(arrivals) / WINDOW_MIN;
const avgService = service.length ? avg(service) : null;
const avgWindows = windows.length ? avg(windows) : 1;
const mu = avgService ? (60 / avgService) * avgWindows : null;
const rho = mu ? lambda / mu : null;
const W = lambda > 0 ? L / lambda : null;

// --- SVG: queue length line + arrivals bars ---
const W0 = 800, H0 = 380, L0 = 60, R0 = 30, T0 = 40, B0 = 60;
const plotW = W0 - L0 - R0, plotH = H0 - T0 - B0;
const maxQ = Math.max(peak, 1) * 1.2;
const maxA = Math.max(Math.max.apply(null, arrivals), 1) * 1.2;
const px = (i) => L0 + (plotW * i) / (filled.length - 1);
const py = (v, max) => T0 + plotH - (plotH * v) / max;
let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W0 + ' ' + H0 + '" width="' + W0 + '" height="' + H0 + '">';
svg += '<rect width="' + W0 + '" height="' + H0 + '" fill="#ffffff"/>';
svg += '<text x="' + L0 + '" y="24" font-size="16" font-family="sans-serif" fill="#1f2937">排队时序图 · 队列长度与区间到达人数</text>';
for (let g = 0; g <= 4; g++) {
  const yy = T0 + (plotH * g) / 4;
  svg += '<line x1="' + L0 + '" y1="' + yy + '" x2="' + (W0 - R0) + '" y2="' + yy + '" stroke="#e5e7eb"/>';
  svg += '<text x="' + (L0 - 8) + '" y="' + (yy + 4) + '" font-size="11" text-anchor="end" fill="#6b7280">' + fmt(maxQ - (maxQ * g) / 4, 0) + '</text>';
}
arrivals.forEach((a, i) => {
  const bw = Math.max(6, plotW / filled.length - 6);
  const bh = (plotH * a) / maxA;
  svg += '<rect x="' + (px(i) - bw / 2) + '" y="' + (T0 + plotH - bh) + '" width="' + bw + '" height="' + bh + '" fill="#bfdbfe" opacity="0.8"/>';
});
svg += '<polyline fill="none" stroke="#dc2626" stroke-width="2.5" points="' +
  q.map((v, i) => px(i) + ',' + py(v, maxQ)).join(' ') + '"/>';
q.forEach((v, i) => {
  svg += '<circle cx="' + px(i) + '" cy="' + py(v, maxQ) + '" r="3.2" fill="#dc2626"/>';
});
x.forEach((v, i) => {
  svg += '<text x="' + px(i) + '" y="' + (H0 - B0 + 18) + '" font-size="10" text-anchor="middle" fill="#6b7280">' + esc(v) + '</text>';
});
svg += '<line x1="' + L0 + '" y1="' + (H0 - B0) + '" x2="' + (W0 - R0) + '" y2="' + (H0 - B0) + '" stroke="#9ca3af"/>';
svg += '<text x="' + (W0 - R0) + '" y="' + (H0 - 18) + '" font-size="11" text-anchor="end" fill="#6b7280">相对分钟（每 2 分钟一组，共 15 组）</text>';
svg += '<text x="' + L0 + '" y="' + (H0 - 18) + '" font-size="11" fill="#dc2626">红线：队列长度（人）　蓝柱：区间到达人数（人）</text>';
svg += '</svg>';
fs.writeFileSync(OUT_SVG, svg, 'utf8');

const lines = [
  '# 课题 04 · 统计摘要',
  '',
  '> 本文件由 `node scripts/analyze.js` 从 `raw_data/排队时序记录表.csv` 自动生成，全部数值来自本人实测记录。',
  '',
  '| 指标 | 数值 | 单位 / 说明 |',
  '| --- | --- | --- |',
  '| 有效记录组数 | ' + filled.length + ' | 组 |',
  '| 平均队列长度 L | ' + fmt(L) + ' | 人 |',
  '| 峰值队列长度 | ' + fmt(peak, 0) + ' | 人，出现在 T+' + esc(peakAt) + ' |',
  '| 平均到达率 λ | ' + fmt(lambda) + ' | 人/分钟（区间到达合计 ' + fmt(sum(arrivals), 0) + ' 人 ÷ 30 分钟） |',
  '| 平均单次服务耗时 | ' + (avgService ? fmt(avgService) : '数据不足') + ' | 秒，基于 ' + service.length + ' 个有效样本 |',
  '| 平均服务窗口数 | ' + fmt(avgWindows) + ' | 个 |',
  '| 平均服务率 μ | ' + (mu ? fmt(mu) : '数据不足') + ' | 人/分钟 |',
  '| 利用率 ρ = λ/μ | ' + (rho ? fmt(rho) : '数据不足') + ' | ' + (rho && rho >= 1 ? '≥1，服务台饱和，队列会持续变长' : '若 <1，服务能力有余量') + ' |',
  '| 估计平均等待 W ≈ L/λ | ' + (W ? fmt(W) : '数据不足') + ' | 分钟（Little 法则） |',
  '',
  '图表：`report/排队时序图.svg`。结论与改进方案请填入 `report/分析报告骨架.md`。',
  ''
];
fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');

console.log('[analyze] 已生成 report/排队时序图.svg 与 report/统计摘要.md');
console.log('[analyze] 平均队列 ' + fmt(L) + ' 人，峰值 ' + fmt(peak, 0) + ' 人（T+' + peakAt + '），λ=' + fmt(lambda) + '，ρ=' + (rho ? fmt(rho) : '数据不足'));
