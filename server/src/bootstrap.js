// 运行时引导：初始化依赖（Redis/连接池）并组装 HTTP 服务
// 说明：测试可直接 import { createApp }，无需监听端口，也无需真实 Redis（自动内存降级）
import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { redis } from './services/redis.service.js';
import { ping } from './db/pool.js';

export async function initRuntime({ checkDb = true } = {}) {
  await redis.init();
  if (checkDb) {
    try {
      await ping();
      logger.info('MySQL 连接成功', { host: config.db.host, port: config.db.port, database: config.db.database });
    } catch (err) {
      logger.error('MySQL 连接失败，请检查 DB_* 配置或执行 npm run db:reset', { error: err.message });
      throw err;
    }
  }
  return { redis: redis.status() };
}

export function createHttpServer() {
  return http.createServer(createApp());
}

export { createApp };
