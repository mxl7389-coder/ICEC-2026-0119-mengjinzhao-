'use strict';
/**
 * 校园事务台 · CampusDesk
 * 零依赖本地服务：node server.js  →  http://localhost:5173
 *
 * 每个 /api 请求结束时由 telemetry 自动写一条脱敏日志（调用频次 / 耗时 / 报错）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const telemetry = require('./lib/telemetry');
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

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const file = path.resolve(PUBLIC_DIR, rel);
  if (!file.startsWith(path.resolve(PUBLIC_DIR) + path.sep)) {
    return send(res, 403, { error: 'forbidden' });
  }
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, { error: 'not_found', path: pathname });
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

function anonSession(req) {
  const raw = req.headers['x-session-id'] || req.socket.remoteAddress || 'local';
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 12);
}

const server = http.createServer(async (req, res) => {
  const started = process.hrtime.bigint();
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const pathname = decodeURIComponent(url.pathname);
  let meta = {};
  let statusCode = 200;
  let errorCode = null;
  const session = anonSession(req);

  const finish = () => {
    const duration = Number(process.hrtime.bigint() - started) / 1e6;
    // 页面加载也计入「使用频次」，但只记路径，不记任何用户内容
    if (pathname.startsWith('/api/') || pathname === '/') {
      const parts = pathname.replace(/^\/api\//, '').split('/').filter(Boolean);
      telemetry.log({
        session,
        module: pathname === '/' ? 'page' : (parts[0] || 'api'),
        action: pathname === '/' ? 'home' : (parts[1] || req.method.toLowerCase()),
        status: errorCode ? 'error' : 'ok',
        duration_ms: duration,
        error_code: errorCode,
        meta,
      });
    }
  };

  try {
    if (!pathname.startsWith('/api/')) {
      res.on('finish', finish);
      return serveStatic(req, res, pathname);
    }

    const body = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE'
      ? await readBody(req) : {};
    const result = await api.handle({
      method: req.method,
      pathname,
      query: url.searchParams,
      body,
      session,
    });
    statusCode = result.status || 200;
    meta = result.meta || {};

    if (result.raw) {
      res.on('finish', finish);
      return send(res, statusCode, result.raw.body, result.raw.headers);
    }
    res.on('finish', finish);
    return send(res, statusCode, result.data);
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
  console.log('  → http://localhost:' + PORT);
  console.log('  日志目录 → ' + telemetry.LOG_DIR);
  console.log('  按 Ctrl+C 停止（每日同步请运行 node scripts/daily-report.js）');
  console.log('');
});

server.listen(PORT, HOST);

module.exports = server;
