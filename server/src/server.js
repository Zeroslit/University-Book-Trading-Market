// 服务入口：启动 HTTP 服务 + 定时任务 + 优雅停机
import { config } from './config/index.js';
import { logger } from './lib/logger.js';
import { createHttpServer, initRuntime } from './bootstrap.js';
import { startJobs, stopJobs } from './jobs/scheduler.js';
import { closePool } from './db/pool.js';
import { redis } from './services/redis.service.js';

async function main() {
  await initRuntime();

  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, () => resolve());
  });
  logger.info('服务已启动', {
    url: `http://127.0.0.1:${config.port}`,
    api: `http://127.0.0.1:${config.port}/api/v1`,
    health: `http://127.0.0.1:${config.port}/health`,
    env: config.env,
    redis: redis.status(),
  });

  if (config.jobs.enabled) startJobs();
  else logger.warn('定时任务已禁用（JOBS_ENABLED=false），自动确认收货/工单升级将不会执行');

  let closing = false;
  const shutdown = async (signal) => {
    if (closing) return;
    closing = true;
    logger.info('收到退出信号，开始优雅停机', { signal });
    stopJobs();
    const force = setTimeout(() => process.exit(1), 10_000);
    force.unref();
    await new Promise((resolve) => server.close(resolve));
    await redis.close();
    await closePool().catch(() => {});
    logger.info('已安全退出');
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => logger.error('未处理的 Promise 拒绝', { reason: String(reason) }));
  process.on('uncaughtException', (err) => {
    logger.error('未捕获异常，进程退出', { error: err.message, stack: err.stack });
    shutdown('uncaughtException');
  });
}

main().catch((err) => {
  logger.error('服务启动失败', { error: err?.message, stack: err?.stack });
  process.exit(1);
});
