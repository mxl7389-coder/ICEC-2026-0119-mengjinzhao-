# ICEC-2026-0119-mengjinzhao-

## 个人信息与任务概览

| 项目 | 内容 |
| --- | --- |
| 姓名 | 孟锦朝 |
| 学号后四位 | 0119 |
| 第一阶段 | 课题 09、课题 10 |
| 第二阶段 | 项目四：解决校园真实痛点的轻量化实用程序研发与日常运行日志验证 |
| 作品 | CampusDesk 校园事务台 |

## 标准目录

```text
ICEC-2026-0119-mengjinzhao-/
├── README.md
├── 01-Field-Discovery/
├── 02-200Days-Challenge/
└── 03-AI-Collaboration/
```

## 第一阶段：课题 09 与课题 10

| 课题 | 内容 | 入口 |
| --- | --- | --- |
| 09 | 多模态大模型校园复杂视觉盲区实测：15 张校园实景图、模型 A/B 评分、偏差总结与改进方法 | [`01-Field-Discovery/课题09-多模态大模型校园复杂视觉盲区实测/`](01-Field-Discovery/课题09-多模态大模型校园复杂视觉盲区实测/README.md) |
| 10 | 日常数字任务耗时审计与 AI 批处理实证：10 个签到/成绩样本、AI 脚本、Prompt、耗时对比和人机校验规则 | [`01-Field-Discovery/课题10-日常数字任务耗时审计与AI批处理实证/`](01-Field-Discovery/课题10-日常数字任务耗时审计与AI批处理实证/README.md) |

## 第二阶段：CampusDesk

阶段二内容统一放在 [`02-200Days-Challenge/`](02-200Days-Challenge/README.md)：

- 完整源码：原生 Node.js + HTML/CSS/JavaScript，零第三方依赖；
- `process_logs/`：按自然日保存的脱敏运行日志；
- `iterations/`：5 份基于日志的 Git 迭代 Diff；
- `user-feedback/`：8 位真实使用者的反馈数据与分析；
- 软件需求、系统架构、数据库设计、测试报告和使用说明。

## AI 协作记录

[`03-AI-Collaboration/`](03-AI-Collaboration/README.md) 只保留脱敏后的关键问题、排查结论、代码改动和人工核验结果，不保存个人 AI 会话原文，也不记录所使用的模型标识。

## 快速运行

```powershell
cd 02-200Days-Challenge
node server.js
```

浏览器打开终端打印的本机地址。局域网模式：

```powershell
node server.js --lan
```

运行测试：

```powershell
node scripts/smoke-test.js
```

## 数据与隐私

- `data/` 只保存在本机，不进入公开仓库；
- 密码以 scrypt 加盐哈希保存，密码哈希、会话令牌和业务原文不上传；
- 运行日志不记录通知原文、姓名、学号、题目、反馈正文或密码；
- 公开的反馈数据只保留评分、模块、问题、评价和改进建议。
