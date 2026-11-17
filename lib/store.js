'use strict';
/**
 * 轻量 JSON 存储：零依赖、同步原子写入。
 * 适合单用户 / 个人电脑场景，数据落在 data/*.json，方便随 GitHub 一起版本化。
 */
const fs = require('fs');
const path = require('path');

// 冒烟测试可用 CAMPUSDESK_DATA_DIR 指向隔离目录，不污染日常数据
const DATA_DIR = process.env.CAMPUSDESK_DATA_DIR
  ? path.resolve(process.env.CAMPUSDESK_DATA_DIR)
  : path.join(__dirname, '..', 'data');
// 缓存带「文件指纹」：本机可能同时启动多个服务实例（例如 5174 与 5175），
// 任一实例写入后，其它实例必须能读到最新内容，不能用旧缓存覆盖账号文件。
const cache = new Map(); // name -> { value, sig }

function signature(file) {
  try {
    const st = fs.statSync(file);
    return st.mtimeMs + ':' + st.size + ':' + st.ino;
  } catch (_) {
    return 'missing';
  }
}

const DEFAULTS = {
  notices: [],   // 通知提取结果（已结构化的待办）
  equipment: [], // 器材清单
  loans: [],     // 借还流水
  mistakes: [],  // 错题
  feedback: [],  // 使用反馈
  users: [],     // 账号（由使用者自行创建，程序不预置任何账号）
  sessions: [],  // 登录会话（只存 token 哈希）
  audit: [],     // 业务审计（SRS 4.3 / CM-FR-210）：只记动作与对象 id，不含原文
};

/** 系统痕迹类数据集，统计「业务数据是否为空」时应排除 */
const SYSTEM_NAMES = ['users', 'sessions', 'audit'];

function fileFor(name) {
  if (!Object.prototype.hasOwnProperty.call(DEFAULTS, name)) {
    throw new Error('未知数据集: ' + name);
  }
  return path.join(DATA_DIR, name + '.json');
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function get(name) {
  ensureDir();
  const file = fileFor(name);
  const sig = signature(file);
  const hit = cache.get(name);
  if (hit && hit.sig === sig) return hit.value;

  let value;
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      value = Array.isArray(parsed) ? parsed : DEFAULTS[name].slice();
    } catch (err) {
      // 文件损坏时不静默吞掉：留一份 .bad 备份，便于事后排查
      try { fs.copyFileSync(file, file + '.bad'); } catch (_) {}
      value = DEFAULTS[name].slice();
    }
  } else {
    value = DEFAULTS[name].slice();
    flush(name, value);
  }
  cache.set(name, { value, sig: signature(file) });
  return value;
}

/** 原子写：先写临时文件再 rename，避免进程中断留下半截 JSON */
function flush(name, value) {
  ensureDir();
  const file = fileFor(name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function set(name, value) {
  if (!Array.isArray(value)) throw new Error('数据集必须是数组');
  flush(name, value);
  cache.set(name, { value, sig: signature(fileFor(name)) });
  return value;
}

/**
 * 读出 → 变换 → 写回。写入前复核文件指纹，若期间被其它进程改过则重读重试，
 * 避免「旧实例的空数组」覆盖掉新实例刚创建的账号。
 */
function update(name, fn) {
  for (let i = 0; i < 4; i++) {
    const before = signature(fileFor(name));
    const next = fn(get(name));
    if (!Array.isArray(next)) throw new Error('变换结果必须是数组');
    if (signature(fileFor(name)) !== before) continue;
    return set(name, next);
  }
  throw new Error('数据文件被其它进程频繁修改，请稍后重试');
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = { get, set, update, flush, uid, DATA_DIR,
  NAMES: Object.keys(DEFAULTS), SYSTEM_NAMES };
