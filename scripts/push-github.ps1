# 一键推送到 GitHub（零基础版）
# 用法：在 PowerShell 里右键「使用 PowerShell 运行」，或执行：
#   powershell -ExecutionPolicy Bypass -File scripts\push-github.ps1
# 说明：首次会弹出 GitHub 登录窗口，用你自己的账号登录一次即可，之后会记住。

$ErrorActionPreference = 'Stop'
$repo = Join-Path $PSScriptRoot '..'
Set-Location $repo

Write-Host '=== 校园事务台 · 推送到 GitHub ===' -ForegroundColor Cyan

# 1. 找到 git
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if (-not $git) { Write-Host '未找到 git，请先安装 Git for Windows' -ForegroundColor Red; exit 1 }
Write-Host "git: $git"

# 2. 检查远端
$remote = & $git remote get-url origin 2>$null
if (-not $remote) {
  Write-Host '尚未配置远端，正在自动配置…' -ForegroundColor Yellow
  & $git remote add origin 'https://github.com/mxl7389-coder/ICEC-2026-0119-mengjinzhao-.git'
  $remote = & $git remote get-url origin
}
Write-Host "远端: $remote"

# 3. 显示待推送状态
Write-Host ''
Write-Host '--- 当前状态 ---' -ForegroundColor Cyan
& $git status -sb
Write-Host "提交总数: $(& $git rev-list --count HEAD)"
Write-Host ''

# 4. Proxy: env var > Windows system proxy > known local port
$proxy = $env:HTTPS_PROXY
if (-not $proxy) {
  $ie = Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' -ErrorAction SilentlyContinue
  if ($ie -and $ie.ProxyEnable -eq 1 -and $ie.ProxyServer) { $proxy = 'http://' + $ie.ProxyServer }
}
if (-not $proxy) { $proxy = 'http://127.0.0.1:7897' }
$args = @('-c', "http.proxy=$proxy", '-c', "https.proxy=$proxy")
Write-Host "Using proxy: $proxy" -ForegroundColor Gray

# 5. 推送
Write-Host '正在推送…（首次会弹出 GitHub 登录窗口，请用你自己的账号登录）' -ForegroundColor Yellow
& $git @args push -u origin main
$code = $LASTEXITCODE

Write-Host ''
if ($code -eq 0) {
  Write-Host '推送成功！' -ForegroundColor Green
  Write-Host '仓库地址: https://github.com/mxl7389-coder/ICEC-2026-0119-mengjinzhao-' -ForegroundColor Green
  Write-Host ''
  Write-Host 'Repo: https://github.com/mxl7389-coder/ICEC-2026-0119-mengjinzhao- (Public)' -ForegroundColor Yellow
  Write-Host 'Daily log: run node scripts/daily-report.js --sync first, then this script' -ForegroundColor Yellow
} else {
  Write-Host "推送未完成（退出码 $code）。把屏幕上的红字截图发给助手排障即可。" -ForegroundColor Red
  Write-Host '常见原因：登录窗口未完成授权 / 仓库仍是 Private / 网络代理断开。' -ForegroundColor Gray
}

Write-Host ''
Read-Host '按回车键关闭窗口'
