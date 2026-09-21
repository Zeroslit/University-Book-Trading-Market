# 用 Cloudflare Pages 发布镜像站（命令行方式，适合反复发布）
#
# 首次使用（约 2 分钟）：
#   1) 注册/登录 https://dash.cloudflare.com
#   2) 生成 API Token： https://dash.cloudflare.com/profile/api-tokens
#      → Create Token → 自定义模板 → 权限选 Account : Cloudflare Pages : Edit
#   3) 找到 Account ID：控制台首页右侧边栏，或浏览器地址栏 dash.cloudflare.com/<32位串>
#   4) 设置两个环境变量后运行本脚本：
#        $env:CLOUDFLARE_API_TOKEN  = '<你的 Token>'
#        $env:CLOUDFLARE_ACCOUNT_ID = '<32 位 Account ID>'
#        .\deploy\deploy-cloudflare.ps1
#
# 首次运行 wrangler 会询问是否创建项目，输入 y 回车即可；
# 之后每次发布会自动覆盖，访问地址不变。
[CmdletBinding()]
param(
  [string]$Project = 'campus-book-demo',
  [string]$Branch = 'main',
  [switch]$SkipBuild
)
$ErrorActionPreference = 'Stop'
$dist = Join-Path $PSScriptRoot 'dist'

if (-not $env:CLOUDFLARE_API_TOKEN) {
  throw '缺少环境变量 CLOUDFLARE_API_TOKEN，请先按脚本头部注释生成 Token 并设置。'
}

if (-not $SkipBuild) {
  Write-Host '重新构建发布产物...' -ForegroundColor Cyan
  & (Join-Path $PSScriptRoot 'build-mirror.ps1')
}
if (-not (Test-Path -LiteralPath $dist)) {
  throw "找不到发布目录 $dist，请先运行 deploy\build-mirror.ps1"
}

Write-Host "开始发布到 Cloudflare Pages 项目 $Project ..." -ForegroundColor Cyan
npx --yes wrangler@latest pages deploy $dist --project-name $Project --branch $Branch
if ($LASTEXITCODE -ne 0) { throw '发布失败，请检查上方 wrangler 输出（常见原因：Token 权限不含 Pages:Edit、Account ID 填错）' }

Write-Host ''
Write-Host "发布完成！" -ForegroundColor Green
Write-Host "  落地页： https://$Project.pages.dev/"
Write-Host "  演示应用： https://$Project.pages.dev/web/"
Write-Host '  把上面地址发给同学即可，任何电脑/手机浏览器都能直接打开。'
