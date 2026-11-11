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
const cache = new Map();

const DEFAULTS = {
  notices: [],   // 通知提取结果（已结构化的待办）
  equipment: [], // 器材清单
  loans: [],     // 借还流水
  mistakes: [],  // 错题
  feedback: [],  // 使用反馈
  users: [],     // 账号（由使用者自行创建，程序不预置任何账号）
  sessions: [],  // 登录会话（只存 token 哈希）
};

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
  if (cache.has(name)) return cache.get(name);
  ensureDir();
  const file = fileFor(name);
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
  cache.set(name, value);
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
  cache.set(name, value);
  return value;
}

/** 读出 → 变换 → 写回，一次完成，避免并发覆盖 */
function update(name, fn) {
  const next = fn(get(name));
  return set(name, next);
}

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

module.exports = { get, set, update, flush, uid, DATA_DIR, NAMES: Object.keys(DEFAULTS) };
