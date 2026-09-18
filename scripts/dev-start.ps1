# 一键启动本地开发环境：MySQL(3307，若为便携版) + 后端 API(3000) + 前端 Vite(5173)
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev-start.ps1
$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$serverDir = Join-Path $root 'server'
$webDir = Join-Path $root 'web'

function Test-Port([int]$port) {
  return [bool](netstat -ano | Select-String ":$port\s+.*LISTENING")
}

# 1) MySQL（本项目演示默认使用 127.0.0.1:3307 的便携实例；如已装正式 MySQL 可自行改 server\.env）
if (Test-Port 3307) {
  Write-Host 'MySQL 已在 3307 端口运行' -ForegroundColor DarkGray
} else {
  $mysqlHome = Join-Path $env:TEMP 'mysql8\mysql-8.0.28-winx64'
  $mysqlData = Join-Path $env:TEMP 'mysql8\data'
  if ((Test-Path (Join-Path $mysqlHome 'bin\mysqld.exe')) -and (Test-Path $mysqlData)) {
    Write-Host '启动便携版 MySQL ...' -ForegroundColor Cyan
    Start-Process -FilePath (Join-Path $mysqlHome 'bin\mysqld.exe') -WindowStyle Hidden -ArgumentList @(
      "--basedir=$mysqlHome", "--datadir=$mysqlData", '--port=3307', '--bind-address=127.0.0.1',
      '--character-set-server=utf8mb4', '--collation-server=utf8mb4_unicode_ci', '--mysqlx=0'
    )
    Start-Sleep -Seconds 8
  } else {
    Write-Host '未检测到 3307 端口的 MySQL。请先安装 MySQL 8（修改 server\.env 的 DB_*），或使用 docker compose 启动。' -ForegroundColor Yellow
  }
}

# 2) 依赖
if (-not (Test-Path (Join-Path $serverDir 'node_modules'))) {
  Write-Host '安装后端依赖 ...' -ForegroundColor Yellow
  Push-Location $serverDir; npm install; Pop-Location
}
if (-not (Test-Path (Join-Path $webDir 'node_modules'))) {
  Write-Host '安装前端依赖 ...' -ForegroundColor Yellow
  Push-Location $webDir; npm install; Pop-Location
}

# 3) 后端
if (Test-Port 3000) {
  Write-Host '后端已在 3000 端口运行' -ForegroundColor DarkGray
} else {
  Write-Host '启动后端 API ...' -ForegroundColor Cyan
  Start-Process -FilePath 'node' -ArgumentList 'src/server.js' -WorkingDirectory $serverDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP 'campus-api.out.log') `
    -RedirectStandardError (Join-Path $env:TEMP 'campus-api.err.log')
}

# 4) 前端
if (Test-Port 5173) {
  Write-Host '前端已在 5173 端口运行' -ForegroundColor DarkGray
} else {
  Write-Host '启动前端 Vite ...' -ForegroundColor Cyan
  Start-Process -FilePath 'npm.cmd' -ArgumentList 'run', 'dev' -WorkingDirectory $webDir -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $env:TEMP 'campus-web.out.log') `
    -RedirectStandardError (Join-Path $env:TEMP 'campus-web.err.log')
}

Start-Sleep -Seconds 6
Write-Host ''
Write-Host '前端页面： http://localhost:5173' -ForegroundColor Green
Write-Host '后端接口： http://127.0.0.1:3000/api/v1   （健康检查 http://127.0.0.1:3000/health）' -ForegroundColor Green
Write-Host '演示账号：学生 13800000001 / 校管 13900000001 / 客服 13900000002 / 平台管理员 13900000003，密码 Test@123456，短信验证码 123456' -ForegroundColor Green
Write-Host '日志：%TEMP%\campus-api.err.log、%TEMP%\campus-web.err.log' -ForegroundColor DarkGray
