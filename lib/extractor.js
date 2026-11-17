'use strict';
/**
 * 中文校园通知 → 结构化待办
 *
 * 纯本地规则引擎，不联网、不需要 API Key，个人电脑可直接运行。
 * 命中规则数 / 置信度 / 告警会作为脱敏特征值写入 telemetry，
 * 用来驱动后续迭代（例如发现某类日期格式没覆盖就补规则）。
 */
const CN_NUM = { 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17, 十八: 18, 十九: 19, 二十: 20, 二十一: 21, 二十二: 22, 二十三: 23, 二十四: 24, 二十五: 25, 二十六: 26, 二十七: 27, 二十八: 28, 二十九: 29, 三十: 30, 三十一: 31, 日: 0, 天: 0 };

const CATEGORY_RULES = [
  { key: 'exam', label: '考试', words: ['考试', '测验', '期末', '期中', '模拟考', '四六级', '听力测试'] },
  { key: 'lecture', label: '讲座', words: ['讲座', '报告会', '学术报告', '分享会', '论坛'] },
  { key: 'meeting', label: '会议', words: ['会议', '班会', '例会', '座谈会', '代表大会'] },
  { key: 'signup', label: '报名申请', words: ['报名', '申请', '评选', '遴选', '申报', '推荐表'] },
  { key: 'payment', label: '缴费', words: ['缴费', '交费', '收费', '缴纳', '学费', '书本费'] },
  { key: 'submit', label: '材料提交', words: ['提交', '上交', '报送', '填写', '上传', '交至', '汇总表'] },
  { key: 'event', label: '活动比赛', words: ['运动会', '比赛', '竞赛', '活动', '志愿服务', '社会实践', '晚会', '体测'] },
  { key: 'schedule', label: '调课放假', words: ['停课', '调课', '放假', '补课', '作息调整', '停水', '停电'] },
  { key: 'equipment', label: '器材物资', words: ['器材', '借用', '归还', '领取物资', '设备'] },
];

const TAG_WORDS = ['奖学金', '助学金', '四六级', '体测', '运动会', '实验室', '实习', '毕业', '选课', '评优', '宿舍', '安全', '防疫', '志愿者', '社团', '竞赛', '图书馆', '一卡通', '档案', '入党', '军训'];

const LOCATION_SUFFIX = '(?:教学楼|教学大楼|综合楼|实验楼|办公楼|宿舍楼|食堂|图书馆|体育馆|报告厅|礼堂|操场|田径场|篮球场|教室|实验室|会议室|机房|办公室|中心|广场|大厅|楼|馆|场|室)';

function p2(n) { return String(n).padStart(2, '0'); }
function toISO(d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
function addDays(d, n) { const x = new Date(d.getTime()); x.setDate(x.getDate() + n); return x; }
function cnToNum(s) {
  if (/^\d+$/.test(s)) return Number(s);
  return CN_NUM[s] !== undefined ? CN_NUM[s] : NaN;
}
function normalize(text) {
  return String(text || '')
    .replace(/[\uFF01-\uFF5E]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/\u3000/g, ' ')
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** 从一段中文里抽出所有日期，返回 {iso, label, source} */
function parseDates(text, base) {
  const now = base || new Date();
  const out = [];
  // 记录命中位置：日志显示「截止日」常排在「活动日」前面被误当成活动时间，
  // 因此统一按原文出现顺序排序，而不是按规则扫描顺序。
  const push = (d, label, source, pos) => {
    if (d && !Number.isNaN(d.getTime())) {
      out.push({ iso: toISO(d), label, source, pos: pos || 0 });
    }
  };
  const y = now.getFullYear();

  // 2026年11月12日 / 2026-11-12 / 2026/11/12
  const abs = /(?:(\d{4})\s*[年\/-]\s*)?(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*[日号]?/g;
  let m;
  while ((m = abs.exec(text)) !== null) {
    const yy = m[1] ? Number(m[1]) : y;
    const mm = Number(m[2]), dd = Number(m[3]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      let d = new Date(yy, mm - 1, dd);
      // 未写年份且日期已过去较久，推定到明年
      if (!m[1] && (now - d) / 86400000 > 180) d = new Date(yy + 1, mm - 1, dd);
      push(d, p2(mm) + '月' + p2(dd) + '日', m[0], m.index);
    }
  }
  // 中文数字：十一月十二日
  const cnAbs = /([一二三四五六七八九十]{1,3})月([一二三四五六七八九十]{1,3})[日号]/g;
  while ((m = cnAbs.exec(text)) !== null) {
    const mm = cnToNum(m[1]), dd = cnToNum(m[2]);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      push(new Date(y, mm - 1, dd), mm + '月' + dd + '日', m[0], m.index);
    }
  }
  // 相对日：今天 / 明天 / 后天 / 大后天
  const rel = { 今天: 0, 今日: 0, 当晚: 0, 明天: 1, 明日: 1, 后天: 2, 大后天: 3 };
  for (const [word, delta] of Object.entries(rel)) {
    const pos = text.indexOf(word);
    if (pos >= 0) push(addDays(now, delta), word, word, pos);
  }
  // 本周X / 下周X / 周X / 星期X
  const weekRe = /(本|这|下|上)?\s*(?:周|星期)\s*([一二三四五六日天1-7])/g;
  while ((m = weekRe.exec(text)) !== null) {
    let target = cnToNum(m[2]);
    if (target === 0) target = 7; // 周日
    const dow = now.getDay() === 0 ? 7 : now.getDay(); // 周一=1
    let diff = target - dow;
    if (m[1] === '下') diff += 7;
    else if (m[1] === '上') diff -= 7;
    else if (!m[1] && diff < 0) diff += 7; // 只写「周三」且已过 → 下周
    push(addDays(now, diff), m[0], m[0], m.index);
  }
  return out.sort((a, b) => a.pos - b.pos);
}

/** 抽取时间段 */
function parseTimes(text) {
  const times = [];
  const clock = /(\d{1,2})\s*[:：]\s*(\d{2})(?:\s*[-~～至到]\s*(\d{1,2})\s*[:：]\s*(\d{2}))?/g;
  let m;
  while ((m = clock.exec(text)) !== null) {
    const start = p2(Number(m[1])) + ':' + p2(Number(m[2]));
    const end = m[3] ? p2(Number(m[3])) + ':' + p2(Number(m[4])) : null;
    times.push({ start, end, source: m[0] });
  }
  if (times.length) return times;
  const cn = /(上午|下午|中午|晚上|早上)?\s*(\d{1,2})\s*点\s*(半|(\d{1,2})\s*分?)?/g;
  while ((m = cn.exec(text)) !== null) {
    let h = Number(m[2]);
    if ((m[1] === '下午' || m[1] === '晚上') && h < 12) h += 12;
    const mm = m[3] === '半' ? '30' : p2(Number(m[4] || 0));
    times.push({ start: p2(h) + ':' + mm, end: null, source: m[0] });
  }
  return times;
}

function parseLocations(text) {
  const found = [];
  const labeled = /(?:地点|地址|会场|集合地点|活动地点|考试地点)\s*[:：]?\s*([^\n，,。；;、]{2,24})/g;
  let m;
  while ((m = labeled.exec(text)) !== null) {
    const v = m[1].replace(/^(在|于)\s*/, '').trim();
    if (v && !found.includes(v)) found.push(v);
  }
  // 前缀必须以中文/字母开头：v1 曾把「14:30在教学楼」里的「30在」吞进地点字段，
  // 该缺陷由首日日志里 confidence 偏低复核时发现。
  const generic = new RegExp('([\\u4e00-\\u9fa5A-Za-z][\\u4e00-\\u9fa5A-Za-z0-9]{0,9}' + LOCATION_SUFFIX + ')', 'g');
  while ((m = generic.exec(text)) !== null) {
    const v = m[1].replace(/^(?:在|于|到|前往|至)+/, '').trim();
    if (!v || v.length < 2 || found.includes(v)) continue;
    if (found.some((f) => f.includes(v) || v.includes(f))) continue; // 避免「学生事务中心」与「…一楼大厅」重复
    found.push(v);
  }
  return found.slice(0, 4);
}

function parseAudience(text) {
  const found = [];
  const patterns = [
    /(?:全体|全院|全校)(?:本科|研究生|专科|硕士|博士)?(?:同学|学生|师生员工|师生|教职工|生)/g,
    /\d{4}\s*级(?:[^\s，,。；;、]{0,6}?(?:班|专业|同学|学生))?/g,
    /[一二三四五六七八九十\d]{1,3}\s*班/g,
    /各班(?:班长|学习委员|团支书|同学)?/g,
    /(?:班长|学习委员|团支书|宿舍长|辅导员|班主任|课代表)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) {
      const v = m[0].trim();
      if (v && !found.includes(v)) found.push(v);
    }
  }
  return found.slice(0, 5);
}

// 首日日志显示「补测报名截止…」被判成报名申请，而真正的主题是体测活动。
// 给活动/调课/器材类关键词更高权重，避免「报名」「提交」这类通用动词抢占分类。
const CATEGORY_WEIGHT = {
  exam: 1.2, lecture: 1.2, meeting: 1, signup: 1, payment: 1.2,
  submit: 1, event: 3, schedule: 2.5, equipment: 2, other: 1,
};
function classify(text) {
  let best = { key: 'other', label: '其他通知', hits: 0 };
  let bestScore = 0;
  for (const rule of CATEGORY_RULES) {
    const hits = rule.words.filter((w) => text.includes(w)).length;
    const score = hits * (CATEGORY_WEIGHT[rule.key] || 1);
    if (score > bestScore) { best = { key: rule.key, label: rule.label, hits }; bestScore = score; }
  }
  return best;
}

/** 从通知里挑出「需要做的事」，生成可勾选待办 */
function parseTodos(text) {
  const verb = /(请|务必|需|需要|要求|须|请于|请将|请各|不得|禁止|记得|携带|参加|提交|上交|报送|填写|完成|领取|缴纳|签到|准时|提前)/;
  const chunks = text.split(/[\n。；;!！?？]/).map((s) => s.trim()).filter(Boolean);
  const todos = [];
  for (const chunk of chunks) {
    if (!verb.test(chunk) || chunk.length < 4) continue;
    const clean = chunk
      .replace(/^\s*(?:各位|各|请|通知|关于|现将|兹有)\s*/, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (clean.length < 4) continue;
    todos.push(clean.length > 46 ? clean.slice(0, 46) + '…' : clean);
  }
  return todos.slice(0, 5);
}

/** 截止日期：优先取显式截止短语后的日期，其次匹配「12月1日前」这类紧贴写法 */
function parseDeadline(text, base) {
  const now = base || new Date();
  let m;
  // v1 的正则用了惰性量词且缺少「于…前」分支，导致「请全体本科生于12月1日前…」被静默漏掉。
  const markers = /(?:截止(?:时间|日期)?|最迟|不迟于|不晚于|请于|须于|务必于)/g;
  while ((m = markers.exec(text)) !== null) {
    const tail = text.slice(m.index, m.index + 40);
    const found = parseDates(tail, now);
    if (found.length) return found[0].iso;
  }
  const before = /(\d{4}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?)\s*(?:之|以)?前/g;
  while ((m = before.exec(text)) !== null) {
    const found = parseDates(m[1], now);
    if (found.length) return found[0].iso;
  }
  return null;
}

function makeTitle(lines, category, text) {
  const about = String(text).replace(/\n/g, ' ')
    .match(/关于[^\n，,。]{2,30}?(?:的)?(?:通知|公告|安排|提醒|须知)/);
  if (about) return about[0];
  // v1 直接截首行前 30 字，会把「请全体本科…」半句话切进标题。
  const first = (lines[0] || '')
    .replace(/^【[^】]*】\s*/, '')
    .replace(/^(?:各位同学|全体同学|同学们|各位|通知)\s*[:：,，]?\s*/, '')
    .trim();
  if (/通知|公告|安排|提醒|须知/.test(first)) {
    const head = first.split(/[，,。；;]/)[0].trim();
    if (head.length >= 4 && head.length <= 36) return head;
  }
  const core = first.split(/[，,。；;]/)[0]
    .replace(/\d{1,2}\s*[:：]\s*\d{2}(?:\s*[-~～至到]\s*\d{1,2}\s*[:：]\s*\d{2})?/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const short = core.length > 18 ? core.slice(0, 18) + '…' : core;
  return short ? category.label + ' · ' + short : category.label + '提醒';
}

function icsStamp(iso, time) {
  const [y, mo, d] = iso.split('-').map(Number);
  const [h, mi] = (time || '09:00').split(':').map(Number);
  const dt = new Date(y, mo - 1, d, h, mi, 0);
  return dt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function buildICS(notice) {
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//CampusDesk//NoticeExtractor//CN',
    'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'BEGIN:VEVENT',
    'UID:' + notice.id + '@campusdesk.local',
    'DTSTAMP:' + icsStamp(notice.created_at.slice(0, 10), '00:00'),
    'DTSTART:' + icsStamp(notice.event_date || notice.deadline || notice.created_at.slice(0, 10), notice.event_time || '09:00'),
  ];
  if (notice.event_time) {
    const [y, mo, d] = (notice.event_date || notice.created_at.slice(0, 10)).split('-').map(Number);
    const [h, mi] = notice.event_time.split(':').map(Number);
    const end = new Date(y, mo - 1, d, h, mi + 60, 0);
    lines.push('DTEND:' + end.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''));
  }
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\n/g, '\\n');
  lines.push('SUMMARY:' + esc(notice.title));
  lines.push('DESCRIPTION:' + esc('分类:' + notice.category + ' | 对象:' + (notice.audience || []).join('、') + ' | 由 CampusDesk 自动提取'));
  if (notice.location) lines.push('LOCATION:' + esc(notice.location));
  lines.push('BEGIN:VALARM', 'TRIGGER:-PT30M', 'ACTION:DISPLAY', 'DESCRIPTION:校园事务提醒', 'END:VALARM');
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n');
}

/**
 * 主入口：extract(rawText, options) → 结构化通知对象
 */
/* ------------------------------------------------------------------
   v6 · 对齐 SRS CM-FR-102 / CM-FR-104 补充的结构化字段
   全部为本地规则判定，结果必须经人工审核后才可保存（CM-FR-105）。
   不改动原有 8 项命中规则与置信度口径，保证历史 telemetry 可比。
   ------------------------------------------------------------------ */

/** 发布单位：优先显式标签，其次机构名后缀，最后常见部门词 */
function parseIssuer(text, lines) {
  const labelled = text.match(/(?:发布单位|发文单位|发布部门|主办单位|来源|落款)\s*[:：]\s*([\u4e00-\u9fa5A-Za-z0-9]{2,20})/);
  if (labelled) return labelled[1];
  // 只认首行开头的机构名，避免把「登录教务系」「提交至办公室」之类的动作短语误判为单位
  const org = (lines[0] || '').match(/^(?:【[^】]*】)?\s*([\u4e00-\u9fa5]{2,10}(?:教务处|学生工作处|研究生院|学生处|团委|学院|中心|办公室|学生会|班委会|图书馆|保卫处|财务处|后勤处))/);
  if (org && !/(?:登录|提交|上传|前往|到|至|请|于)/.test(org[1])) return org[1];
  for (const w of ['教务处', '学生工作处', '校团委', '辅导员办公室', '图书馆', '实验室管理中心', '财务处', '保卫处']) {
    if (text.includes(w)) return w;
  }
  return '';
}

/** 联系方式：手机号 / 带区号座机 / 邮箱 / IM / 显式咨询信息。均为原文可见片段，日志侧已脱敏 */
function parseContact(text) {
  const out = [];
  const push = (prefix, v) => {
    const s = (prefix || '') + String(v).trim();
    if (s && s.length <= 40 && !out.includes(s) && out.length < 5) out.push(s);
  };
  const person = text.match(/(?:联系人|咨询人)\s*[:：]?\s*([\u4e00-\u9fa5A-Za-z]{2,8})/);
  if (person) push('联系人：', person[1]);
  for (const m of text.matchAll(/(?<!\d)1[3-9]\d{9}(?!\d)/g)) push('', m[0]);
  for (const m of text.matchAll(/(?<!\d)0\d{2,3}-\d{7,8}(?!\d)/g)) push('', m[0]);
  for (const m of text.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)) push('', m[0]);
  for (const m of text.matchAll(/(?:QQ|微信|钉钉)\s*[:：]?\s*([A-Za-z0-9_-]{5,20})/g)) push('', m[1]);
  const consult = text.match(/(?:咨询|联系)\s*(?:地点|电话|方式)?\s*[:：]\s*([^\n，。；]{2,30})/);
  if (consult) push('', consult[1]);
  return out;
}

/** 所需材料：从「携带 / 提交 / 上传 / 填写」等动词后取名词短语，剔除动作句与日期 */
function parseMaterials(text) {
  const found = new Set();
  const re = /(?:携带|带齐|带上|随身带|准备|提交|上传|附上|提供|需交|报送|填写)\s*[:：]?\s*([^。；;\n，,]{2,40})/g;
  let m;
  while ((m = re.exec(text)) !== null && found.size < 8) {
    const chunk = m[1]
      .replace(/^(?:请|并|须|需|将|把|一份|各)\s*/, '')
      .split(/[、,，及和]|以及/)[0]
      .replace(/(?:并|且|同时|逾期|截止|请于|于\d|前将|至).*$/, '')
      .replace(/(?:等)?(?:电子版|纸质版|复印件|原件)$/, '')
      .trim();
    if (chunk.length >= 2 && chunk.length <= 24 && !/^\d/.test(chunk) &&
        !/^(?:会议|活动|参加|准时|登录|系统|地点|时间|同学|报名|申请表上传)/.test(chunk)) {
      found.add(chunk);
    }
  }
  return [...found].slice(0, 6);
}

/** 重要程度：紧急 / 重要 / 普通，纯语义关键词加权，界面必须标注「规则判定，需人工确认」 */
function parseImportance(text) {
  let score = 0;
  if (/(紧急|加急|务必|立即|马上|尽快|逾期不再|视为自动放弃|不再受理|过期不候|逾期未)/.test(text)) score += 2;
  if (/(重要通知|请务必|必须|不得|严禁|全体|所有|截止|逾期)/.test(text)) score += 1;
  if (/(考试|缴费|评选|奖学金|体测|提交|报送)/.test(text)) score += 1;
  return score >= 3 ? '紧急' : score >= 1 ? '重要' : '普通';
}

function extract(rawText, options = {}) {
  const started = process.hrtime.bigint();
  const text = normalize(rawText);
  const warnings = [];
  if (!text) {
    const err = Object.assign(new Error('通知内容为空'), { code: 'EMPTY_NOTICE' });
    throw err;
  }

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const base = options.now ? new Date(options.now) : new Date();
  const dates = parseDates(text, base);
  const times = parseTimes(text);
  const locations = parseLocations(text);
  const audience = parseAudience(text);
  const category = classify(text);
  const todos = parseTodos(text);
  const deadline = parseDeadline(text, base);
  const tags = TAG_WORDS.filter((w) => text.includes(w)).slice(0, 6);
  const issuer = parseIssuer(text, lines);
  const contact = parseContact(text);
  const materials = parseMaterials(text);
  const importance = parseImportance(text);

  if (!dates.length) warnings.push('未识别到明确日期，请手动确认时间');
  if (!locations.length) warnings.push('未识别到地点');
  if (!todos.length) warnings.push('未识别到具体待办，建议手动补充');
  // 让「静默失败」进入日志指标：v1 漏识别截止日期时 warning_count 仍为 0，
  // 从 telemetry 完全看不出解析质量下降。
  if (!deadline && /(?:截止|最迟|不迟于|请于|须于|[日号]\s*(?:之|以)?前)/.test(text)) {
    warnings.push('含截止表述但未识别到截止日期，请手动确认');
  }
  if (dates.length > 1) {
    warnings.push('检测到 ' + dates.length + ' 个日期，已按原文出现顺序取第一个作为活动时间');
  }

  // 去重日期，保留出现顺序
  const seen = new Set();
  const uniqueDates = dates.filter((d) => !seen.has(d.iso) && seen.add(d.iso));
  const primary = uniqueDates[0] || null;

  const hitRules = [
    uniqueDates.length > 0, times.length > 0, locations.length > 0,
    audience.length > 0, category.key !== 'other', todos.length > 0,
    deadline !== null, tags.length > 0,
  ].filter(Boolean).length;
  const confidence = Math.round(hitRules / 8 * 100);

  const nowIso = base.toISOString();
  const notice = {
    id: options.id,
    title: makeTitle(lines, category, text),
    raw_length: text.length,
    category: category.label,
    category_key: category.key,
    audience,
    location: locations[0] || '',
    locations,
    event_date: primary ? primary.iso : '',
    event_time: times.length ? times[0].start : '',
    event_end_time: times.length ? times[0].end : '',
    date_candidates: uniqueDates.slice(0, 5).map((d) => ({ iso: d.iso, label: d.label })),
    deadline: deadline || '',
    todos: todos.length ? todos : ['查看通知详情并确认是否需要行动'],
    tags,
    issuer,
    contact,
    materials,
    importance,
    extract_engine: 'local-rules',
    reviewed: false,
    confidence,
    hit_rules: hitRules,
    warnings,
    parse_ms: Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10,
    created_at: nowIso,
    done: false,
    source: options.source || 'manual',
  };
  notice.ics = buildICS(notice);
  return notice;
}

/** 给前端演示用的示例通知 */
const SAMPLES = [
  {
    label: '班会 + 材料提交',
    text: '关于召开期中总结班会的通知\n请各班班长于11月14日（本周五）下午14:30在教学楼A301教室参加期中总结班会，并携带班级考勤汇总表。\n请于11月13日18:00前将电子版汇总表提交至辅导员办公室。',
  },
  {
    label: '体测补测安排',
    text: '各位同学：2026年体质健康测试补测定于下周三 9:00-11:00 在东区操场进行，请体测未达标的同学准时参加，携带一卡通并穿着运动服。逾期未参加者视为自动放弃，补测报名截止11月20日。',
  },
  {
    label: '奖学金申报',
    text: '【通知】2025-2026学年校级奖学金评选开始，请全体本科生于12月1日前登录教务系统填写申请表并上传佐证材料，逾期不再受理。咨询地点：学生事务中心一楼大厅。',
  },
];

module.exports = { extract, normalize, parseDates, parseTimes, buildICS, SAMPLES };
