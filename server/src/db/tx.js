// 事务封装：资金与状态变更必须走这里，禁止在业务层裸用连接
import { pool } from './pool.js';
import { logger } from '../lib/logger.js';
import { runInTx } from './tx-context.js';

// 统一执行器：既接受 pool 也接受事务连接
export async function q(exec, sql, params = []) {
  const [rows] = await exec.query(sql, params);
  return rows;
}

export async function q1(exec, sql, params = []) {
  const rows = await q(exec, sql, params);
  return rows[0] ?? null;
}

export async function run(exec, sql, params = []) {
  const [result] = await exec.query(sql, params);
  return result;
}

const RETRYABLE = new Set(['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']);

/**
 * 事务执行器（带死锁重试）
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<any>} handler
 * @param {{retries?:number, isolation?:string}} options
 */
export async function withTransaction(handler, options = {}) {
  const retries = options.retries ?? 3;
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const conn = await pool.getConnection();
    try {
      if (options.isolation) await conn.query(`SET TRANSACTION ISOLATION LEVEL ${options.isolation}`);
      await conn.beginTransaction();
      // 在事务上下文中执行：期间所有 pool.query/execute 都会复用该连接
      const result = await runInTx(conn, () => handler(conn));
      await conn.commit();
      return result;
    } catch (err) {
      try {
        await conn.rollback();
      } catch (rollbackErr) {
        logger.warn('事务回滚失败', { error: rollbackErr.message });
      }
      attempt += 1;
      if (RETRYABLE.has(err?.code) && attempt <= retries) {
        logger.warn('检测到锁冲突，重试事务', { code: err.code, attempt });
        continue;
      }
      throw err;
    } finally {
      conn.release();
    }
  }
}

// 行锁读取：用于「一本书只能有一个有效订单」等并发场景
export async function selectForUpdate(conn, sql, params = []) {
  const rows = await q(conn, sql, params);
  return rows[0] ?? null;
}

// 一致性校验：wallet_accounts 的余额缓存必须等于流水求和
export async function assertWalletConsistency(conn, userId) {
  const row = await q1(
    conn,
    `SELECT
        COALESCE(SUM(CASE WHEN account = 'balance' AND status = 'success' THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0) AS balance,
        COALESCE(SUM(CASE WHEN account = 'frozen'  AND status = 'success' THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0) AS frozen
     FROM wallet_transactions WHERE user_id = ?`,
    [userId],
  );
  const account = await q1(conn, 'SELECT balance_cents, frozen_cents FROM wallet_accounts WHERE user_id = ?', [userId]);
  if (!account) return { ok: false, reason: 'wallet_account_missing', expected: row };
  const ok = Number(account.balance_cents) === Number(row.balance) && Number(account.frozen_cents) === Number(row.frozen);
  return { ok, ledger: row, account, reason: ok ? null : 'wallet_mismatch' };
}
