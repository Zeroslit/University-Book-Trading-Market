// 定时任务调度器：job_locks 表做分布式互斥，多实例部署时同一任务同一时刻只跑一次
// 任务清单：自动确认收货 / 工单 SLA 自动升级 / 过期处罚清理 / 敏感数据保存期限清理
import os from 'node:os';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { pool } from '../db/pool.js';
import { q1, run } from '../db/tx.js';
import { orderService } from '../services/order.service.js';
import { ticketService } from '../services/ticket.service.js';
import { penaltyService } from '../services/penalty.service.js';
import { retentionJob } from './retention.job.js';

const workerId = `${os.hostname()}#${process.pid}`;

// intervalSeconds 为期望执行间隔；锁 TTL 取 interval 的 1.5 倍，避免任务卡死导致锁永不释放
export const JOBS = [
  {
    name: 'order.auto_confirm',
    intervalSeconds: 60,
    description: '发货后 7 天未确认收货自动确认并放款（争议中订单已冻结倒计时，不在扫描范围）',
    handler: () => orderService.autoConfirmDue({ limit: 50 }),
  },
  {
    name: 'ticket.auto_escalate',
    intervalSeconds: 300,
    description: '工单 SLA 超时自动升级并通知用户已加急',
    handler: () => ticketService.autoEscalateDue({ limit: 100 }),
  },
  {
    name: 'penalty.sweep_expired',
    intervalSeconds: 3600,
    description: '过期处罚置 expired 并解除对应封禁开关',
    handler: () => penaltyService.sweepExpired(),
  },
  {
    name: 'data.retention',
    intervalSeconds: 86400,
    description: '敏感数据保存期限清理（会话/审计/认证材料/举报证据）',
    handler: () => retentionJob.run(),
  },
];

const lastRunAt = new Map();

// 抢锁：locked_until 已过期则抢占；抢占成功时 locked_by 记为当前 worker
async function acquireLock(name, ttlSeconds) {
  await run(
    pool,
    `INSERT INTO job_locks (job_name, locked_until, locked_by)
     VALUES (?, DATE_ADD(NOW(3), INTERVAL ? SECOND), ?)
     ON DUPLICATE KEY UPDATE
       locked_by = IF(locked_until <= NOW(3), VALUES(locked_by), locked_by),
       locked_until = IF(locked_by = VALUES(locked_by), VALUES(locked_until), locked_until)`,
    [name, ttlSeconds, workerId],
  );
  const row = await q1(pool, 'SELECT locked_by FROM job_locks WHERE job_name = ?', [name]);
  return row?.locked_by === workerId;
}

async function releaseLock(name) {
  await run(pool, 'UPDATE job_locks SET locked_until = NOW(3) WHERE job_name = ? AND locked_by = ?', [name, workerId]);
}

/**
 * 执行单个任务（带分布式锁）
 * @returns {Promise<{job:string, skipped:boolean, result?:any, error?:string}>}
 */
export async function runJob(name) {
  const job = JOBS.find((item) => item.name === name);
  if (!job) throw new Error(`未定义的定时任务：${name}`);
  const ttl = Math.ceil(job.intervalSeconds * 1.5);
  const acquired = await acquireLock(job.name, ttl);
  if (!acquired) {
    logger.debug('定时任务未获得锁，跳过', { job: job.name, workerId });
    return { job: job.name, skipped: true };
  }
  const startedAt = Date.now();
  try {
    const result = await job.handler();
    lastRunAt.set(job.name, new Date());
    logger.info('定时任务执行完成', { job: job.name, costMs: Date.now() - startedAt, result: summarize(result) });
    return { job: job.name, skipped: false, result };
  } catch (err) {
    logger.error('定时任务执行失败', { job: job.name, error: err.message, stack: err.stack });
    return { job: job.name, skipped: false, error: err.message };
  } finally {
    await releaseLock(job.name).catch((err) => logger.warn('释放任务锁失败', { job: job.name, error: err.message }));
  }
}

function summarize(result) {
  if (result === undefined || result === null) return result;
  if (typeof result === 'number' || typeof result === 'string' || typeof result === 'boolean') return result;
  if (Array.isArray(result)) return { count: result.length };
  return result;
}

// 依次执行所有到期任务（串行，避免瞬时打满数据库连接池）
export async function runDueJobs() {
  const now = Date.now();
  const results = [];
  for (const job of JOBS) {
    const last = lastRunAt.get(job.name)?.getTime() ?? 0;
    if (now - last < job.intervalSeconds * 1000) continue;
    results.push(await runJob(job.name));
  }
  return results;
}

let timer = null;

export function startJobs() {
  if (timer) return timer;
  const tickMs = Math.max(5, config.jobs.tickSeconds) * 1000;
  timer = setInterval(() => {
    runDueJobs().catch((err) => logger.error('定时任务调度异常', { error: err.message }));
  }, tickMs);
  if (timer.unref) timer.unref();
  // 启动后延迟 5 秒做一次，避开服务冷启动
  setTimeout(() => {
    runDueJobs().catch((err) => logger.error('定时任务首次调度异常', { error: err.message }));
  }, 5000).unref?.();
  logger.info('定时任务调度器已启动', { tickSeconds: config.jobs.tickSeconds, jobs: JOBS.map((job) => job.name) });
  return timer;
}

export function stopJobs() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function jobsStatus() {
  return JOBS.map((job) => ({
    name: job.name,
    description: job.description,
    intervalSeconds: job.intervalSeconds,
    lastRunAt: lastRunAt.get(job.name)?.toISOString() ?? null,
  }));
}

export default { JOBS, runJob, runDueJobs, startJobs, stopJobs, jobsStatus };
