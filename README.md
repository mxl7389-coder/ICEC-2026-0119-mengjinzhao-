# 校园事务台 · CampusDesk

> 对应课程作业 **项目四：解决校园真实痛点的轻量化实用程序研发与日常运行日志验证**

一个跑在个人电脑上的校园工具站，把三件高频、琐碎、容易漏的事收进一个地方：

| 痛点 | 工具 | 具体解决什么 |
| --- | --- | --- |
| 班群/教务通知淹没在聊天里 | **通知提取** | 粘贴原文，自动拆出时间、地点、对象、截止日期、待办，可存清单、导出 `.ics` 日历、复制 Markdown |
| 器材"账上有、柜里没有" | **器材借还核对** | 借出/部分归还/全部归还登记，自动核对可用库存、标记逾期、发现账实差异 |
| 错题抄完就再也不看 | **错题归档** | 按学科+知识点归档，按 1/2/4/7/15/30 天间隔排队复习，标记掌握后出队 |

**技术选型**：Node.js 原生 `http` + 原生前端，零第三方依赖、无 CDN、无 API Key、不联网。Node 18+ 直接跑，业务数据落在本地 `data/*.json`。

---

## v4：前后端分离 + 登录 + 实时日志后台

这一版把「一个页面」拆成三个入口，并加入账号体系：

| 入口 | 使用者 | 内容 |
| --- | --- | --- |
| `/login.html` | 所有人 | 登录；**首次打开时由你本人创建第一位管理员** |
| `/index.html` | 学生 / 教师 | 总览、通知提取、器材借还、错题归档、使用反馈、项目说明 |
| `/admin.html` | 管理员 | **SSE 实时运行日志**、日志分析、账号管理、数据总览 |

角色权限（服务端二次校验，仅靠隐藏按钮无法越权）：

| 能力 | 学生 | 教师 | 管理员 |
| --- | :---: | :---: | :---: |
| 录入并查看**自己**的通知与错题 | ✓ | ✓（看全部） | ✓（看全部） |
| 登记器材借出 / 归还 | ✓ | ✓ | ✓ |
| 新增 / 删除器材、删除通知与错题 | — | ✓ | ✓ |
| 查看反馈汇总 | — | ✓ | ✓ |
| 实时日志 / 日志分析 / 账号管理 | — | — | ✓ |

- 密码：`scrypt` 加盐哈希，明文不落盘；会话为 `HttpOnly + SameSite=Lax` Cookie，服务端只存 token 哈希，7 天有效。
- 登录失败限流：同一 IP 10 分钟内 8 次失败后暂时拒绝；账号不存在时也做一次等价哈希计算，避免时序枚举。
- 学生只能看到自己录入的通知与错题（记录带 `owner_id`），教师/管理员看全部。
- **实时日志**：`lib/telemetry.js` 落盘后向订阅者广播，`/api/admin/stream` 以 SSE 推送；断线自动重连，重连期间由 `/api/admin/poll?cursor=N` 按游标补齐，不重不漏。

### ⚠️ 零预置数据

**程序不添加任何数据，一切由你和使用者录入。**

- 不预置账号：第一位管理员必须你自己在首次打开时创建；其余账号由管理员在后台创建。
- 不预置器材、通知、错题、样例文本或反馈：`data/*.json` 初始全部为 `[]`，界面显示明确的空状态与下一步指引。
- `lib/api.js` 中已彻底移除 `seedEquipment()` 与自动播种逻辑；`bootstrap` 不再下发示例通知。
- `process_logs/` 里的日志是**程序自动采集的运行痕迹**（每次真实请求一行），不是业务数据，也不是补造的历史记录。
- 冒烟测试只在 `data/__smoke__/` 隔离目录里造测试账号与记录，跑完即删除，不会污染日常数据。

---

## 快速开始

```bash
node server.js
# 浏览器打开 http://localhost:5173/login.html
```

默认端口 5173；若被本机其它服务占用，会自动顺延到 5174、5175……以终端实际打印的地址为准。也可显式指定：`PORT=8080 node server.js`。

**第一次打开**：页面显示「创建管理员账号」，填好显示名称、账号、密码后自动进入管理后台 → 在「账号管理」里创建学生 / 教师账号 → 把账号密码线下告知本人 → 使用者登录后自行录入数据。

```bash
node scripts/smoke-test.js     # 独立端口 5199 + 隔离数据目录，50 项断言
node scripts/daily-report.js --sync   # 生成当日日报并自动 git commit（不 push）
git push                      # 需要提交到 GitHub 时再执行
```

更详细的操作步骤见 [`docs/使用说明.md`](docs/使用说明.md)。

---

## 对应作业的评分点

### ① 连续 ≥7 天自动化运行日志（25 分）

每次页面加载与接口调用结束时，由 `lib/telemetry.js` **自动**写一行 JSONL 到 `process_logs/YYYY-MM-DD.jsonl`：

```json
{"ts":"2026-11-11T09:12:33.123Z","day":"2026-11-11","app_version":"v4.0.1","session":"a1b2c3d4e5f6","role":"student","module":"notice","action":"parse","status":"ok","duration_ms":3.42,"error_code":null,"meta":{"input_len":128,"hit_rules":7,"confidence":88}}
```

- **调用频次**：按模块 / 动作 / 角色 / 自然日聚合，管理员后台实时可见。
- **耗时**：`duration_ms`，日报给平均值、P95 与峰值。
- **报错**：`status=error` + `error_code`，由真实失败请求产生。
- **脱敏**：不写通知原文、姓名、学号、题目、反馈正文、账号或密码；`meta` 只留长度、条数、命中规则数等可统计特征，并有字段名黑名单兜底；`session` 为不可逆哈希。
- **实时**：管理员后台的 SSE 流无需刷新，新请求落盘即推送。
- **每日同步**：`node scripts/daily-report.js --sync` 生成 `process_logs/summary-YYYY-MM-DD.md` 并自动 `git add process_logs/` + `commit`（业务数据按 `.gitignore` 不入库）。

> ⚠️ **诚实说明**：连续 7 天必须由你真实运行、真实使用来累计，程序不会（也不应该）补造历史日志。每天用一次、睡前跑一次 `--sync`，7 天后目录里自然就是 7 个日期文件。

### ② 基于日志的 ≥3 次 Git 迭代 Diff（20 分）

见下方「Git 迭代记录」。v1–v3 三次迭代都对应日志里能观察到的具体现象；v4 是按新的角色与实时观测需求做的结构性升级。可用 `git log --stat` / `git diff <commit> <commit>` 查看。

### ③ 完整源码 + 8 位真实用户反馈（15 分）

源码全部在本仓库。反馈通过工作台「使用反馈」表单收集，也可以线下用 [`docs/用户反馈表.md`](docs/用户反馈表.md) 的 8 份空白模板收集后录入。

> ⚠️ **诚实说明**：8 份反馈必须由 8 位真实同学试用后亲自填写，系统不生成任何虚构评价，`data/feedback.json` 初始为空。

---

## Git 迭代记录

### v1 · 基础可运行版
- 零依赖 HTTP 服务 + 静态资源 + 统一错误处理
- `telemetry` 自动脱敏日志、`store` JSON 原子存储
- `extractor` 中文通知规则引擎（绝对/相对日期、时间段、地点、对象、分类、截止、待办、ICS）
- 三大工具 API + 前端视图 + 冒烟测试 + 日报脚本

### v2 · 依据首日日志修复解析缺陷

**日志证据**：首日 25 次调用、3 次报错；三次 `notice/parse` 的 `confidence` 为 **88 / 88 / 63**，第三条 `hit_rules=5` 但 `warning_count=0` —— 规则引擎"自信地"漏掉了字段，属于静默失败。逐条复核后定位 6 个缺陷：地点吞时间数字、活动日被截止日抢占、`于…前` 截止未识别、`全体本科生` 未识别、标题硬截半句、分类被通用动词抢走。修复后三条示例置信度全部 **88**，并在 `meta` 新增 `missing_field_count` / `missing_keys` 让规则缺口可从日志直接观察。

### v3 · 依据耗时与报错数据优化

**日志证据**：写类请求 12–15ms vs 读类 <2ms，峰值 `bootstrap` 28.19ms；三类报错无法按错误码聚合。改动：请求级库存快照缓存（`reconcile_calls` 从 2 降到 ≤1）、`availableOf()` 单件库存校验、日报改异步 `execFile` 避免阻塞事件循环、`by_error_code` 聚合、`meta.reconcile_calls` 可观测指标；并修复总览待办不刷新、日志日期下拉跳回今天两处前端状态问题。冒烟测试 27/27 通过。

> 耗时实测：平均 `5.49ms (v1) → 5.03ms (v2) → 5.10ms (v3)`，`bootstrap` `28.19ms → 24.84ms`。**不夸大提速幅度** —— 数据量小的时候重复计算本身很便宜，这次改动的价值在于数据量增长后不再随流水线性放大。

### v4 · 登录体系、前后端拆分与实时日志

**需求驱动**：需要学生/教师入口、管理员后台实时观看运行日志，且明确要求「不添加任何数据」。

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | `scrypt` 加盐密码、Cookie 会话、角色权限、首次初始化由用户创建管理员、登录限流 | `lib/auth.js`（新增） |
| 2 | 路由层统一鉴权；学生数据按 `owner_id` 隔离；教师/管理员的管理动作单独授权；新增 `admin/*` 接口 | `lib/api.js` |
| 3 | SSE 实时日志流 + 断线轮询兜底 + 静态页面按真实文件名鉴权（防大小写/编码绕过） | `server.js` |
| 4 | telemetry 落盘后广播订阅者，日志新增 `role` 字段；日报增加按角色统计 | `lib/telemetry.js`、`scripts/daily-report.js` |
| 5 | 按 8px 间距、1.25 字阶、统一设计令牌重构三套界面；所有列表给出「由你录入」的空状态 | `public/style.css` |
| 6 | 登录/初始化页、学生教师工作台、管理员后台（实时控制台 / 日志分析 / 账号管理 / 数据总览） | `public/login.*`、`public/index.html`、`public/app.js`、`public/admin.*` |
| 7 | **移除全部预置数据**：删掉 `seedEquipment()` 与自动播种、清空已有器材种子数据（备份在 `.workbuddy/backups/`）、bootstrap 不再下发示例通知 | `lib/api.js`、`data/` |
| 8 | 冒烟测试重写为 50 项断言，覆盖鉴权、越权、零数据、SSE 推送、游标补齐、会话失效 | `scripts/smoke-test.js` |

**复测**：`node scripts/smoke-test.js` **50/50 通过**；三个页面共 135 个 DOM id 引用全部核对存在；未登录访问 `/index.html`、`/admin.html` 及其大小写变体均 302 到登录页，学生访问后台 302 到工作台。

### v4.0.1 · 依据真实运行现象修复多实例缓存一致性

**现场证据**：本机同时存在 5174 与 5175 两个服务进程；账号在 5175 创建并写入 `data/users.json`（2026-11-12 08:50，2 个账号），但 5174 进程从 11-11 启动后内存缓存未刷新，`/api/health` 一直返回 `initialized: false`，页面再次出现「创建管理员账号」。若在该页提交，旧进程的空数组会**覆盖已有账号文件**。

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | `store` 缓存改为带文件指纹（mtime + size + ino），读取时自动失效重读；`update` 写入前复核指纹，被其它进程改动则重读重试 | `lib/store.js` |
| 2 | 新增本机账号查看 / 密码重置命令行工具（无网页后门，权限依据是能读写 `data/`） | `scripts/reset-password.js` |
| 3 | 使用说明新增「在哪里查账号 / 密码为何查不到 / 忘记密码怎么办 / 重复出现初始化页怎么办」 | `docs/使用说明.md` |
| 4 | 停止重复实例，只保留一个服务；版本号升到 `v4.0.1` | `lib/telemetry.js`、`scripts/smoke-test.js` |

---

## 隐私与数据

| 位置 | 内容 | 是否提交 GitHub |
| --- | --- | --- |
| `data/*.json` | 业务数据（通知、器材、借还、错题、反馈、**账号与会话**） | **否**，`.gitignore` 已排除 |
| `process_logs/*.jsonl` | 脱敏运行日志 | 是，作业要求 |
| `process_logs/summary-*.md` | 每日自动汇总 | 是 |

账号密码以 **scrypt 加盐哈希** 保存在本机 `data/users.json`，会话只存 token 哈希；**密码不可逆，任何页面、日志和文件都查不到明文**。查看账号去后台「账号管理」，或本机执行 `node scripts/reset-password.js`；忘记密码只能重置，详见 `docs/使用说明.md` 第七节。业务数据只留在本机；填写借用人时建议用昵称或学号后四位，不要填真实姓名全名。

---

## 目录结构

```
server.js                HTTP 服务 / 静态鉴权 / SSE 实时流
lib/auth.js              账号、密码哈希、会话与角色权限
lib/telemetry.js         自动脱敏运行日志 + 订阅广播 + 聚合
lib/extractor.js         中文通知结构化引擎
lib/api.js               鉴权 / 业务接口 / 管理后台接口
lib/store.js             JSON 原子读写
public/login.html        登录 / 首次初始化
public/index.html        学生 / 教师工作台
public/admin.html        管理员实时日志后台
public/style.css         统一设计系统（8px 栅格 / 设计令牌）
public/{login,app,admin}.js
scripts/smoke-test.js    50 项冒烟测试（隔离数据目录）
scripts/daily-report.js  每日日志汇总 + 一键 git 同步
scripts/reset-password.js  本机账号查看 / 密码重置（无网页后门）
data/                    业务数据，全部由使用者录入
process_logs/            每日 telemetry + 日报
docs/使用说明.md         首次使用与日常操作步骤
docs/用户反馈表.md        8 份真实反馈空白模板
```

## 命令速查

| 目的 | 命令 |
| --- | --- |
| 启动网站 | `node server.js` |
| 指定端口 | `PORT=8080 node server.js` |
| 跑接口测试 | `node scripts/smoke-test.js` |
| 列出已注册账号 | `node scripts/reset-password.js` |
| 重置某账号密码 | `node scripts/reset-password.js --reset 账号` |
| 生成今日日报 | `node scripts/daily-report.js` |
| 生成日报并提交 | `node scripts/daily-report.js --sync` |
| 查看迭代 diff | `git log --stat`、`git diff HEAD~2 HEAD` |
| 统计日志天数 | `ls process_logs/*.jsonl \| wc -l` |
