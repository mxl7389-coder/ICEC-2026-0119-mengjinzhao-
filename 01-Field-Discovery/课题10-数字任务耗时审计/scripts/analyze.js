#!/usr/bin/env node
/* 课题10 耗时对比分析：零依赖，只读取本人实测 CSV，绝不生成虚构数据。
 * 用法：node scripts/analyze.js
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CSV = path.join(ROOT, 'raw_data', '耗时对比记录表.csv');
const OUT_SVG = path.join(ROOT, 'report', '耗时对比图.svg');
const OUT_MD = path.join(ROOT, 'report', '统计摘要.md');
const TOTAL = 10;

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
function yes(v) { return String(v).trim() === '是'; }

if (!fs.existsSync(CSV)) {
  console.error('[analyze] 找不到 raw_data/耗时对比记录表.csv');
  process.exit(1);
}

const rows = parseCsv(fs.readFileSync(CSV, 'utf8'));
const filled = rows.filter((r) =>
  num(r['人工耗时_秒']) !== null && num(r['AI耗时_秒']) !== null &&
  (r['人工结果正确_是或否'] === '是' || r['人工结果正确_是或否'] === '否') &&
  (r['AI结果正确_是或否'] === '是' || r['AI结果正确_是或否'] === '否')
);

if (filled.length < TOTAL) {
  console.log('[analyze] 耗时数据 ' + filled.length + '/' + TOTAL + ' 行，还差 ' + (TOTAL - filled.length) + ' 行。');
  console.log('[analyze] 未生成图表或统计：请先在 CSV 填入本人实测数据（耗时与正确性判定）后再运行。');
  process.exit(0);
}

const human = filled.map((r) => num(r['人工耗时_秒']));
const ai = filled.map((r) => num(r['AI耗时_秒']));
const labels = filled.map((r) => r['样本编号'] || '');
const sum = (a) => a.reduce((s, v) => s + v, 0);
const hSum = sum(human), aSum = sum(ai);
const speedup = aSum > 0 ? hSum / aSum : null;
const saved = hSum - aSum;
const savedPct = hSum > 0 ? (saved / hSum) * 100 : null;
const hOk = filled.filter((r) => yes(r['人工结果正确_是或否'])).length;
const aOk = filled.filter((r) => yes(r['AI结果正确_是或否'])).length;
const rework = (key) => sum(filled.map((r) => num(r[key]) || 0));
const hRe = rework('人工返工次数'), aRe = rework('AI返工次数');
const slower = labels.filter((_, i) => ai[i] > human[i]);

// --- SVG: grouped bars ---
const W0 = 820, H0 = 380, L0 = 60, R0 = 30, T0 = 40, B0 = 60;
const plotW = W0 - L0 - R0, plotH = H0 - T0 - B0;
const maxV = Math.max(Math.max.apply(null, human.concat(ai)), 1) * 1.2;
const groupW = plotW / filled.length;
const bw = Math.min(20, groupW / 2 - 4);
const py = (v) => T0 + plotH - (plotH * v) / maxV;
let svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + W0 + ' ' + H0 + '" width="' + W0 + '" height="' + H0 + '">';
svg += '<rect width="' + W0 + '" height="' + H0 + '" fill="#ffffff"/>';
svg += '<text x="' + L0 + '" y="24" font-size="16" font-family="sans-serif" fill="#1f2937">耗时对比图 · 人工 vs AI（10 个样本，含粘贴与核对）</text>';
for (let g = 0; g <= 4; g++) {
  const yy = T0 + (plotH * g) / 4;
  svg += '<line x1="' + L0 + '" y1="' + yy + '" x2="' + (W0 - R0) + '" y2="' + yy + '" stroke="#e5e7eb"/>';
  svg += '<text x="' + (L0 - 8) + '" y="' + (yy + 4) + '" font-size="11" text-anchor="end" fill="#6b7280">' + fmt(maxV - (maxV * g) / 4, 0) + '</text>';
}
filled.forEach((_, i) => {
  const cx = L0 + groupW * (i + 0.5);
  svg += '<rect x="' + (cx - bw - 2) + '" y="' + py(human[i]) + '" width="' + bw + '" height="' + (T0 + plotH - py(human[i])) + '" fill="#93c5fd"/>';
  svg += '<rect x="' + (cx + 2) + '" y="' + py(ai[i]) + '" width="' + bw + '" height="' + (T0 + plotH - py(ai[i])) + '" fill="#f59e0b"/>';
  svg += '<text x="' + cx + '" y="' + (H0 - B0 + 18) + '" font-size="10" text-anchor="middle" fill="#6b7280">' + esc(labels[i]) + '</text>';
});
svg += '<line x1="' + L0 + '" y1="' + (H0 - B0) + '" x2="' + (W0 - R0) + '" y2="' + (H0 - B0) + '" stroke="#9ca3af"/>';
svg += '<rect x="' + (W0 - R0 - 210) + '" y="' + (T0 - 26) + '" width="12" height="12" fill="#93c5fd"/><text x="' + (W0 - R0 - 192) + '" y="' + (T0 - 16) + '" font-size="11" fill="#374151">人工</text>';
svg += '<rect x="' + (W0 - R0 - 130) + '" y="' + (T0 - 26) + '" width="12" height="12" fill="#f59e0b"/><text x="' + (W0 - R0 - 112) + '" y="' + (T0 - 16) + '" font-size="11" fill="#374151">AI</text>';
svg += '<text x="' + L0 + '" y="' + (H0 - 18) + '" font-size="11" fill="#6b7280">纵轴：耗时（秒）　横轴：样本编号</text>';
svg += '</svg>';
fs.writeFileSync(OUT_SVG, svg, 'utf8');

const lines = [
  '# 课题 10 · 统计摘要',
  '',
  '> 本文件由 `node scripts/analyze.js` 从 `raw_data/耗时对比记录表.csv` 自动生成，全部数值来自本人实测记录。',
  '',
  '| 指标 | 数值 | 说明 |',
  '| --- | --- | --- |',
  '| 有效样本数 | ' + filled.length + ' | 条 |',
  '| 人工组总耗时 | ' + fmt(hSum, 0) + ' | 秒，平均 ' + fmt(hSum / filled.length) + ' 秒/条 |',
  '| AI 组总耗时 | ' + fmt(aSum, 0) + ' | 秒，平均 ' + fmt(aSum / filled.length) + ' 秒/条（含粘贴与核对） |',
  '| 提速倍数 | ' + (speedup ? fmt(speedup) : '数据不足') + ' | 人工总耗时 ÷ AI 总耗时 |',
  '| 节省时间 | ' + fmt(saved, 0) + ' | 秒，约 ' + (savedPct ? fmt(savedPct, 1) : '—') + '% |',
  '| 人工组正确率 | ' + fmt((hOk / filled.length) * 100, 0) + '% | ' + hOk + '/' + filled.length + ' 条 5 字段全对 |',
  '| AI 组正确率 | ' + fmt((aOk / filled.length) * 100, 0) + '% | ' + aOk + '/' + filled.length + ' 条 5 字段全对 |',
  '| 返工次数合计 | 人工 ' + fmt(hRe, 0) + ' / AI ' + fmt(aRe, 0) + ' | 次 |',
  '| AI 反而更慢的样本 | ' + (slower.length ? slower.join('、') : '无') + ' | 需在报告中解释原因 |',
  '',
  '图表：`report/耗时对比图.svg`。提速结论必须结合正确率一起看，规则见 `report/人机校验规则.md`。',
  ''
];
fs.writeFileSync(OUT_MD, lines.join('\n'), 'utf8');

console.log('[analyze] 已生成 report/耗时对比图.svg 与 report/统计摘要.md');
console.log('[analyze] 人工 ' + fmt(hSum, 0) + 's，AI ' + fmt(aSum, 0) + 's，提速 ' + (speedup ? fmt(speedup) : '—') + ' 倍；正确率 人工 ' + hOk + '/' + filled.length + '、AI ' + aOk + '/' + filled.length);
