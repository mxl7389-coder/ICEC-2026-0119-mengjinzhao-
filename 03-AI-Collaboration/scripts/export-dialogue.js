#!/usr/bin/env node
/**
 * 真实 AI 对话逐字导出（零依赖）
 *
 * 作用：从 WorkBuddy 本机会话记录 .jsonl 中，提取「本人在 <user_query> 里真正输入的提问」
 *       与「AI 可见的文字回答」，生成可核对的 Markdown 对话导出与统计 JSON。
 *
 * 用法：
 *   node 03-AI-Collaboration/scripts/export-dialogue.js <会话记录.jsonl> [输出目录]
 *   输出目录默认为本脚本上一级目录（03-AI-Collaboration/）。
 *
 * 生成物：
 *   chat-export.md     逐字对话导出（按真实时间顺序）
 *   对话统计.json      轮次、条数、源文件 SHA256、过滤规则与事件统计
 *
 * 红线：
 *   - 不编造、不润色、不补写任何提问或回答；原文逐字保留。
 *   - 宿主注入的上下文、压缩摘要、后台任务通知、工具调用与系统提示一律不进入对话正文。
 *   - 后台失败通知另行作为「真实运行事件时间线」附在文末，保留原始任务号与摘要。
 *   - 令牌/密钥等敏感串统一脱敏；图片附件只保留文件名，不导出二进制与个人目录全路径。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function die(msg) {
  console.error('[对话导出] ' + msg);
  process.exit(1);
}

const src = process.argv[2];
if (!src) {
  console.log('用法：node 03-AI-Collaboration/scripts/export-dialogue.js <会话记录.jsonl> [输出目录]');
  console.log('说明：会话记录由所用 AI 工具在本机生成，通常位于 WorkBuddy 的 projects 目录下。');
  process.exit(0);
}
if (!fs.existsSync(src)) die('找不到会话记录文件：' + src);

const OUT_DIR = process.argv[3] ? path.resolve(process.argv[3]) : path.resolve(__dirname, '..');
if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

const raw = fs.readFileSync(src);
const sourceSha = crypto.createHash('sha256').update(raw).digest('hex');
const lines = raw.toString('utf8').split(/\r?\n/).filter(l => l.trim() !== '');

/* ---------- 工具函数 ---------- */

function decodeEntities(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

function redact(s) {
  return String(s)
    .replace(/gh[pousr]_[A-Za-z0-9]{20,}/g, '[已脱敏:GitHub令牌]')
    .replace(/github_pat_[A-Za-z0-9_]{20,}/g, '[已脱敏:GitHub令牌]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/g, '[已脱敏:Bearer令牌]')
    .replace(/\b(password|passwd|pwd|secret|api_key|access_token)\b\s*[:=]\s*[^\s"'`]{6,}/gi, '$1=[已脱敏]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[已脱敏:私钥]');
}

function stamp(ms) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000); // UTC+8
  if (Number.isNaN(d.getTime())) return String(ms);
  const p = n => String(n).padStart(2, '0');
  return d.getUTCFullYear() + '-' + p(d.getUTCMonth() + 1) + '-' + p(d.getUTCDate()) + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
}

function cell(s) {
  return String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 220);
}

function textOf(msg, wantedType) {
  const c = msg.content;
  if (Array.isArray(c)) {
    return c.filter(it => it && typeof it === 'object' && it.type === wantedType)
      .map(it => String(it.text == null ? '' : it.text)).join('\n');
  }
  if (typeof c === 'string') return c;
  return '';
}

const INTERNAL_MARKERS = [
  'You are an AI agent', 'content_policy', '<system-reminder',
  'NEVER reveal, rephrase', 'IMPORTANT: You have access to three independent memory layers'
];

function looksInternal(s) {
  return INTERNAL_MARKERS.some(m => s.indexOf(m) !== -1);
}

/* ---------- 1. 解析会话记录 ---------- */

const turns = [];
const events = [];
let currentTurn = null;
let assistantMsgsBeforeFirstTurn = 0;
let filteredUserMessages = 0;
let filteredAssistantMessages = 0;
let parseErrors = 0;
let totalMessages = 0;

for (const line of lines) {
  let d;
  try { d = JSON.parse(line); } catch (_) { parseErrors += 1; continue; }
  if (d.type !== 'message') continue;
  totalMessages += 1;
  const role = d.role;
  const ts = d.timestamp;

  if (role === 'user') {
    const text = textOf(d, 'input_text');

    // 后台任务失败/网络恢复通知：不是真人提问，单独记为真实运行事件
    const notif = /<task-notification>([\s\S]*?)<\/task-notification>/.exec(text);
    if (notif) {
      const block = notif[1];
      const id = (/<task-id>([\s\S]*?)<\/task-id>/.exec(block) || [, ''])[1].trim();
      const st = (/<status>([\s\S]*?)<\/status>/.exec(block) || [, ''])[1].trim();
      const sm = (/<summary>([\s\S]*?)<\/summary>/.exec(block) || [, ''])[1].trim();
      events.push({ ts: stamp(ts), kind: '后台任务', id: id, status: st, summary: redact(decodeEntities(sm)) });
      filteredUserMessages += 1;
      continue;
    }
    if (/data-role="error-recovery"/.test(text)) {
      const m = /<system-reminder[^>]*>([\s\S]*?)<\/system-reminder>/.exec(text);
      events.push({ ts: stamp(ts), kind: '会话恢复', id: '-', status: '-', summary: redact(m ? m[1].trim() : '网络中断后继续') });
      filteredUserMessages += 1;
      continue;
    }

    // 压缩摘要 / 继续指令：宿主生成，不是本人输入
    if (/<cb_summary|<conversation_history_summary|data-role="compact-summary"|Please continue with the conversation based on the summarized context/.test(text)) {
      filteredUserMessages += 1;
      continue;
    }

    const queries = [];
    const re = /<user_query>([\s\S]*?)<\/user_query>/g;
    let m;
    while ((m = re.exec(text)) !== null) queries.push(m[1]);
    if (queries.length !== 1) { filteredUserMessages += 1; continue; }

    const images = [];
    const imRe = /<image_local_path>([\s\S]*?)<\/image_local_path>/g;
    let im;
    while ((im = imRe.exec(text)) !== null) {
      images.push(path.basename(im[1].trim().replace(/\\/g, '/')));
    }

    const query = redact(queries[0].trim());
    if (!query) { filteredUserMessages += 1; continue; }

    currentTurn = { ts: stamp(ts), query: query, images: images, answers: [] };
    turns.push(currentTurn);
  } else if (role === 'assistant') {
    if (!currentTurn) { assistantMsgsBeforeFirstTurn += 1; continue; }
    let text = textOf(d, 'output_text');
    if (looksInternal(text)) { filteredAssistantMessages += 1; continue; }
    text = redact(text).trim();
    if (text) currentTurn.answers.push(text);
  }
}

if (!turns.length) die('没有解析到任何真人提问，拒绝生成空导出。');

/* ---------- 2. 生成 Markdown ---------- */

const first = turns[0].ts.slice(0, 10);
const last = turns[turns.length - 1].ts.slice(0, 10);
const answerCount = turns.reduce((a, t) => a + t.answers.length, 0);
const answerChars = turns.reduce((a, t) => a + t.answers.join('\n').length, 0);

function fence(text) {
  return '````text\n' + text.replace(/````/g, '``` `') + '\n````';
}

const toc = turns.map((t, i) =>
  '| ' + (i + 1) + ' | ' + t.ts + ' | ' + cell(t.query.replace(/\r?\n/g, ' ').slice(0, 46)) + ' | ' +
  t.answers.length + ' | ' + t.answers.join('\n').length + ' |').join('\n');

const body = turns.map((t, i) => {
  const q = t.query + (t.images.length ? '\n［本轮附图 ' + t.images.length + ' 张：' + t.images.join('、') + '］' : '');
  const a = t.answers.length ? t.answers.join('\n\n') : '［导出时本轮尚未产生文字回答，或会话仍在进行中］';
  return '## 第 ' + (i + 1) + ' 轮 · ' + t.ts + '（UTC+8）\n\n' +
         '### 本人提问（逐字）\n\n' + fence(q) + '\n\n' +
         '### AI 回答（逐字）\n\n' + fence(a) + '\n';
}).join('\n---\n\n');

const eventRows = events.map(e =>
  '| ' + e.ts + ' | ' + cell(e.kind) + ' | ' + cell(e.id) + ' | ' + cell(e.status) + ' | ' + cell(e.summary) + ' |').join('\n');

const md = `# 真实 AI 对话逐字导出（${first} ~ ${last}）

> 对应课程目录 \`03-AI-Collaboration/ 关键 AI 提问排障对话记录\`。
> 本文件是**本项目开发过程中真实发生的人机对话**，由本机会话记录逐条解析生成，用于替代此前标注「待本人补充 chat-export」的空缺。

## 一、导出信息

| 项目 | 值 |
| --- | --- |
| 源文件 | 本机 WorkBuddy 会话记录 \`${path.basename(src)}\` |
| 源文件 SHA256 | \`${sourceSha}\` |
| 源文件字节数 | ${raw.length} |
| 解析消息总数 | ${totalMessages} |
| JSON 解析失败行 | ${parseErrors} |
| 真人提问轮次 | ${turns.length} |
| AI 可见文字回答条数 | ${answerCount} |
| 回答总字符数 | ${answerChars} |
| 真实运行事件 | ${events.length} 条（见文末附录） |
| 导出时间 | ${new Date().toISOString()} |

## 二、导出规则（可复核）

1. **只取真人输入**：仅保留恰含一个 \`<user_query>\` 标签且不含压缩摘要的用户消息；提问原文逐字保留，不润色、不缩写。
2. **回答原文保留**：只取 AI 消息中 \`output_text\` 类型的可见文字；工具调用、工具返回值、思考过程不进入正文。
3. **宿主注入内容不进正文**：\`<system-reminder>\`（运行环境、当前时间、模式切换）、压缩摘要 \`<cb_summary>\`、\`Please continue with the conversation...\` 自动继续指令、后台任务通知均被剔除，共过滤用户消息 ${filteredUserMessages} 条、内部标记 AI 消息 ${filteredAssistantMessages} 条、首轮前 AI 消息 ${assistantMsgsBeforeFirstTurn} 条。
4. **后台通知单独留证**：被过滤的后台失败通知与网络恢复事件没有丢弃，而是按真实时间整理为文末「真实运行事件时间线」，保留任务号与原始摘要。
5. **隐私处理**：令牌/密钥类字符串统一脱敏；图片附件只保留文件名，不导出二进制与个人目录全路径；不含账号密码、业务数据、用户反馈原文。
6. **最后一轮说明**：导出时会话仍在进行，最后一轮的回答可能尚未完整；这是导出时点的真实状态，不做补写。

## 三、轮次索引

| # | 时间（UTC+8） | 提问开头 | AI 回答条数 | 回答字符数 |
| --- | --- | --- | --- | --- |
${toc}

---

${body}

---

## 附：真实运行事件时间线（非对话正文）

> 以下为会话中真实出现的后台任务失败通知与网络恢复事件，按时间排序，是排障过程的原始痕迹。
> 这些事件**不是用户输入**，因此不参与上面的对话轮次。

| 时间（UTC+8） | 类型 | 任务号 | 状态 | 原始摘要 |
| --- | --- | --- | --- | --- |
${eventRows || '| （无） | - | - | - | - |'}

---

## 复现方式

\`\`\`bash
cd E:\\校园软件
node 03-AI-Collaboration/scripts/export-dialogue.js "<本机会话记录.jsonl>"
\`\`\`

脚本会重读同一份会话记录并覆盖生成本文件与 \`对话统计.json\`；源文件 SHA256 可用于核对导出是否被改动。
`;

/* ---------- 3. 统计 JSON 与写出 ---------- */

const stats = {
  generated_at: new Date().toISOString(),
  source_file: path.basename(src),
  source_sha256: sourceSha,
  source_bytes: raw.length,
  parsed_messages: totalMessages,
  json_parse_errors: parseErrors,
  real_turns: turns.length,
  assistant_answer_messages: answerCount,
  assistant_answer_chars: answerChars,
  real_events: events.length,
  filtered_user_messages: filteredUserMessages,
  filtered_assistant_messages: filteredAssistantMessages,
  assistant_messages_before_first_turn: assistantMsgsBeforeFirstTurn,
  first_turn: turns[0].ts,
  last_turn: turns[turns.length - 1].ts,
  rules: [
    'only <user_query> with exactly one match and no compact summary',
    'assistant output_text only; tool calls and tool results excluded',
    'host-injected context and task notifications excluded from dialogue body',
    'task notifications preserved as a separate real event timeline',
    'secrets redacted; image attachments keep filenames only',
    'verbatim text, no rewriting, no fabrication'
  ],
  turns: turns.map((t, i) => ({
    index: i + 1,
    time: t.ts,
    query_chars: t.query.length,
    images: t.images.length,
    answer_messages: t.answers.length,
    answer_chars: t.answers.join('\n').length
  }))
};

const mdPath = path.join(OUT_DIR, 'chat-export.md');
const jsonPath = path.join(OUT_DIR, '对话统计.json');
fs.writeFileSync(mdPath, md, 'utf8');
fs.writeFileSync(jsonPath, JSON.stringify(stats, null, 2) + '\n', 'utf8');

console.log('[对话导出] 真人提问 ' + turns.length + ' 轮，AI 回答 ' + answerCount + ' 条，运行事件 ' + events.length + ' 条');
console.log('[对话导出] 已生成 ' + mdPath + ' 与 ' + jsonPath);
