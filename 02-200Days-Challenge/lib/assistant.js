'use strict';
/**
 * 校园事务台 · 辅助助手（本地离线 / CM-FR-402~404、406、407）
 *
 * 设计约束（与项目整体一致）：
 *   - 零依赖、不联网、不调用任何外部模型，也不需要 API Key；
 *   - 只读：不写任何业务数据、不生成示例内容；
 *   - 只回答「使用者自己录入」的数据，学生按 owner_id 隔离，看不到他人内容；
 *   - 每条回答附资料来源；资料不足或问题超出能力时明确拒答，绝不编造（CM-FR-407）。
 *
 * 它是确定性的本地检索 + 规则匹配，不是大语言模型：模型不可用时基础业务照常运行，
 * 也符合 SRS 1.3「人工确认 / AI 服务不可用不影响基础业务」与 4.3「数据不上传」。
 */
const store = require('./store');
const telemetry = require('./telemetry');

const EXAMPLES = [
  '最近的截止是什么',
  '我还有哪些待办没完成',
  '示波器还有几台',
  '有没有逾期的借用',
  '今天要复习哪些错题',
];

// 顺序即优先级：命中数相同时靠前的意图胜出
const INTENTS = [
  { id: 'help', kw: ['你能', '能做什么', '会什么', '帮助', '怎么用', '功能', '可以问', '能问'] },
  { id: 'overdue', kw: ['逾期', '过期', '超时', '没还', '未归还'] },
  { id: 'todo', kw: ['待办', '要做', '任务', '没完成', '未完成', '事项', 'todo'] },
  { id: 'deadline', kw: ['截止', '到期', 'deadline', '什么时候', '哪天', '时间', '日期'] },
  { id: 'mistake', kw: ['错题', '复习', '知识点', '掌握'] },
  { id: 'equipment', kw: ['器材', '库存', '设备', '剩余', '可用', '几台', '几件', '借出'] },
  { id: 'notice', kw: ['通知', '公告', '有哪些', '列出', '所有', '最近'] },
];

function classify(q) {
  const lower = String(q).toLowerCase();
  let bestId = 'unknown';
  let bestScore = 0;
  for (const it of INTENTS) {
    let score = 0;
    for (const k of it.kw) if (lower.includes(k)) score += 1;
    if (score > bestScore) { bestScore = score; bestId = it.id; }
  }
  return bestId;
}

/** 学生只能看到自己录入的记录；教师 / 管理员看全部（与 lib/api.js 的 scoped 一致） */
function scoped(name, user) {
  const arr = store.get(name);
  if (user && user.role === 'student') return arr.filter((x) => x.owner_id === user.id);
  return arr;
}
function source(type, id, title, field, value) {
  return {
    type,
    id: String(id || '').slice(0, 40),
    title: String(title || '').slice(0, 60),
    field: String(field || '').slice(0, 24),
    value: String(value === null || value === undefined ? '' : value).slice(0, 80),
  };
}
function noData(what, where) {
  return {
    answered: false,
    text: '本地还没有' + what + '。这个助手只回答你自己录入的数据，不会编造内容；'
      + '请先在「' + where + '」录入后再来问。',
    sources: [],
  };
}
function dateOf(s) { return s ? String(s).slice(0, 10) : ''; }
function today() { return telemetry.localDay(); }

function helpReply() {
  return {
    answered: true,
    text: '我是本地离线助手：不联网、不调用外部模型，只根据你自己录入的通知、待办、'
      + '器材借用和错题作答；每条回答都会标出资料来源，查不到会直接说明。可以问我：\n'
      + EXAMPLES.map((x, i) => (i + 1) + '. ' + x).join('\n'),
    sources: [],
  };
}
function unknownReply() {
  return {
    answered: false,
    text: '这个问题我暂时无法从本地数据作答，也不会猜测或编造。目前能回答这几类：\n'
      + EXAMPLES.map((x) => '· ' + x).join('\n') + '\n也可以先问「你能做什么」。',
    sources: [],
  };
}

function noticeReply(user) {
  const list = scoped('notices', user);
  if (!list.length) return noData('通知记录', '通知与任务');
  const rows = list.slice()
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 5);
  return {
    answered: true,
    text: '本地共 ' + list.length + ' 条通知，最近 ' + rows.length + ' 条：\n'
      + rows.map((n) => '· ' + n.title + '（' + (n.category || '未分类') + '，活动 '
        + (dateOf(n.event_date) || '未填写') + '）').join('\n'),
    sources: rows.map((n) => source('notice', n.id, n.title, 'title', n.title)),
  };
}
function deadlineReply(user) {
  const list = scoped('notices', user)
    .filter((n) => !n.done && (dateOf(n.deadline) || dateOf(n.event_date)));
  if (!list.length) return noData('带截止 / 活动日期的未完成通知', '通知与任务');
  const rows = list.slice().sort((a, b) =>
    String(dateOf(a.deadline) || a.event_date).localeCompare(String(dateOf(b.deadline) || b.event_date)))
    .slice(0, 5);
  return {
    answered: true,
    text: '按日期排序，最近 ' + rows.length + ' 项（共 ' + list.length + ' 项）：\n'
      + rows.map((n) => '· ' + n.title + '：'
        + (dateOf(n.deadline) ? '截止 ' + dateOf(n.deadline) : '活动 ' + dateOf(n.event_date))
        + (n.location ? '，' + n.location : '')).join('\n'),
    sources: rows.map((n) => source('notice', n.id, n.title,
      dateOf(n.deadline) ? 'deadline' : 'event_date', dateOf(n.deadline) || dateOf(n.event_date))),
  };
}
function todoReply(user) {
  const list = scoped('notices', user).filter((n) => !n.done);
  if (!list.length) return noData('未完成待办', '通知与任务');
  const rows = list.slice()
    .sort((a, b) => String(dateOf(a.deadline) || '9999').localeCompare(String(dateOf(b.deadline) || '9999')))
    .slice(0, 5);
  return {
    answered: true,
    text: '还有 ' + list.length + ' 项未完成待办' + (list.length > rows.length
      ? '，先列出最接近截止的 ' + rows.length + ' 项' : '') + '：\n'
      + rows.map((n) => '· ' + n.title + (dateOf(n.deadline) ? '（截止 ' + dateOf(n.deadline) + '）' : ''))
        .join('\n'),
    sources: rows.map((n) => source('notice', n.id, n.title, 'done', '未完成')),
  };
}
function equipmentReply(q, user) {
  const items = store.get('equipment');
  if (!items.length) return noData('器材档案', '实验器材');
  const loans = store.get('loans');
  const availableOf = (id) => {
    const item = items.find((x) => x.id === id);
    const total = Number(item.total) || 0;
    const out = loans.filter((l) => l.item_id === id && l.status !== 'returned')
      .reduce((s, l) => s + Math.max(0, Number(l.qty) - Number(l.returned_qty || 0)), 0);
    return Math.max(0, total - out);
  };
  const named = items.filter((it) => q.includes(String(it.name || '')));
  const rows = (named.length ? named : items).slice(0, 8);
  const head = named.length
    ? '匹配到 ' + named.length + ' 种器材：\n'
    : '本地共 ' + items.length + ' 种器材，库存如下（未指定名称）：\n';
  return {
    answered: true,
    text: head + rows.map((it) => '· ' + it.name + '：可用 ' + availableOf(it.id)
      + ' / 共 ' + it.total + (it.location ? '（' + it.location + '）' : '')).join('\n'),
    sources: rows.map((it) => source('equipment', it.id, it.name, 'total', it.total)),
  };
}
function overdueReply(user) {
  const all = store.get('loans');
  const list = all.filter((l) => l.status !== 'returned' && dateOf(l.due_date) && dateOf(l.due_date) < today());
  const visible = user && user.role === 'student' ? list.filter((l) => l.owner_id === user.id) : list;
  if (!visible.length) {
    return { answered: true, text: '按本地借用记录核对，当前没有逾期未归还的借用。', sources: [] };
  }
  const rows = visible.slice(0, 5);
  const items = store.get('equipment');
  return {
    answered: true,
    text: '有 ' + visible.length + ' 条逾期未归还记录：\n'
      + rows.map((l) => {
        const it = items.find((x) => x.id === l.item_id);
        return '· ' + (it ? it.name : '（器材已删除）') + '：应还 ' + dateOf(l.due_date)
          + '，未还 ' + Math.max(0, Number(l.qty) - Number(l.returned_qty || 0)) + ' 件';
      }).join('\n'),
    sources: rows.map((l) => source('loan', l.id, '借用记录', 'due_date', dateOf(l.due_date))),
  };
}
function mistakeReply(user) {
  const list = scoped('mistakes', user);
  if (!list.length) return noData('错题记录', '错题归档');
  const due = list.filter((m) => !m.mastered && dateOf(m.next_review) && dateOf(m.next_review) <= today());
  return {
    answered: true,
    text: '本地共 ' + list.length + ' 道错题，其中 ' + due.length + ' 道今天该复习'
      + (due.length ? '：\n' + due.slice(0, 5).map((m) =>
        '· ' + m.title + '（' + (m.subject || '未分类') + ' / ' + (m.knowledge || '未标注') + '）').join('\n')
        : '，暂时没有到期的复习任务。'),
    sources: due.slice(0, 5).map((m) => source('mistake', m.id, m.title, 'next_review', dateOf(m.next_review))),
  };
}

/**
 * @param {string} question 用户问题（不写盘、不进日志）
 * @param {object} user     当前登录用户
 * @returns {{intent:string, engine:string, answered:boolean, text:string, sources:Array}}
 */
function answer(question, user) {
  const q = String(question || '').trim().slice(0, 300);
  if (!q) return { intent: 'empty', engine: 'local-rules', answered: false,
    text: '请输入想问的问题。', sources: [] };
  const intent = classify(q);
  let r;
  switch (intent) {
    case 'help': r = helpReply(); break;
    case 'overdue': r = overdueReply(user); break;
    case 'todo': r = todoReply(user); break;
    case 'deadline': r = deadlineReply(user); break;
    case 'mistake': r = mistakeReply(user); break;
    case 'equipment': r = equipmentReply(q, user); break;
    case 'notice': r = noticeReply(user); break;
    default: r = unknownReply();
  }
  return { intent, engine: 'local-rules', answered: !!r.answered,
    text: String(r.text || '').slice(0, 2000), sources: r.sources || [] };
}

module.exports = { answer, EXAMPLES, INTENTS };
