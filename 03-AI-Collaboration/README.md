# 关键 AI 提问与排障记录（AI Collaboration）

> 课程建议目录：关键 AI 提问排障对话记录。
> **提交顺序**：本目录是课程目录第 ④ 项，排在 `01-Field-Discovery/` 的两个课题与 `02-200Days-Challenge/` 的校园事务台**之后**，是全仓库最后一部分。
> 本目录现有四份材料：`README.md`（下表，快速排障摘要）、[`AI协作过程与人工核验记录.md`](AI协作过程与人工核验记录.md)（协作定位、迭代复盘、提示策略、人工核验清单）、[`chat-export.md`](chat-export.md)（**真实逐字对话导出**）与 [`scripts/export-dialogue.js`](scripts/export-dialogue.js)（可复现的导出脚本）。
> 下表是**开发过程中真实发生**的关键问题与处理结论摘要，按时间排列，便于快速查阅；**逐字原文**请看 [`chat-export.md`](chat-export.md)，机器可读的轮次与事件统计见 [`对话统计.json`](对话统计.json)。

| 日期 | 关键提问 / 现象 | 排查结论 | 落地改动 |
| --- | --- | --- | --- |
| 11-11 | 首日通知解析置信度只有 63%，还出现静默失败 | 逐条比对原文，定位日期排序、地点正则、对象识别、标题切分、分类加权、截止识别 6 处缺陷 | `lib/extractor.js` 重写，`git show fc3600f` |
| 11-11 | 写请求 12–15ms、bootstrap 峰值 28.19ms，报错无法聚合 | 请求内重复计算库存、日志报表同步阻塞事件循环、缺错误码维度 | `reconcile()` 快照缓存、异步 `execFile`、`by_error_code`，`git show 4da552d` |
| 11-13 | 后台显示 `initialized:false`，担心账号被覆盖 | 5174 与 5175 两个实例并存，进程内缓存未感知外部写入 | 文件指纹缓存 + 写入前复核重试，`git show 2710c1f` |
| 11-16 | 想查已注册账号的密码 | scrypt 加盐哈希不可逆，密码只能重置不能查询 | 新增 `scripts/reset-password.js`；后台「账号管理」可查账号 |
| 11-17 | 连续 7 天日志是否达标？错误率 13.8% 是否正常？ | 累计 8 个日期但最长连续仅 3 天；多数报错来自冒烟测试故意触发 | 日志 `source` 标记 + 隔离测试日志 + `streakInfo()`，`git show bc3c68f` |
| 11-17 | 一个畸形 URL 会不会打挂服务？ | 隔离环境实测 `/api/health/%E0%A4%A` 触发 `URIError` 进程退出，无需登录 | 解码移入 try + 全局 rejection 兜底，`git show 666f8e3` |
| 11-18 | PowerShell 执行 `LAN=1 node server.js` 报「无法识别为 cmdlet」 | 该写法是 Bash 系语法，Windows 终端把 `LAN=1` 当命令名；服务端无故障 | 新增 `--lan` / `--port` / `--help` 跨终端参数，`git show 972865d` |
| 11-22 | 过程数据如何按课程目录组织 | 按 `01-Field-Discovery/` → `02-200Days-Challenge/` → `03-AI-Collaboration/` 归档 | 三个标准目录 + 5 份迭代 Diff + 交付清单 |

## 逐字对话导出

[`chat-export.md`](chat-export.md) 由 [`scripts/export-dialogue.js`](scripts/export-dialogue.js) 从本机真实会话记录逐条解析生成：

- 只保留恰含一个 `<user_query>` 的真人提问原文，AI 回答取 `output_text` 可见文字，逐字不润色；
- 宿主注入的运行上下文、压缩摘要、自动继续指令、工具调用与系统提示不进正文；
- 后台任务失败通知与网络恢复事件另存为文末「真实运行事件时间线」，不丢弃证据；
- 令牌/密钥脱敏，图片附件只留文件名；导出信息里附源文件 SHA256 供核对。

复现：

```bash
cd E:\校园软件
node 03-AI-Collaboration/scripts/export-dialogue.js "<本机会话记录.jsonl>"
```

## 使用原则

- AI 只用于**定位问题、解释原因、给出改法**；所有代码改动都经过本地 `scripts/smoke-test.js` 回归验证后才提交。
- 所有功能状态以代码为准，AI 不替程序承诺超出实现范围的能力。
- 运行日志、用户反馈、账号与业务数据一律由真实运行 / 真实用户产生。
