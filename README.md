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
{"ts":"2026-11-11T09:12:33.123Z","day":"2026-11-11","app_version":"v1.0.0","session":"a1b2c3d4e5f6","module":"notice","action":"parse","status":"ok","duration_ms":3.42,"error_code":null,"meta":{"input_len":128,"hit_rules":7,"confidence":88,"parse_ms":1.1,"warning_count":0}}
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
> 首日 `notice/parse` 日志显示：`confidence` 最低仅 63、`hit_rules` 偏低，且地点字段把时间数字一起吞进去了。逐条复核后修复（详见该次 commit diff）。

### v3 · 依据耗时与报错数据优化
> 详见该次 commit diff 与 commit message。

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
