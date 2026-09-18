# 手动初始化数据库（Windows / PowerShell）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\init-db.ps1
$ErrorActionPreference = 'Stop'
$serverDir = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\server'
Push-Location $serverDir
try {
  Write-Host '[1/2] 执行数据库迁移（幂等）' -ForegroundColor Cyan
  node src/db/migrate.js
  Write-Host '[2/2] 写入种子数据' -ForegroundColor Cyan
  node src/db/seed.js
  Write-Host '完成。种子账号密码统一为 Test@123456，开发环境短信验证码固定 123456。' -ForegroundColor Green
} finally {
  Pop-Location
}
