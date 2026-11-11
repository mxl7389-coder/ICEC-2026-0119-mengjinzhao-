# 校园事务台 · CampusDesk

> 对应课程作业 **项目四：解决校园真实痛点的轻量化实用程序研发与日常运行日志验证**

一个跑在个人电脑上的校园工具站，把三件高频、琐碎、容易漏的事收进一个地方：

| 痛点 | 工具 | 具体解决什么 |
| --- | --- | --- |
| 班群/教务通知淹没在聊天里 | **通知提取** | 粘贴原文，自动拆出时间、地点、对象、截止日期、待办，可存清单、导出 `.ics` 日历、复制 Markdown |
| 器材"账上有、柜里没有" | **器材借还核对** | 借出/部分归还/全部归还登记，自动核对可用库存、标记逾期、发现账实差异 |
| 错题抄完就再也不看 | **错题归档** | 按学科+知识点归档，按 1/2/4/7/15/30 天间隔排队复习，标记掌握后出队 |

**技术选型**：Node.js 原生 `http` + 原生前端，零第三方依赖、无 CDN、无 API Key、不联网。Node 18+ 直接跑，数据落在本地 `data/*.json`。

---

## 快速开始

```bash
node server.js
# 浏览器打开 http://localhost:5173
```

首次启动会自动创建 6 类示例器材。想验证全部接口并产生真实调用日志：

```bash
node scripts/smoke-test.js     # 独立端口 5199 + 隔离数据目录，不污染日常数据
```

收工前同步当天日志：

```bash
node scripts/daily-report.js --sync   # 生成日报并自动 git commit（不会 push）
git push
```

---

## 对应作业的评分点

### ① 连续 ≥7 天自动化运行日志（25 分）

每次页面加载与接口调用结束时，由 `lib/telemetry.js` **自动**写一行 JSONL 到 `process_logs/YYYY-MM-DD.jsonl`：

```json
{"ts":"2026-11-11T09:12:33.123Z","day":"2026-11-11","app_version":"v3.0.0","session":"a1b2c3d4e5f6","module":"notice","action":"parse","status":"ok","duration_ms":3.42,"error_code":null,"meta":{"input_len":128,"hit_rules":7,"confidence":88,"parse_ms":1.1,"warning_count":0}}
```

- **调用频次**：按模块 / 动作 / 自然日聚合，页面「运行日志」可直接看。
- **耗时**：`duration_ms`，日报里给平均值、P95 与峰值。
- **报错**：`status=error` + `error_code`（如 `EMPTY_NOTICE`、`OUT_OF_STOCK`、`UNKNOWN_ROUTE`），由真实失败请求产生。
- **脱敏**：日志不写通知原文、姓名、学号、题目、反馈正文；`meta` 只留长度、条数、命中规则数等可统计特征，并有字段名黑名单兜底；`session` 是不可逆哈希。
- **每日同步**：`node scripts/daily-report.js --sync` 生成 `process_logs/summary-YYYY-MM-DD.md` 并自动 `git add process_logs/ data/` + `commit`。

> ⚠️ **诚实说明**：连续 7 天必须由你真实运行、真实使用来累计，程序不会（也不应该）补造历史日志。从今天开始每天用一次、睡前跑一次 `--sync`，7 天后 `process_logs/` 里自然就是 7 个日期文件。`node scripts/smoke-test.js` 产生的是当天的真实自动化调用记录，不是伪造的历史数据。

### ② 基于日志的 ≥3 次 Git 迭代 Diff（20 分）

见下方「Git 迭代记录」。每次迭代都对应日志里能观察到的具体现象，而不是随手改格式。可用 `git log --stat` / `git diff <commit> <commit>` 查看。

### ③ 完整源码 + 8 位真实用户反馈（15 分）

源码全部在本仓库。反馈通过页面「使用反馈」表单收集，也可以线下用 [`docs/用户反馈表.md`](docs/用户反馈表.md) 的 8 份空白模板收集后录入。

> ⚠️ **诚实说明**：8 份反馈必须由 8 位真实同学试用后亲自填写，系统不生成任何虚构评价，`data/feedback.json` 初始为空。

---

## Git 迭代记录

### v1 · 基础可运行版
- `server.js` 零依赖 HTTP 服务 + 静态资源 + 统一错误处理
- `lib/telemetry.js` 自动脱敏日志、`lib/store.js` JSON 原子存储
- `lib/extractor.js` 中文通知规则引擎（绝对/相对日期、时间段、地点、对象、分类、截止、待办、ICS）
- 三大工具 API + 六个前端视图 + 冒烟测试 + 日报脚本

### v2 · 依据首日日志修复解析缺陷

**日志证据**（`process_logs/` 首日文件）：共 25 次调用、3 次报错（`EMPTY_NOTICE` / `OUT_OF_STOCK` / `UNKNOWN_ROUTE`）；三次 `notice/parse` 的 `confidence` 为 **88 / 88 / 63**，第三条 `hit_rules=5` 但 `warning_count=0` —— 说明规则引擎"自信地"漏掉了字段，属于日志看不出的静默失败。逐条复核后定位到 6 个缺陷：

| # | 现象 | 修复 |
| --- | --- | --- |
| 1 | 地点把 `14:30在` 吞成 `30在教学楼A301教室` | 通用地点正则要求中文/字母开头，并过滤介词前缀与子串重复 |
| 2 | 体测通知把截止日 `11/20` 当成活动日 | `parseDates` 记录命中位置并按原文顺序排序，正确回到"下周三" `11/18` |
| 3 | `请全体本科生于12月1日前…` 的截止日期为空 | 重写 `parseDeadline`：显式截止短语优先 + 新增「日期紧贴`前`」分支 |
| 4 | `全体本科生` 未识别为对象 | 扩充对象正则，支持本科/研究生/专科等后缀 |
| 5 | 标题硬截 30 字，把半句话切进标题 | 优先「关于…的通知」，否则按句读切分并加分类前缀 |
| 6 | 体测通知被"报名"抢成报名申请 | 分类关键词加权，活动/调课/器材类权重高于通用动词 |

同时让日志变得**可观测**：`meta` 新增 `missing_field_count` / `missing_keys`（只记字段代号），并对"含截止表述却没解析出截止""出现多个日期"给出 warning，避免下次再出现 `warning_count=0` 的静默失败。日志 `app_version` 随之升到 `v2.0.0`。

**复测结果**（`node scripts/smoke-test.js`）：三条示例 `confidence` 全部为 **88**；活动日期 `11-14 / 11-18 / 12-01`，截止 `11-13 / 11-20 / 12-01`，地点 `教学楼A301教室 / 东区操场 / 学生事务中心一楼大厅`。

### v3 · 依据耗时与报错数据优化

**日志证据**：v2 日志里写类请求明显慢于读类 —— `notice/save` 15ms、`loan/create` 13.65ms、`feedback/add` 12.94ms、`mistake/add` 12.37ms，而 `health` / `notice/list` 等读请求普遍 <2ms，峰值 `bootstrap` 28.19ms。同时三类报错（`EMPTY_NOTICE` / `OUT_OF_STOCK` / `UNKNOWN_ROUTE`）在日志页只能看到总次数，无法按错误码定位高频问题。

| # | 优化 | 做法 |
| --- | --- | --- |
| 1 | 单请求重复计算 | `handle` / `route` 拆分，加入请求级库存快照缓存；`bootstrap` 与 `dashboard` 共用一次 `reconcile()`，`equipment/list` 从算两次降为一次 |
| 2 | 借出校验过重 | 新增 `availableOf()`，只算目标器材的可用量，不再为校验单件而重建整张流水表 |
| 3 | 日报阻塞事件循环 | `logs/report` 由 `execFileSync` 改为异步 `execFile` + Promise |
| 4 | 报错不可聚合 | `telemetry.aggregate()` 与日报新增 `by_error_code`，日志页新增错误码分布条 |
| 5 | 优化效果不可见 | 每条日志的 `meta` 新增 `reconcile_calls`（实际计算次数），冒烟测试新增 3 项断言直接校验它 ≤1 |

日志 `app_version` 升到 `v3.0.0`。**复测**：冒烟测试 27/27 项通过，所有 `v3.0.0` 请求的 `reconcile_calls` 均 ≤1，错误码聚合覆盖 3 类。

> 耗时实测：平均 `5.49ms (v1) → 5.03ms (v2) → 5.10ms (v3)`，`bootstrap` `28.19ms → 24.84ms`。**不夸大提速幅度** —— 当前只有 6 类器材、几十条流水，重复计算本身很便宜，主要耗时来自同步写盘与首次启动；这次改动的价值在于数据量增长后不再随流水线性放大，以及去掉 `execFileSync` 对整个事件循环的阻塞，并让 `reconcile_calls` 成为可长期观测的指标。

---

## 隐私与数据

| 位置 | 内容 | 是否提交 GitHub |
| --- | --- | --- |
| `data/*.json` | 业务数据（通知、借还、错题、反馈） | **否**，`.gitignore` 已排除 |
| `process_logs/*.jsonl` | 脱敏运行日志 | 是，作业要求 |
| `process_logs/summary-*.md` | 每日自动汇总 | 是 |

业务数据只留在本机；填写借用人时建议用昵称或学号后四位，不要填真实姓名全名。

---

## 目录结构

```
server.js              本地 HTTP 服务（默认 5173）
lib/telemetry.js       自动脱敏运行日志 + 聚合统计
lib/extractor.js       中文通知结构化引擎
lib/api.js             三大工具业务接口 + 看板 + 日志 + 反馈
lib/store.js           JSON 原子读写
public/                前端（index.html / style.css / app.js，离线可用）
scripts/smoke-test.js  全接口冒烟测试（真实产生调用日志）
scripts/daily-report.js 每日日志汇总 + 一键 git 同步
data/                  业务数据（本机）
process_logs/          每日 telemetry + 日报
docs/用户反馈表.md      8 份真实反馈空白模板
```

## 命令速查

| 目的 | 命令 |
| --- | --- |
| 启动网站 | `node server.js` |
| 指定端口 | `PORT=8080 node server.js` |
| 跑接口测试 | `node scripts/smoke-test.js` |
| 生成今日日报 | `node scripts/daily-report.js` |
| 生成日报并提交 | `node scripts/daily-report.js --sync` |
| 查看迭代 diff | `git log --stat`、`git diff HEAD~2 HEAD` |
| 统计日志天数 | `ls process_logs/*.jsonl \| wc -l` |
