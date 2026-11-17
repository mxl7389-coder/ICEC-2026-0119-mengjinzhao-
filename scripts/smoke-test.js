'use strict';
/**
 * 冒烟测试：拉起独立实例（端口 5199 + 隔离数据目录），验证
 * 登录鉴权 / 角色权限 / 零预置数据 / SSE 实时日志 / 全部业务接口。
 *
 * 测试账号与业务记录只写入 data/__smoke__，结束后整个目录删除；
 * 不会向日常 data/*.json 添加任何数据。运行日志是真实请求产生，不做填充。
 *
 *   node scripts/smoke-test.js
 */
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const telemetry = require('../lib/telemetry');
const extractor = require('../lib/extractor');

const ROOT = path.join(__dirname, '..');
const PORT = 5199;
const BASE = 'http://127.0.0.1:' + PORT;
const SMOKE_DIR = path.join(ROOT, 'data', '__smoke__');
const results = [];

/** 每个会话独立保存 Cookie，模拟不同角色同时在线 */
function makeSession() {
  let cookie = '';
  return {
    get cookie() { return cookie; },
    async req(method, urlPath, body, opts) {
      const headers = { 'Content-Type': 'application/json' };
      if (cookie) headers.Cookie = cookie;
      const res = await fetch(BASE + urlPath, {
        method, headers,
        redirect: (opts && opts.redirect) || 'follow',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const sc = res.headers.get('set-cookie');
      if (sc) {
        const raw = sc.split(';')[0];
        cookie = raw.replace(/^cd_session=/, '') ? raw : '';
      }
      const ct = res.headers.get('content-type') || '';
      const data = ct.includes('json') ? await res.json() : await res.text();
      return { status: res.status, data, headers: res.headers, location: res.headers.get('location') };
    },
  };
}
function check(name, condition, detail) {
  results.push({ name, ok: !!condition, detail });
  console.log((condition ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  → ' + detail : ''));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(anon) {
  for (let i = 0; i < 40; i++) {
    try { const r = await anon.req('GET', '/api/health'); if (r.status === 200) return true; } catch (_) {}
    await sleep(150);
  }
  return false;
}

/* --------------------------- SSE 读取工具 --------------------------- */
function readWithTimeout(reader, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('stream-timeout')), ms);
    reader.read().then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
function streamReader(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const state = { buf: '', done: false };
  async function until(predicate, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !state.done) {
      const chunk = await readWithTimeout(reader, Math.max(200, deadline - Date.now()))
        .catch(() => ({ done: true, value: undefined }));
      if (chunk.done) { state.done = true; break; }
      state.buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = state.buf.indexOf('\n\n')) >= 0) {
        const block = state.buf.slice(0, idx);
        state.buf = state.buf.slice(idx + 2);
        const ev = /^event: (.+)$/m.exec(block);
        const dt = /^data: (.+)$/m.exec(block);
        if (ev && dt) {
          let payload = null;
          try { payload = JSON.parse(dt[1]); } catch (_) {}
          if (predicate({ event: ev[1], data: payload })) return true;
        }
      }
    }
    return false;
  }
  return { until, cancel: () => reader.cancel().catch(() => {}) };
}

async function main() {
  console.log('\n== CampusDesk 冒烟测试（v6 · SRS 功能域重构 + 双端企业级界面）==\n');
  if (!fs.existsSync(SMOKE_DIR)) fs.mkdirSync(SMOKE_DIR, { recursive: true });
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT, stdio: 'ignore',
    env: { ...process.env, PORT: String(PORT), CAMPUSDESK_DATA_DIR: SMOKE_DIR },
  });

  const anon = makeSession();      // 未登录
  const admin = makeSession();     // 管理员
  const student = makeSession();   // 学生
  const teacher = makeSession();   // 教师
  let sse = null;

  try {
    if (!await waitReady(anon)) throw new Error('服务未能启动');

    /* ---------- 零预置数据 + 首次初始化 ---------- */
    const h = await anon.req('GET', '/api/health');
    check('服务健康检查', h.data.ok && h.data.initialized === false, 'version=' + h.data.version);
    const state = await anon.req('GET', '/api/auth/state');
    check('首次启动未预置任何账号', state.data.initialized === false && state.data.user === null);
    const unauth = await anon.req('GET', '/api/bootstrap');
    check('未登录访问业务接口被拦截', unauth.status === 401 && unauth.data.error === 'UNAUTHORIZED');

    const setupWrongPortal = await anon.req('POST', '/api/auth/setup', {
      username: 'hacker_portal', password: 'Hack2026x', display_name: 'x', portal: 'user',
    });
    check('首次初始化不能从用户端完成',
      setupWrongPortal.status === 403 && setupWrongPortal.data.error === 'PORTAL_MISMATCH');

    const setup = await admin.req('POST', '/api/auth/setup', {
      username: 'smoke_admin', password: 'Admin2026x', display_name: '测试管理员', portal: 'admin',
    });
    check('首次初始化由使用者创建管理员', setup.status === 201 && setup.data.user.role === 'admin');
    const again = await anon.req('POST', '/api/auth/setup', {
      username: 'hacker', password: 'Hack2026x', display_name: 'x',
    });
    check('初始化只能执行一次', again.status === 409 && again.data.error === 'ALREADY_INITIALIZED');
    const me = await admin.req('GET', '/api/auth/me');
    check('会话 Cookie 生效', me.status === 200 && me.data.user.username === 'smoke_admin');
    const badLogin = await anon.req('POST', '/api/auth/login', { username: 'smoke_admin', password: 'wrong-pass-9' });
    check('错误密码被拒绝', badLogin.status === 401 && badLogin.data.error === 'BAD_CREDENTIALS');

    /* ---------- 账号管理 ---------- */
    for (const [username, role, name] of [
      ['smoke_student', 'student', '测试学生'],
      ['smoke_teacher', 'teacher', '测试教师'],
    ]) {
      const r = await admin.req('POST', '/api/admin/users', {
        username, role, display_name: name, password: 'Campus2026x',
      });
      check('创建 ' + role + ' 账号', r.status === 201 && r.data.role === role);
    }
    await student.req('POST', '/api/auth/login', { username: 'smoke_student', password: 'Campus2026x' });
    await teacher.req('POST', '/api/auth/login', { username: 'smoke_teacher', password: 'Campus2026x' });
    check('两个角色分别登录成功', student.cookie.length > 10 && teacher.cookie.length > 10);
    const adminArea = await student.req('GET', '/api/admin/overview');
    check('学生访问管理接口被拒绝', adminArea.status === 403 && adminArea.data.error === 'FORBIDDEN');
    const logsArea = await student.req('GET', '/api/logs?days=7');
    check('学生访问日志接口被拒绝', logsArea.status === 403);

    const boot = await admin.req('GET', '/api/bootstrap');
    check('bootstrap 零预置业务数据', boot.status === 200 && boot.data.empty === true &&
      boot.data.equipment.items.length === 0 && boot.data.notices.length === 0 &&
      boot.data.mistakes.length === 0 && boot.data.feedback.length === 0,
      'empty=' + boot.data.empty);
    const emptyEq = await student.req('GET', '/api/equipment/list');
    check('器材清单初始为空（不再自动播种）', emptyEq.data.items.length === 0);
    const noAdd = await student.req('POST', '/api/equipment/add', { name: '学生私自添加', total: 2 });
    check('学生不能新增器材', noAdd.status === 403);

    /* ---------- 业务接口（数据只写入隔离目录） ---------- */
    const addEq = await teacher.req('POST', '/api/equipment/add', { name: '测试用垫子', total: 3, category: '体育器材' });
    check('教师新增器材', addEq.status === 200 && addEq.data.items.length === 1);
    const eq = (await admin.req('GET', '/api/equipment/list')).data;
    const item = eq.items[0];

    const samples = extractor.SAMPLES; // 测试夹具，仅用于校验解析器，不写入日常数据
    let savedId = null;
    for (const s of samples) {
      const r = await student.req('POST', '/api/notice/parse', { text: s.text });
      check('通知解析 · ' + s.label, r.status === 200 && r.data.title,
        'conf=' + (r.data.confidence || 0) + '%');
      if (!savedId && r.status === 200) {
        const save = await student.req('POST', '/api/notice/save', { notice: r.data });
        savedId = save.data.id;
      }
    }
    const stuList = await student.req('GET', '/api/notice/list');
    const teaList = await teacher.req('GET', '/api/notice/list');
    check('学生只见自己录入的通知', stuList.data.items.length === 1 && teaList.data.items.length === 1);
    check('通知保存与待办勾选', savedId &&
      (await student.req('POST', '/api/notice/toggle', { id: savedId })).status === 200);
    const ics = await student.req('GET', '/api/notice/ics?id=' + savedId);
    check('日历 .ics 导出', ics.status === 200 && String(ics.data).includes('BEGIN:VCALENDAR'));
    const emptyNotice = await student.req('POST', '/api/notice/parse', { text: '' });
    check('错误路径 · 空通知被拦截', emptyNotice.status === 400 && emptyNotice.data.error === 'EMPTY_NOTICE');
    const noDelete = await student.req('DELETE', '/api/notice/delete', { id: savedId });
    check('学生不能删除通知', noDelete.status === 403);

    const loan = await student.req('POST', '/api/loan/create', {
      item_id: item.id, borrower: '测试同学', qty: 2, due_date: '2026-11-01', purpose: '冒烟测试',
    });
    check('学生登记借出（构造逾期）', loan.status === 200 && loan.data.overdue_count >= 1);
    const loanRow = loan.data.loans.find((l) => l.borrower === '测试同学');
    const partial = await student.req('POST', '/api/loan/return', { id: loanRow.id, returned_qty: 1 });
    check('部分归还核对', partial.data.loans.find((l) => l.id === loanRow.id).left === 1);
    const full = await student.req('POST', '/api/loan/return', { id: loanRow.id, returned_qty: 1 });
    check('全部归还核对', full.data.loans.find((l) => l.id === loanRow.id).status === 'returned');
    const over = await student.req('POST', '/api/loan/create', {
      item_id: item.id, borrower: '超额', qty: 9999, due_date: '2026-12-01',
    });
    check('错误路径 · 库存不足被拦截', over.status === 400 && over.data.error === 'OUT_OF_STOCK');

    const ms = await student.req('POST', '/api/mistake/add', {
      title: '测试题：函数定义域', subject: '数学', knowledge: '函数',
      wrong_reason: '漏看定义域', correct_answer: '先求定义域',
    });
    check('错题录入', ms.status === 200 && ms.data.next_review);
    const r1 = await student.req('POST', '/api/mistake/review', { id: ms.data.id, result: 'ok' });
    check('复习进阶', r1.data.stage === 1);
    const r2 = await student.req('POST', '/api/mistake/review', { id: ms.data.id, result: 'again' });
    check('复习重置', r2.data.stage === 0 && r2.data.review_count === 2);
    check('错题列表', (await student.req('GET', '/api/mistake/list')).data.items.length === 1);

    const fb = await student.req('POST', '/api/feedback/add', { role: '自动化测试', module: '整体', score: 4 });
    check('反馈提交', fb.status === 200);
    const fbList = await student.req('GET', '/api/feedback/list');
    check('学生不能查看他人反馈汇总', fbList.status === 403);
    check('未知路由返回 404', (await admin.req('GET', '/api/not-exist')).status === 404);

    /* ---------- v6 · SRS 对齐的真实能力 ---------- */
    const extra = await student.req('POST', '/api/notice/parse', {
      text: '教务处发布：关于期末考试安排的通知。请全体同学务必于12月20日前携带学生证、准考证到办公楼301参加，联系人：王老师，逾期不再受理。发布单位：教务处',
    });
    check('提取引擎补齐 SRS 字段（发布单位 / 材料 / 重要程度）',
      extra.data.issuer === '教务处' && extra.data.materials.length >= 1 && extra.data.importance === '紧急',
      'issuer=' + extra.data.issuer + ', materials=' + extra.data.materials.join('/') + ', importance=' + extra.data.importance);
    check('提取结果标记「需人工审核」且引擎为本地规则',
      extra.data.reviewed === false && extra.data.extract_engine === 'local-rules');

    const dash = await student.req('GET', '/api/dashboard');
    check('CM-FR-001 仪表盘指标齐备且含真实系统读数',
      !!dash.data.notice && !!dash.data.loan && !!dash.data.equipment &&
      !!dash.data.system && typeof dash.data.system.uptime_s === 'number' &&
      typeof dash.data.system.rss_mb === 'number' && typeof dash.data.telemetry.today_calls === 'number',
      'uptime=' + dash.data.system.uptime_s + 's, rss=' + dash.data.system.rss_mb + 'MB');

    const act = await student.req('GET', '/api/activity?days=7');
    check('最近操作足迹只返回当前会话的脱敏摘要',
      act.status === 200 && act.data.scope === 'own_session' && act.data.items.length > 0 &&
      act.data.items.every((r) => !('text' in r) && !('title' in r) && !('name' in r)),
      act.data.items.length + ' 条');
    check('未登录不能读取操作足迹', (await anon.req('GET', '/api/activity')).status === 401);

    const eqArchive = await teacher.req('POST', '/api/equipment/add', {
      name: '档案测试仪器', total: 2, code: 'EQ-CHK-001', model: 'TEST-2000',
      location: '实验楼B203', purchased_at: '2026-01-15', unit: '台', note: '需定期校准',
    });
    const archived = eqArchive.data.items.find((i) => i.code === 'EQ-CHK-001');
    check('CM-FR-201 器材档案完整字段真实落库',
      !!archived && archived.model === 'TEST-2000' && archived.location === '实验楼B203' &&
      archived.purchased_at === '2026-01-15' && archived.note === '需定期校准');

    const ov = await admin.req('GET', '/api/admin/overview');
    check('CM-FR-509 健康检查项与资源为真实读数',
      Array.isArray(ov.data.checks) && ov.data.checks.length === 6 &&
      typeof ov.data.resources.rss_mb === 'number' && ov.data.checks.every((c) => typeof c.ok === 'boolean'),
      ov.data.checks.filter((c) => c.ok).length + '/' + ov.data.checks.length + ' 项通过');
    check('版本时间线来自真实 git log', Array.isArray(ov.data.git_commits), (ov.data.git_commits || []).length + ' 条提交');
    check('日报文件清单可读', Array.isArray(ov.data.report_files));

    const expJson = await admin.req('GET', '/api/admin/export?format=json');
    check('CM-FR-507 导出 JSON 日志',
      expJson.status === 200 && expJson.data && Array.isArray(expJson.data.rows) && expJson.data.rows.length > 0,
      expJson.data ? expJson.data.row_count + ' 行' : '');
    const expCsv = await admin.req('GET', '/api/admin/export?format=csv');
    check('CM-FR-507 导出 CSV 日志',
      expCsv.status === 200 && String(expCsv.data).indexOf('ts,day,app_version') >= 0 &&
      String(expCsv.data).split('\r\n').length > 2);
    check('导出响应带下载文件名', /attachment; filename=/.test(expCsv.headers.get('content-disposition') || ''));
    check('学生不能导出运行日志', (await student.req('GET', '/api/admin/export?format=json')).status === 403);
    const sumRoles = await admin.req('GET', '/api/admin/summary?days=7');
    check('日志按角色聚合可用', Object.keys(sumRoles.data.by_role || {}).length >= 1, JSON.stringify(sumRoles.data.by_role));

    /* ---------- 三套独立入口、页面级越权与旧链接兼容 ---------- */
    const manual = { redirect: 'manual' };
    const coverPage = await anon.req('GET', '/', undefined, manual);
    check('动态封面总入口可匿名访问',
      coverPage.status === 200 && String(coverPage.data).includes('把校园里的琐事'));
    const userLoginPage = await anon.req('GET', '/user/', undefined, manual);
    check('用户端独立登录页可访问',
      userLoginPage.status === 200 && String(userLoginPage.data).includes('案头有常课'));
    const adminLoginPage = await anon.req('GET', '/admin/', undefined, manual);
    check('管理端独立登录页可访问',
      adminLoginPage.status === 200 && String(adminLoginPage.data).includes('运行皆有迹'));
    check('两端登录页互不出现对方入口',
      !String(userLoginPage.data).includes('/admin/') && !String(adminLoginPage.data).includes('/user/'));
    const portalCss = await anon.req('GET', '/portal.css', undefined, manual);
    check('书院风封面样式资源可访问',
      portalCss.status === 200 && String(portalCss.data).includes('@keyframes leafFall'));
    const portalJs = await anon.req('GET', '/portal.js', undefined, manual);
    check('入口脚本资源可访问', portalJs.status === 200);

    const uPage = await student.req('GET', '/user/index.html', undefined, manual);
    check('用户端 v6 八大视图与企业级组件齐备',
      ['view-dashboard', 'view-notice', 'view-equipment', 'view-mistake', 'view-assistant', 'view-activity', 'view-feedback', 'view-about']
        .every((id) => String(uPage.data).includes('id="' + id + '"')) &&
      String(uPage.data).includes('id="sys-strip"') && String(uPage.data).includes('CM-FR-001'));
    const aPage = await admin.req('GET', '/admin/index.html', undefined, manual);
    check('管理端 v6 七大视图与监控组件齐备',
      ['view-live', 'view-health', 'view-analytics', 'view-users', 'view-data', 'view-backup', 'view-about']
        .every((id) => String(aPage.data).includes('id="' + id + '"')) &&
      String(aPage.data).includes('id="health-checks"') && String(aPage.data).includes('id="perm-matrix"'));

    const uIdxAnon = await anon.req('GET', '/user/index.html', undefined, manual);
    check('未登录访问用户工作台→本端登录页',
      uIdxAnon.status === 302 && uIdxAnon.location === '/user/login.html');
    const aIdxAnon = await anon.req('GET', '/admin/index.html', undefined, manual);
    check('未登录访问管理后台→本端登录页',
      aIdxAnon.status === 302 && aIdxAnon.location === '/admin/login.html');
    const upper = await anon.req('GET', '/ADMIN/INDEX.HTML', undefined, manual);
    check('大小写变体不能绕过页面鉴权',
      upper.status === 302 && upper.location === '/admin/login.html');
    const aIdxStu = await student.req('GET', '/admin/index.html', undefined, manual);
    check('学生不能进入管理端页面',
      aIdxStu.status === 302 && aIdxStu.location === '/admin/login.html');
    const uIdxAdmin = await admin.req('GET', '/user/index.html', undefined, manual);
    check('管理员不能进入用户端页面',
      uIdxAdmin.status === 302 && uIdxAdmin.location === '/user/login.html');
    const uLoginByStu = await student.req('GET', '/user/', undefined, manual);
    check('已登录用户端跳过登录页直达工作台',
      uLoginByStu.status === 302 && uLoginByStu.location === '/user/index.html');
    const aLoginByAdmin = await admin.req('GET', '/admin/', undefined, manual);
    check('已登录管理端跳过登录页直达后台',
      aLoginByAdmin.status === 302 && aLoginByAdmin.location === '/admin/index.html');

    for (const [oldPath, target] of [
      ['/login.html', '/'], ['/index.html', '/user/'], ['/admin.html', '/admin/'],
      ['/app.js', '/user/app.js'], ['/admin.js', '/admin/admin.js'],
    ]) {
      const r = await anon.req('GET', oldPath, undefined, manual);
      check('旧链接兼容 ' + oldPath, r.status === 302 && r.location === target);
    }

    /* ---------- 管理员后台：实时日志 ---------- */
    const ctrl = new AbortController();
    const sseRes = await fetch(BASE + '/api/admin/stream', {
      headers: { Cookie: admin.cookie }, signal: ctrl.signal,
    });
    check('SSE 实时流连接', sseRes.status === 200 &&
      (sseRes.headers.get('content-type') || '').includes('text/event-stream'));
    sse = streamReader(sseRes);
    const gotSnapshot = await sse.until((e) => e.event === 'snapshot' && e.data && Array.isArray(e.data.recent), 6000);
    check('SSE 首帧下发快照', gotSnapshot);
    // 连接保持期间再发一次请求，应收到服务端主动推送的 log 事件
    await anon.req('GET', '/api/health');
    const gotPush = await sse.until((e) => e.event === 'log' && e.data && e.data.module === 'health', 6000);
    check('新日志实时推送到后台', gotPush);

    const poll = await admin.req('GET', '/api/admin/poll?cursor=0');
    check('轮询兜底按游标返回', poll.status === 200 && poll.data.rows.length > 0 && poll.data.cursor > 0,
      'cursor=' + poll.data.cursor);
    const summary = await admin.req('GET', '/api/admin/summary?days=7');
    check('日志汇总可用', summary.data.total_calls > 15, '累计 ' + summary.data.total_calls + ' 次调用');
    check('日志含报错记录', (summary.data.by_status.error || 0) >= 3,
      '报错 ' + (summary.data.by_status.error || 0) + ' 次');
    check('错误码聚合可用', Object.keys(summary.data.by_error_code || {}).length >= 3,
      Object.keys(summary.data.by_error_code || {}).join(','));
    const day = await admin.req('GET', '/api/admin/day?date=' + telemetry.localDay());
    check('按天读取日志', day.data.rows.length > 0);
    check('日志含角色字段', day.data.rows.some((r) => r.role === 'student' || r.role === 'admin'));
    const v4rows = day.data.rows.filter((r) => r.app_version === 'v6.0.0');
    check('单请求库存快照计算 ≤1 次', v4rows.length > 0 &&
      v4rows.every((r) => (r.meta.reconcile_calls || 0) <= 1));
    const overview = await admin.req('GET', '/api/admin/overview');
    // v6 新增的「器材档案完整字段」用例会多写入 1 条器材，故此处期望 2
    check('数据总览含数据集条数', overview.data.datasets.notices === 1 &&
      overview.data.datasets.equipment === 2 && overview.data.users_total === 3);
    const users = await admin.req('GET', '/api/admin/users');
    check('账号列表不泄露密码哈希', users.data.items.length === 3 &&
      users.data.items.every((u) => !('password_hash' in u) && !('salt' in u)));
    const report = await admin.req('POST', '/api/admin/report', {});
    check('当日日报生成', report.data.ok);

    /* ---------- 退出登录 ---------- */
    const out = await student.req('POST', '/api/auth/logout', {});
    check('退出登录清除会话', out.status === 200 && student.cookie === '');
    check('退出后接口不可访问', (await student.req('GET', '/api/dashboard')).status === 401);

    /* ---------- 入口角色约束：服务端二次校验 ---------- */
    const probe = makeSession();
    const adminAtUser = await probe.req('POST', '/api/auth/login', {
      username: 'smoke_admin', password: 'Admin2026x', portal: 'user',
    });
    check('管理员账号不能从用户端登录',
      adminAtUser.status === 403 && adminAtUser.data.error === 'PORTAL_MISMATCH');
    const studentAtAdmin = await probe.req('POST', '/api/auth/login', {
      username: 'smoke_student', password: 'Campus2026x', portal: 'admin',
    });
    check('学生账号不能从管理端登录',
      studentAtAdmin.status === 403 && studentAtAdmin.data.error === 'PORTAL_MISMATCH');
    const studentAtUser = await probe.req('POST', '/api/auth/login', {
      username: 'smoke_student', password: 'Campus2026x', portal: 'user',
    });
    check('用户端入口可正常登录', studentAtUser.status === 200);
    const adminAtAdmin = await probe.req('POST', '/api/auth/login', {
      username: 'smoke_admin', password: 'Admin2026x', portal: 'admin',
    });
    check('管理端入口可正常登录', adminAtAdmin.status === 200);

    sse.cancel(); ctrl.abort();
    const pass = results.filter((r) => r.ok).length;
    console.log('\n结果：' + pass + '/' + results.length + ' 项通过');
    console.log('测试业务数据已在隔离目录清理；运行日志为真实请求自动采集，未做任何填充\n');
    if (pass !== results.length) process.exitCode = 1;
  } finally {
    if (sse) sse.cancel();
    child.kill();
    // 只清理本脚本创建的隔离数据目录，绝不触碰日常 data/*.json
    if (SMOKE_DIR.endsWith('__smoke__') && fs.existsSync(SMOKE_DIR)) {
      fs.rmSync(SMOKE_DIR, { recursive: true, force: true });
    }
  }
}

main().catch((err) => { console.error('[smoke-test] 失败：', err); process.exitCode = 1; });
