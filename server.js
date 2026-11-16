'use strict';
/**
 * 校园事务台 · CampusDesk
 * 零依赖本地服务：node server.js  →  http://localhost:5173（占用时自动顺延）
 *
 * 三套完全独立的入口（用户端与管理端登录后互不跳转、UI 上互不可见）：
 *   /            中国书院 × 校园文化动态封面（总入口，两个独立入口卡片）
 *   /user/       用户端：独立登录页 + 学生 / 教师工作台（只接受 student / teacher）
 *   /admin/      管理端：独立登录页 + 首次初始化 + 实时日志后台（只接受 admin）
 *
 * 每个 /api 请求结束时由 telemetry 自动写一条脱敏日志（调用频次 / 耗时 / 报错 / 角色）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const telemetry = require('./lib/telemetry');
const auth = require('./lib/auth');
const api = require('./lib/api');

let PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_PORT_RETRY = 8;
let portRetry = 0;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1 MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.ics': 'text/calendar; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' || Buffer.isBuffer(body)
    ? body
    : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function redirect(res, location) {
  res.writeHead(302, { 'Location': location, 'Cache-Control': 'no-store' });
  res.end();
}

/* --------------------------- 三套独立页面入口 --------------------------- */
// 旧链接一律 302 到新入口，避免两套 URL 并存造成混乱
const LEGACY_REDIRECT = {
  '/login.html': '/',
  '/index.html': '/user/',
  '/admin.html': '/admin/',
  '/app.js': '/user/app.js',
  '/admin.js': '/admin/admin.js',
  '/login.js': '/portal.js',
};

// 只有白名单里的静态资源可直接读取；HTML 必须经 resolvePage 鉴权，杜绝路径/大小写绕过
const STATIC_FILES = {
  '/style.css': 'style.css',
  '/portal.css': 'portal.css',
  '/portal.js': 'portal.js',
  '/user/app.js': 'user/app.js',
  '/admin/admin.js': 'admin/admin.js',
};

/**
 * 按规范化（小写、去尾斜杠）后的路径解析页面。
 * 返回 { file } / { redirect } / null（交给静态资源白名单）。
 */
function resolvePage(pathname, user) {
  const raw = pathname.toLowerCase();
  const key = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;

  if (LEGACY_REDIRECT[key]) return { redirect: LEGACY_REDIRECT[key] };

  // 封面总入口：始终可见，不按登录状态强制跳转
  if (key === '/' || key === '/cover.html') return { file: 'cover.html' };

  // 用户端：已登录的 student / teacher 直接进工作台；管理员账号不在这里放行
  if (key === '/user' || key === '/user/login.html') {
    if (user && user.role !== 'admin') return { redirect: '/user/index.html' };
    return { file: 'user/login.html' };
  }
  if (key === '/user/index.html') {
    if (!user || user.role === 'admin') return { redirect: '/user/login.html' };
    return { file: 'user/index.html' };
  }

  // 管理端：只有 admin 会话可进后台
  if (key === '/admin' || key === '/admin/login.html') {
    if (user && user.role === 'admin') return { redirect: '/admin/index.html' };
    return { file: 'admin/login.html' };
  }
  if (key === '/admin/index.html') {
    if (!user || user.role !== 'admin') return { redirect: '/admin/login.html' };
    return { file: 'admin/index.html' };
  }
  return null;
}

function serveStatic(res, rel) {
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not_found' });
    send(res, 200, buf, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('body_too_large'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (_) { reject(Object.assign(new Error('invalid_json'), { code: 'INVALID_JSON' })); }
    });
    req.on('error', reject);
  });
}

function anonSession(req, user) {
  const raw = (user ? user.id : '') + '|' + (req.socket.remoteAddress || 'local');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
}

/* --------------------------- SSE 实时日志流 --------------------------- */
function handleLogStream(req, res, user, session) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    'X-Content-Type-Options': 'nosniff',
  });
  const write = (event, data) => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'); }
    catch (_) { /* 客户端已断开 */ }
  };
  res.write('retry: 3000\n\n');

  const day = telemetry.localDay();
  const agg = telemetry.aggregate(telemetry.listDays().slice(-7));
  const todayRows = telemetry.readDay(day);
  write('snapshot', {
    server_time: new Date().toISOString(),
    day,
    cursor: todayRows.length,
    version: telemetry.APP_VERSION,
    aggregate: agg,
    recent: todayRows.slice(-60).reverse(),
  });

  const unsubscribe = telemetry.subscribe((record) => write('log', record));
  const beat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    try { res.write(': ping\n\n'); } catch (_) {}
  }, 15000);
  const cleanup = () => { clearInterval(beat); unsubscribe(); };
  req.on('close', cleanup);
  req.on('error', cleanup);

  // 连接本身也是一次真实调用，计入日志（不写任何用户内容）
  telemetry.log({
    session, role: user.role, module: 'admin', action: 'stream',
    status: 'ok', duration_ms: 0, meta: { sse: 1 },
  });
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);
  const cookies = auth.parseCookies(req.headers.cookie);
  const token = cookies[auth.COOKIE_NAME] || '';
  const user = auth.resolve(token);
  const ip = req.socket.remoteAddress || 'local';
  const session = anonSession(req, user);
  let meta = {};
  let statusCode = 200;
  let errorCode = null;

  const finish = () => {
    const duration = Number(process.hrtime.bigint() - started) / 1e6;
    // 页面加载也计入「使用频次」，但只记路径，不记任何用户内容
    const isPage = !pathname.startsWith('/api/') &&
      (pathname.endsWith('.html') || pathname === '/' || /^\/(user|admin)\/$/.test(pathname));
    if (pathname.startsWith('/api/') || isPage) {
      const parts = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
      telemetry.log({
        session, role: user ? user.role : null,
        module: isPage ? 'page' : (parts[0] || 'api'),
        action: isPage ? (pathname === '/' ? 'home' : path.basename(pathname, '.html')) : (parts[1] || req.method.toLowerCase()),
        status: errorCode ? 'error' : 'ok',
        duration_ms: duration,
        error_code: errorCode,
        meta,
      });
    }
  };

  try {
    /* ---------- 静态页面与访问控制 ---------- */
    if (!pathname.startsWith('/api/')) {
      res.on('finish', finish);
      const route = resolvePage(pathname, user);
      if (route) {
        if (route.redirect) return redirect(res, route.redirect);
        return serveStatic(res, route.file);
      }
      const asset = STATIC_FILES[pathname.toLowerCase()];
      if (asset) return serveStatic(res, asset);
      return send(res, 404, { error: 'not_found', path: pathname });
    }

    /* ---------- SSE：长连接不走普通 finish 日志 ---------- */
    if (pathname === '/api/admin/stream' || pathname === '/api/admin/logs/stream') {
      if (!user) { res.on('finish', finish); return send(res, 401, { error: 'UNAUTHORIZED', message: '请先登录' }); }
      if (user.role !== 'admin') { res.on('finish', finish); return send(res, 403, { error: 'FORBIDDEN', message: '需要管理员权限' }); }
      return handleLogStream(req, res, user, session);
    }

    const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'
      ? await readBody(req) : {};
    const result = await api.handle({
      method: req.method,
      pathname,
      query: url.searchParams,
      body,
      session, user, token, ip,
    });
    statusCode = result.status || 200;
    meta = result.meta || {};
    const headers = result.headers || {};
    res.on('finish', finish);
    if (result.raw) return send(res, statusCode, result.raw.body, { ...result.raw.headers, ...headers });
    return send(res, statusCode, result.data, headers);
  } catch (err) {
    errorCode = err.code || err.name || 'INTERNAL';
    statusCode = err.status || 500;
    if (errorCode === 'BODY_TOO_LARGE' || errorCode === 'INVALID_JSON') statusCode = 400;
    console.error('[api-error]', errorCode, err.message);
    res.on('finish', finish);
    return send(res, statusCode, { error: errorCode, message: err.message });
  }
});

// 端口被占用时自动顺延，避免个人电脑上和别的开发服务撞车
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && portRetry < MAX_PORT_RETRY) {
    portRetry++;
    PORT += 1;
    console.log('  端口被占用，尝试 ' + PORT + ' …');
    setTimeout(() => server.listen(PORT, HOST), 60);
  } else {
    console.error('  无法监听端口，请用 PORT=xxxx node server.js 指定空闲端口');
    process.exit(1);
  }
});

server.on('listening', () => {
  console.log('');
  console.log('  校园事务台 CampusDesk 已启动');
  console.log('  封面总入口 → http://localhost:' + PORT + '/');
  console.log('  用户端 /user/  （独立登录 + 学生/教师工作台）');
  console.log('  管理端 /admin/ （独立登录 + 实时日志后台）');
  console.log('  日志目录 → ' + telemetry.LOG_DIR);
  console.log('  按 Ctrl+C 停止（每日同步请运行 node scripts/daily-report.js --sync）');
  console.log('');
});

server.listen(PORT, HOST);

module.exports = server;
