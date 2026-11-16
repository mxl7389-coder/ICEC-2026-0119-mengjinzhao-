'use strict';
/**
 * 账号与会话：零依赖，scrypt 加盐哈希 + httpOnly Cookie 会话。
 *
 * 重要：程序不预置任何账号、不生成任何演示用户。
 * 首次使用时由使用者自己在页面上创建第一位管理员，之后由管理员创建学生 / 教师账号。
 */
const crypto = require('crypto');
const store = require('./store');

const ROLES = new Set(['student', 'teacher', 'admin']);
const ROLE_LABEL = { student: '学生', teacher: '教师', admin: '管理员' };
const COOKIE_NAME = 'cd_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 8;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}

function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, password_hash: hashPassword(password, salt) };
}

function verifyPassword(password, user) {
  if (!user || !user.salt || !user.password_hash) return false;
  const calc = Buffer.from(hashPassword(password, user.salt), 'hex');
  const real = Buffer.from(user.password_hash, 'hex');
  return calc.length === real.length && crypto.timingSafeEqual(calc, real);
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role,
    role_label: ROLE_LABEL[u.role] || u.role,
    display_name: u.display_name, active: u.active !== false,
    created_at: u.created_at, last_login_at: u.last_login_at || null,
  };
}

function userCount() { return store.get('users').length; }
function findUser(username) {
  return store.get('users').find((u) => u.username === String(username).toLowerCase()) || null;
}
function findUserById(id) { return store.get('users').find((u) => u.id === id) || null; }

function validateUsername(username) {
  const v = String(username || '').trim().toLowerCase();
  if (!/^[a-z0-9_.\u4e00-\u9fa5-]{3,24}$/.test(v)) {
    throw Object.assign(new Error('账号需 3–24 位，可用中文、字母、数字、_ . -'), {
      code: 'INVALID_USERNAME', status: 400,
    });
  }
  return v;
}
function validatePassword(password) {
  const v = String(password || '');
  if (v.length < 8 || v.length > 64) {
    throw Object.assign(new Error('密码长度需 8–64 位'), { code: 'INVALID_PASSWORD', status: 400 });
  }
  if (!/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) {
    throw Object.assign(new Error('密码需同时包含字母和数字'), { code: 'INVALID_PASSWORD', status: 400 });
  }
  return v;
}

/** 创建账号。第一个账号强制为管理员，且只能在账号数为 0 时由 setup 调用。 */
function createUser({ username, password, role, display_name, created_by }) {
  const uname = validateUsername(username);
  const pwd = validatePassword(password);
  if (!ROLES.has(role)) throw Object.assign(new Error('角色不合法'), { code: 'INVALID_ROLE', status: 400 });
  if (findUser(uname)) {
    throw Object.assign(new Error('该账号已存在，请换一个'), { code: 'USER_EXISTS', status: 409 });
  }
  const user = {
    id: store.uid('us'), username: uname,
    ...makePassword(pwd),
    role,
    display_name: String(display_name || uname).trim().slice(0, 20) || uname,
    created_by: created_by || null,
    created_at: new Date().toISOString(),
    last_login_at: null,
    active: true,
  };
  store.update('users', (arr) => [...arr, user]);
  return publicUser(user);
}

/** 首次初始化：仅当账号表为空时允许，且只能从管理端入口完成 */
function setup(body) {
  if (userCount() > 0) {
    throw Object.assign(new Error('系统已完成初始化，请直接登录'), { code: 'ALREADY_INITIALIZED', status: 409 });
  }
  if (body.portal && body.portal !== 'admin') {
    throw Object.assign(new Error('首位管理员只能在管理端入口创建'), {
      code: 'PORTAL_MISMATCH', status: 403,
    });
  }
  const user = createUser({
    username: body.username, password: body.password,
    role: 'admin', display_name: body.display_name,
  });
  const token = createSession(user.id);
  return { user, token };
}

function rateKey(key) { return String(key || 'anon'); }
function rateCheck(key) {
  const k = rateKey(key);
  const rec = attempts.get(k);
  if (!rec || Date.now() > rec.resetAt) { attempts.delete(k); return true; }
  return rec.count < MAX_FAILS;
}
function rateFail(key) {
  const k = rateKey(key);
  const rec = attempts.get(k);
  if (!rec || Date.now() > rec.resetAt) {
    attempts.set(k, { count: 1, resetAt: Date.now() + FAIL_WINDOW_MS });
  } else rec.count++;
}
function rateClear(key) { attempts.delete(rateKey(key)); }

function login(body, key) {
  if (!rateCheck(key)) {
    throw Object.assign(new Error('尝试次数过多，请 10 分钟后再试'), { code: 'TOO_MANY_ATTEMPTS', status: 429 });
  }
  const uname = String(body.username || '').trim().toLowerCase();
  const user = findUser(uname);
  // 账号不存在时也做一次等价哈希计算，避免通过响应时间枚举账号
  const dummySalt = '00000000000000000000000000000000';
  const ok = verifyPassword(body.password || '', user || { salt: dummySalt, password_hash: hashPassword('dummy-pass-0', dummySalt) });
  if (!user || !ok || user.active === false) {
    rateFail(key);
    throw Object.assign(new Error('账号或密码不正确'), { code: 'BAD_CREDENTIALS', status: 401 });
  }
  // 入口隔离：校验放在密码通过之后，避免未认证请求借此枚举账号角色
  // portal 可选（不传则不限制，供脚本与向后兼容使用）
  if (body.portal === 'user' && user.role === 'admin') {
    throw Object.assign(new Error('这是管理员账号，请从管理端入口登录'), {
      code: 'PORTAL_MISMATCH', status: 403,
    });
  }
  if (body.portal === 'admin' && user.role !== 'admin') {
    throw Object.assign(new Error('这是学生 / 教师账号，请从用户端入口登录'), {
      code: 'PORTAL_MISMATCH', status: 403,
    });
  }
  rateClear(key);
  store.update('users', (arr) => arr.map((u) =>
    u.id === user.id ? { ...u, last_login_at: new Date().toISOString() } : u));
  const token = createSession(user.id);
  return { user: publicUser({ ...user, last_login_at: new Date().toISOString() }), token };
}

/* -------------------------------- 会话 -------------------------------- */
function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const token_hash = sha256(token);
  const now = Date.now();
  const session = {
    id: store.uid('ss'), token_hash, user_id: userId,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
  };
  // 顺手清理过期会话，避免文件无限增长
  store.update('sessions', (arr) => [
    ...arr.filter((s) => Date.parse(s.expires_at) > now), session,
  ]);
  return token;
}

function resolve(token) {
  if (!token) return null;
  const token_hash = sha256(token);
  const s = store.get('sessions').find((x) => x.token_hash === token_hash);
  if (!s || Date.parse(s.expires_at) <= Date.now()) return null;
  const u = findUserById(s.user_id);
  if (!u || u.active === false) return null;
  return publicUser(u);
}

function destroy(token) {
  if (!token) return;
  const token_hash = sha256(token);
  store.update('sessions', (arr) => arr.filter((s) => s.token_hash !== token_hash));
}

function sessionCookie(token, maxAgeSeconds) {
  const parts = [
    COOKIE_NAME + '=' + token, 'Path=/', 'HttpOnly', 'SameSite=Lax',
    'Max-Age=' + (maxAgeSeconds === undefined ? Math.floor(SESSION_TTL_MS / 1000) : maxAgeSeconds),
  ];
  return parts.join('; ');
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

/* ------------------------------ 管理员操作 ------------------------------ */
function listUsers() {
  return store.get('users').map((u) => ({ ...publicUser(u), created_by: u.created_by || null }));
}
function setActive(id, active, actorId) {
  if (id === actorId && !active) {
    throw Object.assign(new Error('不能停用当前登录的账号'), { code: 'CANNOT_DISABLE_SELF', status: 400 });
  }
  let found = false;
  store.update('users', (arr) => arr.map((u) => {
    if (u.id !== id) return u;
    found = true;
    return { ...u, active: !!active };
  }));
  if (!found) throw Object.assign(new Error('账号不存在'), { code: 'NOT_FOUND', status: 404 });
  if (!active) {
    store.update('sessions', (arr) => arr.filter((s) => s.user_id !== id));
  }
  return publicUser(findUserById(id));
}
function resetPassword(id, newPassword) {
  const pwd = validatePassword(newPassword);
  const user = findUserById(id);
  if (!user) throw Object.assign(new Error('账号不存在'), { code: 'NOT_FOUND', status: 404 });
  store.update('users', (arr) => arr.map((u) =>
    u.id === id ? { ...u, ...makePassword(pwd) } : u));
  store.update('sessions', (arr) => arr.filter((s) => s.user_id !== id));
  return { ok: true };
}
function changeOwnPassword(user, oldPassword, newPassword) {
  const real = findUserById(user.id);
  if (!real || !verifyPassword(oldPassword, real)) {
    throw Object.assign(new Error('原密码不正确'), { code: 'BAD_CREDENTIALS', status: 401 });
  }
  const pwd = validatePassword(newPassword);
  store.update('users', (arr) => arr.map((u) =>
    u.id === user.id ? { ...u, ...makePassword(pwd) } : u));
  return { ok: true };
}

module.exports = {
  ROLES, ROLE_LABEL, COOKIE_NAME, SESSION_TTL_MS,
  userCount, findUser, findUserById, publicUser, createUser,
  setup, login, createSession, resolve, destroy,
  sessionCookie, parseCookies,
  listUsers, setActive, resetPassword, changeOwnPassword,
};
