# 一键构建「国内镜像站」发布产物
# 产物目录：deploy\dist
#   结构 = index.html(落地页) + 404.html(SPA 兜底) + _redirects + _headers + web\(演示应用)
# 用法： .\deploy\build-mirror.ps1
# 该目录可直接拖拽上传到 Cloudflare Pages / Netlify，也可用 deploy-cloudflare.ps1 命令行发布。
[CmdletBinding()]
param(
  # 演示应用在镜像站上的子路径，默认 /web/，即 https://<你的域名>/web/
  [string]$Base = '/web/'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$dist = Join-Path $PSScriptRoot 'dist'

Write-Host "[1/4] 构建演示版前端（base=$Base, VITE_DEMO=true）..." -ForegroundColor Cyan
$env:VITE_BASE = $Base
$env:VITE_DEMO = 'true'
Push-Location (Join-Path $root 'web')
try { npm run build } finally { Pop-Location }

Write-Host "[2/4] 清理旧产物..." -ForegroundColor Cyan
if (Test-Path -LiteralPath $dist) { Remove-Item -LiteralPath $dist -Recurse -Force }
New-Item -ItemType Directory -Force -Path $dist | Out-Null

Write-Host "[3/4] 组装发布目录..." -ForegroundColor Cyan
Copy-Item -LiteralPath (Join-Path $root 'web\dist') -Destination (Join-Path $dist 'web') -Recurse
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'landing\index.html') -Destination (Join-Path $dist 'index.html')
Copy-Item -LiteralPath (Join-Path $dist 'web\index.html') -Destination (Join-Path $dist '404.html')
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'pages\_redirects') -Destination $dist
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'pages\_headers') -Destination $dist
New-Item -ItemType File -Force -Path (Join-Path $dist '.nojekyll') | Out-Null

Write-Host "[4/4] 完成，发布目录： $dist" -ForegroundColor Green
