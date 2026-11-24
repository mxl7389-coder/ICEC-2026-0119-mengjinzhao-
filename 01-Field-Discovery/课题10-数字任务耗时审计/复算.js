// 课题 10 零依赖复算脚本：node 复算.js
// 读取 raw_data/示例_模拟数据_非实测.csv，重算汇总指标与 6 项校验，
// 并与 report/统计结果.json 逐项比对，验证报告中的数字可复现。
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const csvPath = path.join(dir, 'raw_data', '示例_模拟数据_非实测.csv');
const jsonPath = path.join(dir, 'report', '统计结果.json');

const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
const lines = text.trim().split(/\r?\n/);
const body = lines.slice(1).filter((l) => l.trim());
const TYPES = ['学习', '创作', '事务', '娱乐', '社交'];

// 列：0序号 1日期 2任务名称 3类型 4计划 5开始 6结束 7实际 8中断次数 9中断原因 10专注 11完成度 12备注
const hm = (s) => {
  const [h, m] = s.trim().split(':').map(Number);
  return h * 60 + m;
};
const rows = body.map((line) => {
  const c = line.split(',');
  const plan = Number(c[4]);
  const act = Number(c[7]);
  const intr = Number(c[8]);
  const focus = Number(c[10]);
  return {
    date: c[1], typ: c[3], plan, act, intr,
    reason: (c[9] || '').trim(), focus,
    start: hm(c[5]), end: hm(c[6]),
    dev: (act - plan) / plan * 100,
    focusRate: focus / act * 100,
  };
});

const total = rows.reduce((s, r) => s + r.act, 0);
const perDay = {};
const intrPerDay = {};
const reasons = {};
const checks = { R1: 0, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0 };
for (const r of rows) {
  perDay[r.date] = (perDay[r.date] || 0) + r.act;
  intrPerDay[r.date] = (intrPerDay[r.date] || 0) + r.intr;
  if (r.reason) reasons[r.reason] = (reasons[r.reason] || 0) + r.intr;
  if (r.end > r.start) checks.R1++;
  if (Math.abs((r.end - r.start) - r.act) <= 2) checks.R2++;
  if (r.focus <= r.act) checks.R3++;
  if (TYPES.includes(r.typ)) checks.R4++;
  const ok6 = (r.intr > 0 && !!r.reason) || (r.intr === 0 && !r.reason);
  if (ok6) checks.R6++;
}
checks.R5 = Object.values(perDay).filter((v) => v <= 960).length;

const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const byType = TYPES.map((t) => {
  const sub = rows.filter((r) => r.typ === t);
  const hours = sub.reduce((s, r) => s + r.act, 0);
  return {
    typ: t, count: sub.length, hours: hours / 60, pct: hours / total * 100,
    avg_dev: mean(sub.map((r) => r.dev)),
    avg_focus: mean(sub.map((r) => r.focusRate)),
  };
}).filter((x) => x.count > 0);
const rank = Object.entries(reasons).sort((a, b) => b[1] - a[1]);
const intrTotal = rows.reduce((s, r) => s + r.intr, 0);
const intrPeakDay = Object.keys(intrPerDay).reduce((a, b) =>
  intrPerDay[b] > intrPerDay[a] ? b : a);

const calc = {
  rows: rows.length,
  days: Object.keys(perDay).length,
  total_min: total,
  total_hours: total / 60,
  avg_dev: mean(rows.map((r) => r.dev)),
  avg_focus: mean(rows.map((r) => r.focusRate)),
  intr_total: intrTotal,
  intr_top2_pct: (rank[0][1] + rank[1][1]) / intrTotal * 100,
  intr_density: intrTotal / (total / 60),
  intr_peak_day_count: intrPerDay[intrPeakDay],
};
const calcByType = {};
for (const x of byType) calcByType[x.typ] = x;

console.log('课题 10 · 复算（数据源：' + path.basename(csvPath) + '，' + rows.length + ' 条 / ' + calc.days + ' 天）');
console.log('总时长 = ' + calc.total_hours.toFixed(2) + ' 小时');
console.log('平均计划偏差 = ' + calc.avg_dev.toFixed(2) + '%');
console.log('平均专注率 = ' + calc.avg_focus.toFixed(2) + '%');
console.log('前两位中断原因占比 = ' + calc.intr_top2_pct.toFixed(2) + '%');
console.log('6 项校验 = ' + JSON.stringify(checks));

const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let fail = 0;
const cmp = (label, a, b) => {
  if (typeof b !== 'number' || Math.abs(a - b) > 1e-6) {
    console.log('MISMATCH ' + label + ': json=' + b + ' calc=' + a);
    fail++;
  }
};
for (const [k, v] of Object.entries(calc)) cmp(k, v, saved[k]);
for (const [k, v] of Object.entries(checks)) cmp('checks.' + k, v, saved.checks[k]);
for (const x of byType) {
  const ref = (saved.by_type || []).find((y) => y.typ === x.typ);
  if (!ref) { console.log('MISMATCH by_type.' + x.typ + ': missing'); fail++; continue; }
  for (const k of ['count', 'hours', 'pct', 'avg_dev', 'avg_focus']) cmp('by_type.' + x.typ + '.' + k, x[k], ref[k]);
}
console.log(fail === 0
  ? 'PASS：汇总指标、分类汇总与 6 项校验均与 report/统计结果.json 一致'
  : 'FAIL：' + fail + ' 项不一致');
process.exitCode = fail === 0 ? 0 : 1;
