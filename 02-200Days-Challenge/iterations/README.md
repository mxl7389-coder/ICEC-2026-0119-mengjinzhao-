# 迭代 Diff 记录 · 项目四评分点 ②

> 作业要求：**基于日志的至少 3 次 Git 迭代 Diff 记录**。
> 本目录提供 **5 次**真实迭代，全部从本仓库 `git log` 直接导出（`git show --format=fuller <commit>`），未做任何修饰或补造。
> 每次迭代都注明：依据哪一天的真实 telemetry、发现了什么问题、改了什么、复测结果。

## 索引

| 序号 | 提交 | 日期 | 版本 | 日志依据 | 核心问题 | Diff 文件 | 复测 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | `fc3600f` | 2026-11-11 | v2 | 首日 `2026-11-11.jsonl` | 通知解析 6 处缺陷，置信度最低 63%，且存在静默失败 | [`01-v2-extractor-telemetry.diff`](01-v2-extractor-telemetry.diff) | 三条样例置信度全部 88 |
| 02 | `4da552d` | 2026-11-11 | v3 | 首日耗时与报错聚合 | 写请求 12–15ms、bootstrap 峰值 28.19ms，3 类报错无法聚合 | [`02-v3-performance-telemetry.diff`](02-v3-performance-telemetry.diff) | 冒烟测试 27/27 |
| 03 | `2710c1f` | 2026-11-13 | v4.0.1 | 11-13 运行日志 `initialized:false` | 5174/5175 双实例内存缓存未刷新，可能覆盖已注册账号 | [`03-v4.0.1-cache-consistency.diff`](03-v4.0.1-cache-consistency.diff) | 跨进程缓存一致性专项验证通过 |
| 04 | `bc3c68f` | 2026-11-17 | v6.1 | 累计 739 次调用 / 102 次错误的只读体检 | 测试日志混进真实 telemetry、连续天数按「累计」误判、日报口径失真 | [`04-v6.1-log-integrity.diff`](04-v6.1-log-integrity.diff) | 115/115，主日志零污染 |
| 05 | `666f8e3` | 2026-11-17 | v6.2 | P0 代码体检 + 隔离环境崩溃复现 | 畸形 URL 未登录即可打挂进程、通知主键可伪造、借用归还越权 | [`05-v6.2-lan-assistant.diff`](05-v6.2-lan-assistant.diff) | 129/129 |

另有一次 `972865d`（2026-11-18，启动参数跨终端兼容）为第 6 次迭代，依据用户真实报错截图，可用 `git show 972865d` 查看。

## 逐次说明

### 01 · v2：依据首日 telemetry 修复通知解析

`process_logs/2026-11-11.jsonl` 显示置信度最低仅 63%，且部分请求静默失败。逐条对照原文后定位 6 处缺陷：日期排序错误、地点正则误吞时间数字、面向对象（全体本科生）未识别、标题切分不准、分类关键词未加权、截止日期漏识别。改动集中在 `lib/extractor.js`，并新增 `missing_field_count` / `missing_keys` 指标写入 telemetry，使后续日志能直接量化解析质量。

### 02 · v3：依据耗时与报错日志做结构性优化

日志显示写请求 12–15ms、读请求 <2ms、bootstrap 峰值 28.19ms，且 3 类错误码难以聚合。改动：`server.js` 拆分 `handle/route` 耗时口径；请求级 `reconcile()` 快照缓存；`availableOf()` 单件库存校验；`logs/report` 改异步 `execFile` 避免阻塞事件循环；telemetry / 日报 / 日志页新增 `by_error_code` 聚合。同时修复总览待办不刷新、日志日期下拉跳回今天两处前端状态问题。

### 03 · v4.0.1：修复多实例缓存覆盖账号的风险

11-13 日志出现 `initialized:false`，排查发现 5174 与 5175 两个服务实例并存，旧进程内存缓存未刷新，写入时可能覆盖已有 2 个账号。`lib/store.js` 的缓存改为带 `mtimeMs:size:ino` 文件指纹，`update()` 写入前复核指纹并在不一致时重读重试；新增 `scripts/reset-password.js` 本机账号查看与密码重置工具。

### 04 · v6.1：验收数据可信度修复

只读体检发现真实 `process_logs/` 累计 739 次调用、102 次错误（13.8%），其中 `FORBIDDEN` / `BAD_CREDENTIALS` / `PORTAL_MISMATCH` 多为冒烟测试故意触发；同时连续天数按「累计」而非「连续」计算，误报达标。改动：telemetry 增加 `source` 字段与 `CAMPUSDESK_LOG_DIR` / `CAMPUSDESK_LOG_SOURCE`；冒烟测试写入独立日志目录并跑完即删；`streakInfo()` 按当前连续天数判定并列出断档；日报标注 `live` / `legacy` / `smoke` 口径。同批补齐 SRS 的 5 种导入、查重、版本追踪、审计与备份。

### 05 · v6.2：上线前置安全加固 + 局域网 + 本地离线助手

隔离环境实测：`/api/health/%E0%A4%A` 一个畸形 URL 即可让进程以 `URIError` 退出（无需登录）；学生可用相同 id 串改他人通知、`loan.return` 缺归属校验。改动：URL / Cookie 解码移入 try 并加 `unhandledRejection` 兜底、5xx 不外泄内部路径、通知主键改服务端生成、补 `assertOwner`、看板日期字段转义、轮询游标不再跳过 200 条；同时新增 `LAN` 模式与 `lib/assistant.js` 本地离线问答。

## 如何核验

```bash
git log --oneline                  # 查看全部 14 次提交
git show fc3600f                   # 与本目录 01 号 diff 逐行比对
git diff 666f8e3 972865d --stat    # 查看任意两次迭代之间的变化
```

> 这些 Diff 记录的是**当时真实发生的代码变化**，不是事后补写的说明。日志原文保留在 `process_logs/`，可逐日复核。
