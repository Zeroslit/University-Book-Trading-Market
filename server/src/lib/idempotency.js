// 接口级幂等：同一 Idempotency-Key 的重复请求只会执行一次
import crypto from 'node:crypto';
import { AppError, ERR } from './errors.js';

export function getIdempotencyKey(req) {
  return req.get('Idempotency-Key') || req.body?.idempotencyKey || req.query?.idempotencyKey || null;
}

export function requestHash(payload) {
  return crypto.createHash('sha256').update(JSON.stringify(payload ?? {})).digest('hex');
}

/**
 * 幂等执行器（必须在事务中调用，保证「占位 + 执行 + 落结果」原子）
 * @param {object} conn 事务连接
 * @param {{scope:string, key:string, payload:any, schoolId?:number, userId?:number}} meta
 * @param {(conn:object) => Promise<any>} handler
 */
export async function withIdempotency(conn, meta, handler) {
  const { scope, key, payload, schoolId = null, userId = null } = meta;
  if (!key) return handler(conn); // 未传幂等键则退化为普通执行

  const hash = requestHash(payload);
  try {
    await conn.query(
      `INSERT INTO idempotency_records (school_id, user_id, scope, idem_key, request_hash, status)
       VALUES (?, ?, ?, ?, ?, 'processing')`,
      [schoolId, userId, scope, key, hash],
    );
  } catch (err) {
    if (err && err.code === 'ER_DUP_ENTRY') {
      const [rows] = await conn.query(
        'SELECT * FROM idempotency_records WHERE scope = ? AND idem_key = ? LIMIT 1',
        [scope, key],
      );
      const record = rows[0];
      if (!record) throw new AppError(ERR.CONFLICT, '重复请求，请稍后重试');
      if (record.status === 'done') {
        // MySQL JSON 列在 mysql2 中已被解析为对象，字符串场景需兼容
        const snapshot = record.response_snapshot;
        if (snapshot === null || snapshot === undefined) return null;
        return typeof snapshot === 'string' ? JSON.parse(snapshot) : snapshot;
      }
      throw new AppError(ERR.IDEMPOTENT_REPLAY, '请求正在处理中，请勿重复提交');
    }
    throw err;
  }

  const result = await handler(conn);
  await conn.query(
    `UPDATE idempotency_records SET status = 'done', response_snapshot = ? WHERE scope = ? AND idem_key = ?`,
    [JSON.stringify(result ?? null), scope, key],
  );
  return result;
}
