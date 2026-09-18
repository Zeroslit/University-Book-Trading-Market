// 数据库迁移执行器：按 migrations/*.sql 文件名字典序执行，未执行的才执行
// 用法：node src/db/migrate.js [--reset]
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(currentDir, 'migrations');

async function withServerConnection(handler) {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
  try {
    return await handler(conn);
  } finally {
    await conn.end();
  }
}

async function withDatabaseConnection(handler) {
  const conn = await mysql.createConnection({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    multipleStatements: true,
    charset: 'utf8mb4',
  });
  try {
    return await handler(conn);
  } finally {
    await conn.end();
  }
}

export async function migrate({ reset = false } = {}) {
  const dbName = config.db.database;
  if (reset) {
    logger.warn(`--reset：删除数据库 ${dbName}`);
    await withServerConnection((conn) => conn.query(`DROP DATABASE IF EXISTS \`${dbName}\``));
  }
  await withServerConnection((conn) =>
    conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` DEFAULT CHARSET utf8mb4 COLLATE utf8mb4_unicode_ci`),
  );

  const result = await withDatabaseConnection(async (conn) => {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(60) NOT NULL,
         applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
         PRIMARY KEY (version)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
    );
    const [appliedRows] = await conn.query('SELECT version FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.version));

    const files = (await fs.readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
    const executed = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      logger.info(`执行迁移 ${file}`);
      await conn.query(sql);
      await conn.query('INSERT INTO schema_migrations (version) VALUES (?)', [file]);
      executed.push(file);
    }
    return { executed, total: files.length };
  });

  return result;
}

const isMain = process.argv[1] && process.argv[1].endsWith('migrate.js');
if (isMain) {
  migrate({ reset: process.argv.includes('--reset') })
    .then((r) => {
      logger.info('迁移完成', { executed: r.executed.length, total: r.total });
      process.exit(0);
    })
    .catch((err) => {
      logger.error('迁移失败', { error: err.message, code: err.code });
      process.exit(1);
    });
}
