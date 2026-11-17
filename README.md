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

## v5：三套独立入口 + 中国书院动态封面

用户端与管理端是**两套完全独立的入口**，各有自己的登录页、界面配色与导航；登录后互不跳转，界面上也不出现对方入口。服务端对入口再做一次角色校验，跨端登录会被拒绝（`PORTAL_MISMATCH`）。

| 入口 | 使用者 | 内容 |
| --- | --- | --- |
| `/` | 所有人 | **动态封面**：宣纸纹理、水墨远山、晨光、飘落银杏、朱红印章、竖排题字，两个独立入口卡片 |
| `/user/` | 学生 / 教师 | 独立登录页 + 总览、通知提取、器材借还、错题归档、使用反馈、项目说明（浅色书院风） |
| `/admin/` | 管理员 | 独立登录页 + **首次创建管理员** + SSE 实时运行日志、日志分析、账号管理、数据总览（深墨蓝控制台） |

- 封面与两端登录页为纯 CSS + 内联 SVG 动画，无外部图片、字体或 CDN；支持 `prefers-reduced-motion` 与手机端断点。
- 旧链接 `/login.html` `/index.html` `/admin.html` 会 302 到新入口，不会出现两套 URL 并存。
- HTML 必须经服务端 `resolvePage()` 鉴权后才下发；静态资源走白名单，大小写变体无法绕过页面级检查。

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
- **入口隔离**：登录请求带 `portal=user|admin`；管理员账号不能从用户端登录，学生/教师账号不能从管理端登录，首位管理员只能在管理端创建。校验放在密码验证通过之后，避免未认证请求枚举账号角色（`portal` 可选，脚本与旧调用保持兼容）。

### ⚠️ 零预置数据

**程序不添加任何数据，一切由你和使用者录入。**

- 不预置账号：第一位管理员必须你自己在首次打开时创建；其余账号由管理员在后台创建。
- 不预置器材、通知、错题、样例文本或反馈：`data/*.json` 初始全部为 `[]`，界面显示明确的空状态与下一步指引。
- `lib/api.js` 中已彻底移除 `seedEquipment()` 与自动播种逻辑；`bootstrap` 不再下发示例通知。
- `process_logs/` 里的日志是**程序自动采集的运行痕迹**（每次真实请求一行），不是业务数据，也不是补造的历史记录。
- 冒烟测试只在 `data/__smoke__/`（业务数据）与 `process_logs/__smoke__/`（运行日志）两个隔离目录里造测试账号、记录与调用日志，跑完即删除，不会污染日常数据或真实 telemetry。

---

## 快速开始

```bash
node server.js
# 浏览器打开 http://localhost:5173/
# 封面 → 用户端 /user/ ｜ 管理端 /admin/
```

默认端口 5173；若被本机其它服务占用，会自动顺延到 5174、5175……以终端实际打印的地址为准。也可显式指定：`PORT=8080 node server.js`。

**第一次打开**：封面页 → 点「管理员 · 进入管理后台」→ 管理端登录页显示「创建管理员账号」，填好显示名称、账号、密码后自动进入后台 → 在「账号管理」里创建学生 / 教师账号 → 把账号密码线下告知本人 → 使用者从 `/user/` 登录后自行录入数据。**系统当前账号已按你的要求清空，正处于这个「重新注册」状态。**

```bash
node scripts/smoke-test.js     # 独立端口 5199 + 隔离数据目录 + 隔离日志目录，115 项断言
node scripts/daily-report.js --sync   # 生成当日日报并自动 git commit（不 push）
git push                      # 需要提交到 GitHub 时再执行
```

更详细的操作步骤见 [`docs/使用说明.md`](docs/使用说明.md)。

---

## 对应作业的评分点

### ① 连续 ≥7 天自动化运行日志（25 分）

每次页面加载与接口调用结束时，由 `lib/telemetry.js` **自动**写一行 JSONL 到 `process_logs/YYYY-MM-DD.jsonl`：

```json
{"ts":"2026-11-11T09:12:33.123Z","day":"2026-11-11","app_version":"v6.1.0","source":"live","session":"a1b2c3d4e5f6","role":"student","module":"notice","action":"parse","status":"ok","duration_ms":3.42,"error_code":null,"meta":{"input_len":128,"hit_rules":7,"confidence":88}}
```

- **调用频次**：按模块 / 动作 / 角色 / 自然日聚合，管理员后台实时可见。
- **耗时**：`duration_ms`，日报给平均值、P95 与峰值。
- **报错**：`status=error` + `error_code`，由真实失败请求产生。
- **脱敏**：不写通知原文、姓名、学号、题目、反馈正文、账号或密码；`meta` 只留长度、条数、命中规则数等可统计特征，并有字段名黑名单兜底；`session` 为不可逆哈希。
- **实时**：管理员后台的 SSE 流无需刷新，新请求落盘即推送。
- **每日同步**：`node scripts/daily-report.js --sync` 生成 `process_logs/summary-YYYY-MM-DD.md` 并自动 `git add process_logs/` + `commit`（业务数据按 `.gitignore` 不入库）。
- **连续天数自检**：日报新增「连续运行达标自检」章节，按**当前连续天数**（不是累计天数）判定，列出断档明细、历史最长连续和达标日期；系统健康页、总览看板同步显示。
- **来源隔离（v6.1）**：日志新增 `source` 字段；冒烟测试通过 `CAMPUSDESK_LOG_DIR` 写入 `process_logs/__smoke__/`，跑完即删，**不再把测试调用与故意触发的报错混进真实日志**。v6.1 之前的历史记录无该字段，日报标为 `legacy` 并说明其错误率含测试噪声。

> ⚠️ **诚实说明**：连续 7 天必须由你真实运行、真实使用来累计，程序不会（也不应该）补造历史日志。**当前实际状态：累计 5 天（11-11、12、13、16、17），11-14/15 断档，当前连续仅 2 天**；从 11-16 起需连续使用到 **11-22** 才达标。每天用一次、睡前跑一次 `--sync`。

### ② 基于日志的 ≥3 次 Git 迭代 Diff（20 分）

见下方「Git 迭代记录」。v1–v3 三次迭代都对应日志里能观察到的具体现象；v4 是按新的角色与实时观测需求做的结构性升级。可用 `git log --stat` / `git diff <commit> <commit>` 查看。

### ③ 完整源码 + 8 位真实用户反馈（15 分）

源码全部在本仓库。反馈通过工作台「使用反馈」表单收集（v6.1 起字段与 8 份问卷完全对齐：实际完成的任务、评分、最有帮助的地方、遇到的问题、建议、是否愿意再用），管理端「反馈收集」页显示 `已收 N/8` 槽位与明细；也可以线下用 [`docs/用户反馈表.md`](docs/用户反馈表.md) 的 8 份空白模板收集后录入。**当前已收集 0 份。**

> ⚠️ **诚实说明**：8 份反馈必须由 8 位真实同学试用后亲自填写，系统不生成任何虚构评价，`data/feedback.json` 初始为空。

---

## Git 迭代记录

> 以下各章节中出现的「50 / 73 / 89 项断言」及 `v4.0.1` / `v5` / `v6.0.0` 等版本号，均为**当时版本的历史记录**，保留原样便于对照 `git diff`；当前版本为 **v6.1.0**，冒烟测试为 **115/115 通过**。

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

### v5 · 三套独立入口 + 中国书院 × 校园文化动态封面

**需求驱动**：① 清空已注册账号、重新注册；② 把「管理员」与「用户」彻底分成两套独立系统；③ 界面太简单，按校园文化做动态封面。

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | **清空账号**：备份原有 2 个账号到 `.workbuddy/backups/accounts-before-reset-2026-11-16/`，`users.json` / `sessions.json` 归零，系统回到「由使用者重新创建管理员」状态；业务数据原本全为 0，未改动、未新增 | `data/` |
| 2 | 目录物理拆分：`public/user/`（独立登录页 + 工作台）与 `public/admin/`（独立登录页 + 后台）；删除共用的旧登录页，前端去掉全部跨端链接与跳转 | `public/user/*`、`public/admin/*` |
| 3 | `server.js` 重写页面路由：`/` 封面、`/user/`、`/admin/` 三套入口，按目录鉴权；HTML 必须经 `resolvePage()`，静态资源白名单；旧链接 302 兼容 | `server.js` |
| 4 | 登录请求增加可选 `portal`，服务端校验账号角色与入口匹配；首次初始化只能在管理端完成 | `lib/auth.js` |
| 5 | 新增动态封面：宣纸纹理 / 水墨远山 / 晨光 / 飞鸟 / 8 片飘落银杏 / 竖排题字 / 朱红印章 / 两个独立入口卡片，纯 CSS + 内联 SVG 动画 | `public/cover.html`、`public/portal.css`、`public/portal.js` |
| 6 | 两端独立登录页：用户端浅色书院风、管理端深墨蓝控制台 + 流动日志装饰；管理端独占「创建管理员账号」 | `public/user/login.html`、`public/admin/login.html` |
| 7 | 工作台与后台补书院气质装饰层（顶栏金线、卡片标题朱红竖标、侧栏楷体院训、墨青 hero） | `public/style.css` |
| 8 | 冒烟测试扩到 **73 项**，新增三套入口可访问性、两端互不出现对方入口、大小写绕过、跨端页面越权、旧链接兼容、门户角色约束等断言 | `scripts/smoke-test.js` |

**复测**：`node scripts/smoke-test.js` **73/73 通过**；12 个 JS 语法检查通过；`PORTAL_MISMATCH` 已进入真实日志的错误码聚合。

### v6 · 按 SRS 重构双端信息架构 + 企业级设计系统

**需求驱动**：登录 / 封面已优化，但学生教师端与管理员端仍偏简单；以《CampusMate 项目需求规格说明书 V1.0》的功能域为蓝图重构界面。原则是**只做真实可验证的能力**，SRS 中尚未实现的部分在「功能地图」里如实标注「规划中」，不提供空壳按钮。

| # | 改动 | 文件 |
| --- | --- | --- |
| 1 | 解析引擎补齐 CM-FR-102/104 的发布单位、联系方式 / 咨询、所需材料、重要程度；保持原有 8 项命中规则与置信度口径不变，历史 telemetry 仍可比 | `lib/extractor.js` |
| 2 | 新增 `/api/activity`（只返回当前会话的脱敏操作摘要）、`/api/admin/export`（JSON / CSV 真实下载）；`health` / `overview` 增加真实内存读数、6 项健康检查、日报文件清单与 `git log` 提交记录；聚合新增 `by_role` | `lib/api.js`、`lib/telemetry.js` |
| 3 | 器材档案补齐 CM-FR-201 的编号、型号、存放位置、购买日期、备注并真实落库 | `lib/api.js` |
| 4 | **用户端**：导航按 SRS 功能域分 4 组；总览扩为 CM-FR-001 的 7 项指标 + 系统状态条 + 最近操作时间线；通知改「导入 → 提取 → 人工审核 → 生成待办」四步（可修改标题 / 截止、必须勾选确认、可拒绝）；新增通知检索、知识点掌握率、智能助手（能力边界）、我的足迹、SRS 功能地图 | `public/user/index.html`、`public/user/app.js` |
| 5 | **管理端**：导航分为运行监控 / 系统管理 / 版本三组；新增系统健康、备份与导出、角色权限矩阵、按动作 / 角色聚合、版本迭代时间线（实时 `git log`）、管理员职责与 SRS 对照 | `public/admin/index.html`、`public/admin/admin.js` |
| 6 | 企业级设计令牌落地：面包屑 + eyebrow 页面头、卡片副标题、四态提示条、流程步骤、审核区、表格数值右对齐 / 操作列、统一空状态、实现状态标签、健康检查清单、时间线组件；深色控制台克制化 | `public/style.css`（v6 章节） |
| 7 | 冒烟测试扩到 **89 项**，新增 16 项覆盖 SRS 新字段、七项指标、足迹隔离、档案落库、健康检查、JSON/CSV 导出与下载头、按角色聚合、两端新视图 | `scripts/smoke-test.js` |

**复测**：`node scripts/smoke-test.js` **89/89 通过**；12 个 JS 语法检查通过；用户端 89 / 管理端 65 个静态 DOM 引用全部核对存在（3 个 `review-*` 为审核区动态生成）。日志 `app_version` 升到 `v6.0.0`。

> **与 SRS 的差异（如实说明）**：SRS 第 7 章规划 React + Electron 桌面客户端、Python FastAPI + SQLite、Ollama 本地模型与本地 OCR。当前交付是第一阶段可运行的零依赖 Node 本地 Web 版，保留前后端分离、模块化、统一数据访问、自动 Telemetry 与 Git 迭代约束；迁移 SQLite 只需替换 `lib/store.js`。PDF / Word / 图片导入、OCR、RAG 问答、二维码、盘点、异常登记、AI 模型管理仍在「功能地图」标注为规划中；**操作审计已于 v6.1 落地**。

### v6.1 · 验收数据可信度修复 + SRS 功能补齐

**起因**：一次只读体检发现四个会影响评分的问题 —— 日志 11-14/15 断档、无 GitHub 远端、8 位反馈 0 份、**冒烟测试日志混进真实 `process_logs/`**（累计 739 次调用中 102 次 error 多为测试故意触发）。本轮只解决能用代码解决的部分。

| 改动 | 文件 | 真实效果 |
| --- | --- | --- |
| 测试日志隔离 + `source` 字段 | `lib/telemetry.js`、`scripts/smoke-test.js` | 测试写 `process_logs/__smoke__/` 并跑完删除；断言「全程未向真实日志写入 smoke 记录」通过，主日志行数测试前后不变 |
| 连续天数自检 | `lib/telemetry.js` `streakInfo()`、`scripts/daily-report.js` | 日报列出当前连续 / 历史最长 / 断档明细 / 达标日期；系统健康页按连续而非累计判定；日报标注「生成时刻 + 截至行数」，说明是静态快照 |
| CM-FR-101 五种导入 | `public/user/index.html`、`app.js` | 手动粘贴 + `.txt` / `.md` / `.csv` / `.json`，浏览器 FileReader 本地解析、可拖放、不需要任何库；PDF/Word/图片仍如实标规划中 |
| CM-FR-109 / 110 / 107 | `lib/api.js`、用户端 | 3-gram Jaccard 查重（只给相似度，不泄露他人原文）、版本快照与字段差异「先预览再确认」、自定义提前提醒写入 `.ics` 的 `VALARM` |
| 反馈与收集进度 | 用户端 / 管理端 / `lib/api.js` | 表单对齐 8 份问卷字段；任何登录用户可见 `已收 N/8`，管理端「反馈收集」页含 8 槽位与明细 |
| CM-FR-210 审计 + 备份 | `lib/store.js`、`lib/api.js`、管理端 | 新增空的 `audit` 数据集，写操作自动留脱敏痕迹；业务快照导出带 SHA256，可校验、可显式确认后恢复（不动账号与会话） |
| 安全加固 | `server.js` | CSP 脚本白名单、`Referrer-Policy: same-origin`、`nosniff`；写请求校验 `Origin`/`Referer` 同源，跨站提交返回 `CSRF_ORIGIN_MISMATCH`（本地场景不启用 frame 限制，避免破坏预览面板） |
| 交付物对照 | `docs/交付物对照.md` | SRS 第 10 章交付清单逐项状态、验收指标对照、架构说明与 JSON→SQLite 表映射 |

**复测**：`node scripts/smoke-test.js` **115/115 通过**（新增 26 项），12 个 JS 语法检查通过，用户端 100 / 管理端 82 个 DOM 引用核对（4 个 `review-*` 为审核区动态生成）。版本 `v6.1.0`。**未做**：SQLite 迁移（会引入依赖、破坏零依赖即跑，建议阶段验收后再动）、GitHub 远端（需要你的账号，见下方）。

---

## 推送到 GitHub（需要你本人操作）

目前 10+ 个提交都在本地 `master`，`git remote -v` 为空，**作业要求的 GitHub 过程数据还交不出来**。步骤：

```bash
# 1. 在 GitHub 网页新建一个空仓库（不要勾选 README/license，避免冲突），复制其 URL
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git branch -M main                 # 可选，GitHub 默认分支名
git push -u origin main           # 或 master
# 2. 之后每天同步
node scripts/daily-report.js --sync && git push
```

`.gitignore` 已排除 `data/`（账号、密码哈希与业务数据都不会上传）；提交的是源码、README、文档与 `process_logs/`。若启用双重认证，请用 Personal Access Token 代替密码。

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
public/cover.html        中国书院 × 校园文化动态封面（/ 总入口）
public/portal.css        封面与两端登录页视觉 / 全部动画
public/portal.js         封面状态与两端登录、初始化逻辑
public/user/login.html   用户端独立登录页（浅色书院风）
public/user/index.html   学生 / 教师工作台
public/user/app.js       用户端交互
public/admin/login.html  管理端独立登录页（深墨蓝）+ 首次初始化
public/admin/index.html  管理员实时日志后台
public/admin/admin.js    管理端交互
public/style.css         工作台 / 后台设计系统 + 书院气质装饰层
scripts/smoke-test.js    115 项冒烟测试（隔离数据目录 + 隔离日志目录）
scripts/daily-report.js  每日日志汇总 + 连续天数自检 + 一键 git 同步
scripts/reset-password.js  本机账号查看 / 密码重置（无网页后门）
data/                    业务数据 + 空的审计数据集，全部由使用者录入
process_logs/            每日 telemetry + 日报（测试日志在 __smoke__/，跑完即删）
docs/使用说明.md         首次使用与日常操作步骤
docs/交付物对照.md        SRS 交付物清单 / 验收指标 / 架构与数据映射
docs/用户反馈表.md        8 份真实反馈空白模板
```

## 命令速查

| 目的 | 命令 |
| --- | --- |
| 启动网站 | `node server.js` |
| 指定端口 | `PORT=8080 node server.js` |
| 跑接口测试（不污染真实日志） | `node scripts/smoke-test.js` |
| 列出已注册账号 | `node scripts/reset-password.js` |
| 重置某账号密码 | `node scripts/reset-password.js --reset 账号` |
| 生成今日日报 | `node scripts/daily-report.js` |
| 生成日报并提交 | `node scripts/daily-report.js --sync` |
| 查看迭代 diff | `git log --stat`、`git diff HEAD~2 HEAD` |
| 统计日志天数 | `ls process_logs/*.jsonl \| wc -l` |
