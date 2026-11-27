'use strict';
/**
 * 校园事务台 · CampusDesk
 * 零依赖本地服务：node server.js  →  http://localhost:5173（占用时自动顺延）
 * 局域网访问：node server.js --lan （PowerShell / CMD / Git Bash 通用）
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
const os = require('os');
const telemetry = require('./lib/telemetry');
const auth = require('./lib/auth');
const api = require('./lib/api');

/* ------------------------------------------------------------------
 * 启动参数：命令行优先于环境变量，且在所有终端里写法一致。
 *   node server.js             仅本机（127.0.0.1:5173）
 *   node server.js --lan       局域网模式（0.0.0.0，推荐）
 *   node server.js --lan --port 8080
 *   node server.js --host 0.0.0.0 --port 8080
 *   node server.js --help
 * PowerShell 里不能写 `LAN=1 node server.js`（那是 Bash 语法，会报
 * 「无法将 LAN=1 项识别为 cmdlet」）；用上面的 --lan 即可，或写
 * `$env:LAN='1'; node server.js`。环境变量方式仍保留兼容。
 * ------------------------------------------------------------------ */
const ARGV = process.argv.slice(2);
function argValue(flag) {
  const eq = ARGV.find((a) => a.startsWith(flag + '='));
  if (eq) return eq.slice(flag.length + 1);
  const i = ARGV.indexOf(flag);
  return i >= 0 && ARGV[i + 1] && !ARGV[i + 1].startsWith('-') ? ARGV[i + 1] : null;
}
if (require.main === module && (ARGV.includes('--help') || ARGV.includes('-h'))) {
  console.log([
    'CampusDesk 启动参数',
    '',
    '  node server.js                        仅本机访问（默认 127.0.0.1:5173）',
    '  node server.js --lan                   局域网模式（推荐，任意终端通用）',
    '  node server.js --lan --port 8080       局域网 + 指定端口',
    '  node server.js --host 0.0.0.0          等价 --lan',
    '  node server.js --port 8080             仅本机 + 指定端口',
    '  node server.js --help                  显示本说明',
    '',
    '  环境变量（兼容旧写法）：LAN=1 / HOST=0.0.0.0 / PORT=8080',
    '    Git Bash / WSL / macOS / Linux : LAN=1 node server.js',
    '    PowerShell                    : $env:LAN=\'1\'; node server.js',
    '',
    '  局域网模式下需放行 Windows 防火墙 TCP 端口，且仅建议在可信本地子网使用。',
  ].join('\n'));
  process.exit(0);
}
const cliPort = Number(argValue('--port'));
const cliHost = argValue('--host');
const envHost = process.env.HOST;
/**
 * 默认只监听 127.0.0.1（仅本机可访问）。
 * --lan / LAN=1 / HOST=0.0.0.0 时开放局域网：监听所有网卡、启动日志打印可用 IP。
 * 局域网模式额外限制「首次创建管理员」只能在本机完成，避免被同网段抢注。
 */
const LAN_MODE = ARGV.includes('--lan') || process.env.LAN === '1' ||
  cliHost === '0.0.0.0' || envHost === '0.0.0.0';
let PORT = Number.isFinite(cliPort) && cliPort > 0 && cliPort < 65536
  ? cliPort : Number(process.env.PORT || 5173);
const HOST = cliHost || envHost || (LAN_MODE ? '0.0.0.0' : '127.0.0.1');
const MAX_PORT_RETRY = 8;
let portRetry = 0;
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 1024 * 1024; // 1 MB

/** 畸形百分号编码不应打挂进程：解码失败时保留原串，由后续路由返回 404 */
function safeDecode(s) {
  try { return decodeURIComponent(s); } catch (_) { return String(s); }
}
function isLoopback(req) {
  const ip = String(req.socket.remoteAddress || '');
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}
function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  return out;
}

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
    'Referrer-Policy': 'same-origin',
    // 页面无外部资源、无内联脚本；style 允许 inline 属性（组件里有行内宽度）。
    // 不设 X-Frame-Options / frame-ancestors：本地预览面板以内嵌方式展示页面，
    // 而点击劫持对本机工具不构成实际威胁，跨站写请求由下面的同源校验兜底。
    'Content-Security-Policy': "default-src 'self' blob:; script-src 'self'; " +
      "style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; " +
      "object-src 'none'; base-uri 'self'; form-action 'self'",
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

/**
 * CSRF 同源校验：跨站页面无法伪造本地服务的写请求。
 * 无 Origin / Referer 时放行（本机 curl 与冒烟测试不发送该头，
 * 且 Cookie 已设 SameSite=Lax，浏览器跨站 POST 不会携带本会话）。
 */
function sameOrigin(req) {
  const raw = req.headers.origin || req.headers.referer || '';
  if (!raw) return true;
  try {
    return new URL(raw).host.toLowerCase() === String(req.headers.host || '').toLowerCase();
  } catch (_) { return false; }
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
  const ip = req.socket.remoteAddress || 'local';
  let url;
  let pathname = '/';
  let user = null;
  let token = '';
  let session = 'anonymous';
  let meta = {};
  let statusCode = 200;
  let errorCode = null;

  // URL / Cookie 解码放在 try 内：畸形编码只返回 400，不能让未捕获异常终止进程
  try {
    url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    pathname = safeDecode(url.pathname);
    const cookies = auth.parseCookies(req.headers.cookie);
    token = cookies[auth.COOKIE_NAME] || '';
    user = auth.resolve(token);
    session = anonSession(req, user);
  } catch (_) {
    return send(res, 400, { error: 'BAD_REQUEST', message: '请求格式不正确' });
  }

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

    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !sameOrigin(req)) {
      errorCode = 'CSRF_ORIGIN_MISMATCH';
      statusCode = 403;
      res.on('finish', finish);
      return send(res, 403, { error: errorCode, message: '请求来源与本站不一致，已拒绝' });
    }

    // 局域网开放后，只有本机可以创建第一位管理员，避免同网段设备抢注
    if (LAN_MODE && pathname === '/api/auth/setup' && !isLoopback(req)) {
      errorCode = 'SETUP_LOCAL_ONLY';
      statusCode = 403;
      res.on('finish', finish);
      return send(res, 403, { error: errorCode, message: '首次创建管理员只能在本机完成' });
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
    // 5xx 不外泄内部路径、子进程 stderr 或文件系统错误；4xx 业务提示照常返回
    const message = statusCode >= 500 ? '服务内部错误，详情见服务端日志' : err.message;
    return send(res, statusCode, { error: errorCode, message });
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
  console.log('  校园事务台 CampusDesk 已启动' + (LAN_MODE ? '（局域网模式）' : '（仅本机）'));
  console.log('  监听地址 → ' + HOST + ':' + PORT + (LAN_MODE ? '（所有网卡）' : '（仅 127.0.0.1）'));
  console.log('  封面总入口 → http://localhost:' + PORT + '/');
  console.log('  用户端 /user/  （独立登录 + 学生/教师工作台）');
  console.log('  管理端 /admin/ （独立登录 + 实时日志后台）');
  if (LAN_MODE) {
    console.log('  局域网地址（同一 Wi-Fi 下的手机 / 同学电脑打开）：');
    for (const a of lanAddresses()) {
      console.log('    http://' + a.address + ':' + PORT + '/   [' + a.name + ']');
    }
    console.log('  安全：明文 HTTP，勿在公共网络开放；首次创建管理员仅限本机。');
  }
  console.log('  日志目录 → ' + telemetry.LOG_DIR);
  console.log('  按 Ctrl+C 停止（每日同步请运行 node scripts/daily-report.js --sync）');
  console.log('');
});

// 兜底：任何遗漏的异步异常只记录、不终止服务（局域网开放后尤为重要）
process.on('unhandledRejection', (err) => {
  console.error('[unhandled-rejection]', err && err.message ? err.message : String(err));
});

server.listen(PORT, HOST);

module.exports = server;
