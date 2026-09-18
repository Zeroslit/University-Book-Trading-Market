// MySQL 连接池（所有 SQL 必须经过 repository 层）
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { currentTx } from './tx-context.js';

export const pool = mysql.createPool({
  host: config.db.host,
  port: config.db.port,
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  waitForConnections: true,
  connectionLimit: config.db.connectionLimit,
  queueLimit: 0,
  timezone: config.db.timezone,
  charset: 'utf8mb4_unicode_ci',
  supportBigNumbers: true,
  bigNumberStrings: false,
  dateStrings: false,
  multipleStatements: false, // 安全：禁止多语句，防注入扩大影响面
});

// 关键：事务内自动复用事务连接（禁止在事务里另开连接，否则并发下会耗尽连接池）
function executor() {
  return currentTx() ?? pool;
}

export async function query(sql, params = []) {
  const [rows] = await executor().query(sql, params);
  return rows;
}

export async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

export async function execute(sql, params = []) {
  const [result] = await executor().query(sql, params);
  return result; // ResultSetHeader
}

export async function ping() {
  const conn = await pool.getConnection();
  try {
    await conn.ping();
  } finally {
    conn.release();
  }
}

export async function closePool() {
  await pool.end();
}

export async function healthCheck() {
  try {
    await query('SELECT 1 AS ok');
    return true;
  } catch (err) {
    logger.error('数据库健康检查失败', { error: err.message });
    return false;
  }
}
