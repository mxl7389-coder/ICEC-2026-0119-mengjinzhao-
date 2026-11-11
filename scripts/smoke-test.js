'use strict';
/**
 * 冒烟测试：一条命令拉起独立实例（端口 5199 + 隔离数据目录），
 * 跑通全部接口并真实产生 telemetry 日志，最后清理测试业务数据。
 *
 *   node scripts/smoke-test.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const telemetry = require('../lib/telemetry');

const ROOT = path.join(__dirname, '..');
const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;
const SMOKE_DIR = path.join(ROOT, 'data', '__smoke__');
const results = [];

async function req(method, urlPath, body) {
  const res = await fetch(BASE + urlPath, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Session-Id': 'smoke-test-runner' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
}
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log((condition ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  → ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { const r = await req('GET', '/api/health'); if (r.status === 200) return true; } catch (_) {}
    await sleep(150);
  }
  return false;
}

async function main() {
  console.log('\n== CampusDesk 冒烟测试 ==\n');
  if (!fs.existsSync(SMOKE_DIR)) fs.mkdirSync(SMOKE_DIR, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), CAMPUSDESK_DATA_DIR: SMOKE_DIR, APP_VERSION: 'v1.0.0' },
  });

  try {
    if (!await waitReady()) throw new Error('服务未能启动');
    check('服务健康检查', (await req('GET', '/api/health')).data.ok);

    const boot = await req('GET', '/api/bootstrap');
    check('bootstrap 全量数据', boot.status === 200 && boot.data.samples.length === 3,
      '器材 ' + boot.data.equipment.items.length + ' 类');

    // 通知提取：三条真实示例 + 一条故意报错
    const samples = boot.data.samples;
    let savedId = null;
    for (const s of samples) {
      const r = await req('POST', '/api/notice/parse', { text: s.text });
      check('通知解析 · ' + s.label, r.status === 200 && r.data.title,
        'conf=' + (r.data.confidence || 0) + '% date=' + (r.data.event_date || '-'));
      if (!savedId && r.status === 200) {
        const save = await req('POST', '/api/notice/save', { notice: r.data });
        savedId = save.data.id;
      }
    }
    check('通知保存与列表', savedId && (await req('GET', '/api/notice/list')).data.items.length >= 1);
    check('待办勾选', (await req('POST', '/api/notice/toggle', { id: savedId })).status === 200);
    const ics = await req('GET', '/api/notice/ics?id=' + savedId);
    check('日历 .ics 导出', ics.status === 200 && String(ics.data).includes('BEGIN:VCALENDAR'));
    const empty = await req('POST', '/api/notice/parse', { text: '' });
    check('错误路径 · 空通知被拦截并记录', empty.status === 400 && empty.data.error === 'EMPTY_NOTICE');

    // 器材借还
    const eq = (await req('GET', '/api/equipment/list')).data;
    const item = eq.items[0];
    const addEq = await req('POST', '/api/equipment/add', { name: '测试用垫子', total: 3, category: '体育器材' });
    check('新增器材', addEq.status === 200 && addEq.data.items.some((i) => i.name === '测试用垫子'));
    const loan = await req('POST', '/api/loan/create', {
      item_id: item.id, borrower: '测试同学', qty: 2, due_date: '2026-11-01', purpose: '冒烟测试',
    });
    check('借出登记（构造逾期）', loan.status === 200 && loan.data.overdue_count >= 1,
      '逾期 ' + loan.data.overdue_count + ' 笔');
    const loanRow = loan.data.loans.find((l) => l.borrower === '测试同学');
    const partial = await req('POST', '/api/loan/return', { id: loanRow.id, returned_qty: 1 });
    check('部分归还核对', partial.data.loans.find((l) => l.id === loanRow.id).left === 1);
    const full = await req('POST', '/api/loan/return', { id: loanRow.id, returned_qty: 1 });
    check('全部归还核对', full.data.loans.find((l) => l.id === loanRow.id).status === 'returned');
    const over = await req('POST', '/api/loan/create', { item_id: item.id, borrower: '超额', qty: 9999, due_date: '2026-12-01' });
    check('错误路径 · 库存不足被拦截', over.status === 400 && over.data.error === 'OUT_OF_STOCK');

    // 错题
    const ms = await req('POST', '/api/mistake/add', {
      title: '测试题：函数定义域', subject: '数学', knowledge: '函数',
      wrong_reason: '漏看定义域', correct_answer: '先求定义域',
    });
    check('错题录入', ms.status === 200 && ms.data.next_review);
    const r1 = await req('POST', '/api/mistake/review', { id: ms.data.id, result: 'ok' });
    check('复习进阶', r1.data.stage === 1);
    const r2 = await req('POST', '/api/mistake/review', { id: ms.data.id, result: 'again' });
    check('复习重置', r2.data.stage === 0 && r2.data.review_count === 2);
    check('错题列表', (await req('GET', '/api/mistake/list')).data.items.length === 1);

    // 反馈 + 日志
    const fb = await req('POST', '/api/feedback/add', { role: '自动化测试', module: '整体', score: 4 });
    check('反馈提交', fb.status === 200);
    check('未知路由返回 404', (await req('GET', '/api/not-exist')).status === 404);
    const logs = await req('GET', '/api/logs?days=7');
    check('日志汇总可用', logs.data.total_calls > 10, '本次累计 ' + logs.data.total_calls + ' 次调用');
    check('日志含报错记录', (logs.data.by_status.error || 0) >= 3, '报错 ' + (logs.data.by_status.error || 0) + ' 次');
    const day = await req('GET', '/api/logs/day?date=' + telemetry.localDay());
    check('按天读取日志', day.data.rows.length > 0);
    const report = await req('POST', '/api/logs/report', {});
    check('当日日报生成', report.data.ok);

    const pass = results.filter((r) => r.ok).length;
    console.log('\n结果：' + pass + '/' + results.length + ' 项通过');
    console.log('日志已写入 process_logs/（真实自动采集，未做任何填充）\n');
    if (pass !== results.length) process.exitCode = 1;
  } finally {
    child.kill();
    // 只清理本脚本创建的隔离数据目录，绝不触碰日常 data/*.json
    if (SMOKE_DIR.endsWith('__smoke__') && fs.existsSync(SMOKE_DIR)) {
      fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
    }
  }
}

main().catch((err) => { console.error('[smoke-test] 失败：', err); process.exitCode = 1; });
