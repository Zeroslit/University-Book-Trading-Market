#!/usr/bin/env sh
# 手动初始化数据库（建表 + 种子数据）。docker compose 启动时由 db-init 服务自动执行一次。
# 用法（宿主机已安装 Node 20 且能连到 MySQL）：
#   cd server && npm install
#   sh ../scripts/init-db.sh
set -e

cd "$(dirname "$0")/../server"

echo "[1/2] 执行数据库迁移（幂等，可重复运行）"
node src/db/migrate.js

echo "[2/2] 写入种子数据（会清空并重建演示数据）"
node src/db/seed.js

echo "完成。种子账号密码统一为 Test@123456，开发环境短信验证码固定 123456。"
