# GitHub 建仓与推送 · 本人操作指南

> 目标：创建一个**所有者是你本人**的公开仓库，把本机的完整源码、真实运行日志与迭代 Diff 上传，形成可核验的过程数据。
> 对应课程「Step 0：GitHub 建仓与 Git 极简指南」与项目四「必交 GitHub 过程数据」。

## 一、在 GitHub 网页建空仓库（只能你本人做）

1. 登录 **你自己的** GitHub 账号 → 右上角 `+` → `New repository`。
2. 填写：
   - **Repository name**：`ICEC-2026-0119-mengjinzhao-`（**本人实际创建的仓库名**）
     （课程模板格式写作 `ITEC-2026-学号后四位-姓名拼音`；实际仓库以已创建地址为准，注意首字母与末尾连字符）
   - **Description**（可选）：`项目四 · 校园事务台 CampusDesk · 轻量化实用程序与真实运行日志验证`
   - **Public**（公开，过程数据需要可核验）
   - **不要**勾选 `Add a README file`、`.gitignore`、`Choose a license` —— 本地已有 15+ 次提交，勾选会造成首次推送冲突。
3. 点 `Create repository`，复制页面上的仓库地址：
   `https://github.com/mxl7389-coder/ICEC-2026-0119-mengjinzhao-.git`。

> 仓库所有者显示为你的账号，即满足「仓库属于我自己」。系统不会用任何第三方账号代替你创建。

## 二、把地址交给本机仓库并推送

```bash
git remote add origin https://github.com/mxl7389-coder/ICEC-2026-0119-mengjinzhao-.git
git remote -v                       # 核对地址
git status                          # 应显示 working tree clean
git log --oneline                   # 查看提交历史，当前分支 main
git push -u origin main
```

首次推送若弹出 **Git Credential Manager** 登录窗口，用**你自己的 GitHub 账号**登录即可；开启双重认证时，密码位置需填 **Personal Access Token**（GitHub → Settings → Developer settings → Personal access tokens，勾选 `repo` 权限）。本机已配置 `credential.helper=manager`，登录一次后会缓存在 Windows 凭据管理器中。

> 也可以只把仓库地址发给我，由我配置 `remote` 并给出最终网址；若登录弹窗需要在你的桌面完成，`git push -u origin main` 这一行由你执行即可。

## 三、课程 6 条核心命令对照

| 课程命令 | 本项目中的用法 |
| --- | --- |
| `git clone <仓库地址>` | 在另一台电脑取副本：`git clone https://github.com/mxl7389-coder/ICEC-2026-0119-mengjinzhao-.git` |
| `git status` | 查看当日新增的 `process_logs/` 与文档改动 |
| `git add .` | 暂存过程数据（本项目由 `daily-report.js --sync` 自动完成） |
| `git commit -m "实测日志"` | 每次同步自动生成一条含日报的提交，可用 `git log --oneline` 查看 |
| `git push origin main` | 同步到云端；分支已由 `master` 统一为 `main` |
| `git log --oneline` | 核验提交历史与迭代时间线 |

## 四、每日同步（连续 7 天日志靠这个累积）

```bash
node scripts/daily-report.js --sync && git push origin main
```

`--sync` 会生成当日 `process_logs/summary-YYYY-MM-DD.md` 并自动 `git commit`（不 push），再执行 `git push origin main` 上传。**每天要真实打开网站用一次功能**，服务才会写入当天的 telemetry；服务空转无人访问不会产生日志。

程序按「当前连续天数」判定达标（`lib/telemetry.js` 的 `streakInfo()`），累计天数不算数。当前状态见 [`仓库交付自查.md`](仓库交付自查.md)。

## 五、常见问题

| 现象 | 原因与处理 |
| --- | --- |
| `remote origin already exists` | 已配置过：`git remote set-url origin <新地址>` |
| 推送被拒绝 `non-fast-forward` | 建仓时误勾了 README。执行 `git pull origin main --rebase` 后再 `git push -u origin main` |
| 认证失败 | 用 Personal Access Token 代替密码；或先在终端执行一次 `git push` 完成浏览器登录 |
| 担心上传了账号密码 | `.gitignore` 已排除 `data/`，`users.json` / `sessions.json` 不进仓库；可用 `git ls-files data/` 确认（应无输出） |
| 仓库改名后推送失败 | `git remote set-url origin <新地址>` 即可，本地提交历史不受影响 |

## 六、上传内容清单

| 内容 | 路径 | 是否上传 |
| --- | --- | --- |
| 完整源码 | `server.js`、`lib/`、`public/`、`scripts/` | 是 |
| 运行日志 Telemetry | `process_logs/*.jsonl`、`summary-*.md` | 是（作业要求） |
| 迭代 Diff | `02-200Days-Challenge/iterations/*.diff` | 是（评分点 ②） |
| 标准目录与说明 | `01-Field-Discovery/`、`02-200Days-Challenge/`、`03-AI-Collaboration/` | 是 |
| 文档 | `README.md`、`docs/` | 是 |
| 账号 / 会话 / 业务数据 | `data/*.json` | **否**（隐私） |

## 七、诚实边界（重要）

- 当前**连续运行未达标**：累计 9 个日期、858 行日志，但最长连续只有 5 天（11-16→11-20），断档 2 处，需连续用到 **2026-11-28**。仓库里不会补写历史日期。
- **8 位真实用户反馈**通过 `docs/用户反馈表.md` 与网页「使用反馈」表单收集；系统不代填、不虚构反馈内容。
- 阶段一调研照片 / `raw_data/`、完整 AI 对话导出由本人真实采集后补充，目录里只放说明与待办清单，不放编造内容。
