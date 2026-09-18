# 停止本地开发环境（释放 3000 / 5173 端口；MySQL 3307 需自行停止）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\dev-stop.ps1
foreach ($port in 3000, 5173) {
  $pids = netstat -ano | Select-String ":$port\s+.*LISTENING" | ForEach-Object { ($_ -split '\s+')[-1] } | Sort-Object -Unique
  if (-not $pids) { Write-Host "端口 $port 未被占用" -ForegroundColor DarkGray; continue }
  foreach ($processId in $pids) {
    try {
      Stop-Process -Id ([int]$processId) -Force -ErrorAction Stop
      Write-Host "已停止端口 $port 上的进程 $processId" -ForegroundColor Yellow
    } catch {
      Write-Host "无法停止进程 $processId：$($_.Exception.Message)" -ForegroundColor Red
    }
  }
}
