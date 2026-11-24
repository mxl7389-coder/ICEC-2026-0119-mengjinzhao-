// 课题 04 零依赖复算脚本：node 复算.js
// 读取 raw_data/示例_模拟数据_非实测.csv，重算全部指标，
// 并与 report/统计结果.json 逐项比对，验证报告中的数字可复现。
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const csvPath = path.join(dir, 'raw_data', '示例_模拟数据_非实测.csv');
const jsonPath = path.join(dir, 'report', '统计结果.json');

const text = fs.readFileSync(csvPath, 'utf8').replace(/^\uFEFF/, '');
const lines = text.trim().split(/\r?\n/);
const body = lines.slice(1).filter((l) => l.trim());

// 列：0序号 1时点(min) 2观测时间 3队列长度 4本时段到达人数 5窗口数 6单人服务时长 7备注
const rows = body.map((line) => {
  const c = line.split(',');
  const t = Number(c[1]);
  const L = Number(c[3]);
  const arr = Number(c[4]);
  const win = Number(c[5]);
  const srv = Number(c[6]);
  const lam = arr / 2;
  const mu = win * 60 / srv;
  return { t, L, arr, win, srv, lam, mu, rho: lam / mu, W: L / lam * 60 };
});

let cumArr = 0;
let cumOut = 0;
for (const r of rows) {
  cumArr += r.arr;
  cumOut += r.mu * 2;
}
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const Ls = rows.map((r) => r.L);
const lams = rows.map((r) => r.lam);
const mus = rows.map((r) => r.mu);
const rhos = rows.map((r) => r.rho);
const srvs = rows.map((r) => r.srv);
const Ws = rows.map((r) => r.W);
const peak = rows.reduce((a, b) => (b.rho > a.rho ? b : a));
const Lmax = Math.max(...Ls);
const arrPeak = rows.reduce((a, b) => (b.arr > a.arr ? b : a));

const calc = {
  rows: rows.length,
  avg_L: mean(Ls),
  L_first: Ls[0],
  L_last: Ls[Ls.length - 1],
  L_max: Lmax,
  L_max_at: rows[Ls.indexOf(Lmax)].t,
  L_growth_pct: (Ls[Ls.length - 1] - Ls[0]) / Ls[0] * 100,
  avg_lam: mean(lams),
  avg_mu: mean(mus),
  avg_rho: mean(rhos),
  rho_max: peak.rho,
  rho_max_at: peak.t,
  rho_over_1_count: rhos.filter((x) => x > 1).length,
  srv_mean: mean(srvs),
  srv_min: Math.min(...srvs),
  srv_max: Math.max(...srvs),
  srv_ratio: Math.max(...srvs) / Math.min(...srvs),
  W_mean: mean(Ws),
  arr_total: cumArr,
  out_total: cumOut,
  backlog_end: cumArr - cumOut,
  arr_peak: arrPeak.arr,
  arr_peak_at: arrPeak.t,
};

console.log('课题 04 · 复算（数据源：' + path.basename(csvPath) + '，' + rows.length + ' 组）');
console.log('平均队列长度 L = ' + calc.avg_L.toFixed(2) + ' 人');
console.log('平均到达率 λ = ' + calc.avg_lam.toFixed(2) + ' 人/分钟');
console.log('平均服务率 μ = ' + calc.avg_mu.toFixed(2) + ' 人/分钟');
console.log('ρ 峰值 = ' + calc.rho_max.toFixed(3) + '（T+' + calc.rho_max_at + '）');
console.log('期末积压 = ' + calc.backlog_end.toFixed(2) + ' 人');

const saved = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
let fail = 0;
for (const [k, v] of Object.entries(calc)) {
  const ref = saved[k];
  if (typeof ref !== 'number' || Math.abs(ref - v) > 1e-6) {
    console.log('MISMATCH ' + k + ': json=' + ref + ' calc=' + v);
    fail++;
  }
}
console.log(fail === 0
  ? 'PASS：' + Object.keys(calc).length + ' 项指标与 report/统计结果.json 完全一致'
  : 'FAIL：' + fail + ' 项不一致');
process.exitCode = fail === 0 ? 0 : 1;
