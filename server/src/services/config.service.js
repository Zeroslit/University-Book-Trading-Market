// 规则阈值配置服务：学校级覆盖 -> 平台级默认 -> 抛错（绝不硬编码兜底）
import { AppError, ERR } from '../lib/errors.js';
import { query, queryOne, execute } from '../db/pool.js';
import { redis } from './redis.service.js';
import { logger } from '../lib/logger.js';

const CACHE_TTL = 60; // 秒
const memoryCache = new Map(); // key -> { value, expireAt }

function memoryKey(key, schoolId) {
  return `${schoolId ?? 'platform'}:${key}`;
}

export const configService = {
  async get(key, schoolId = null) {
    const cacheKey = memoryKey(key, schoolId);
    const cached = memoryCache.get(cacheKey);
    if (cached && cached.expireAt > Date.now()) return cached.value;

    const redisKey = `cfg:${cacheKey}`;
    const fromRedis = await redis.get(redisKey);
    if (fromRedis) {
      const value = JSON.parse(fromRedis);
      memoryCache.set(cacheKey, { value, expireAt: Date.now() + 30_000 });
      return value;
    }

    let row = null;
    if (schoolId) {
      row = await queryOne(
        "SELECT config_value FROM configs WHERE scope = 'school' AND school_id = ? AND config_key = ? LIMIT 1",
        [schoolId, key],
      );
    }
    if (!row) {
      row = await queryOne(
        "SELECT config_value FROM configs WHERE scope = 'platform' AND school_id IS NULL AND config_key = ? LIMIT 1",
        [key],
      );
    }
    if (!row) {
      throw new AppError(ERR.CONFIG_MISSING, `规则配置缺失：${key}，请在管理后台初始化`, { configKey: key, schoolId });
    }
    const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value;
    await redis.set(redisKey, JSON.stringify(value), CACHE_TTL);
    memoryCache.set(cacheKey, { value, expireAt: Date.now() + 30_000 });
    return value;
  },

  async getWithSource(key, schoolId = null) {
    if (schoolId) {
      const row = await queryOne(
        "SELECT config_value, version, scope, school_id FROM configs WHERE scope = 'school' AND school_id = ? AND config_key = ? LIMIT 1",
        [schoolId, key],
      );
      if (row) return { value: parseValue(row.config_value), source: 'school', version: row.version };
    }
    const row = await queryOne(
      "SELECT config_value, version, scope, school_id FROM configs WHERE scope = 'platform' AND school_id IS NULL AND config_key = ? LIMIT 1",
      [key],
    );
    if (!row) throw new AppError(ERR.CONFIG_MISSING, `规则配置缺失：${key}`, { configKey: key });
    return { value: parseValue(row.config_value), source: 'platform', version: row.version };
  },

  async set(key, value, { scope = 'platform', schoolId = null, actorId = null, description = null, version = null } = {}) {
    if (scope === 'school' && !schoolId) throw new AppError(ERR.SCHOOL_REQUIRED, '学校级配置必须指定 schoolId');
    const existing = await queryOne(
      `SELECT id, version FROM configs WHERE scope = ? AND ${schoolId ? 'school_id = ?' : 'school_id IS NULL'} AND config_key = ? LIMIT 1`,
      schoolId ? [scope, schoolId, key] : [scope, key],
    );
    if (existing) {
      if (version !== null && Number(version) !== Number(existing.version)) {
        throw new AppError(ERR.CONFLICT, '配置已被他人修改，请刷新后重试', { currentVersion: existing.version });
      }
      await execute(
        'UPDATE configs SET config_value = CAST(? AS JSON), version = version + 1, updated_by = ?, description = COALESCE(?, description) WHERE id = ?',
        [JSON.stringify(value), actorId, description, existing.id],
      );
    } else {
      await execute(
        `INSERT INTO configs (scope, school_id, config_key, config_value, description, version, updated_by)
         VALUES (?, ?, ?, CAST(? AS JSON), ?, 1, ?)`,
        [scope, schoolId, key, JSON.stringify(value), description, actorId],
      );
    }
    await this.invalidate(key, schoolId);
    return { key, scope, schoolId, value };
  },

  async list({ schoolId = null } = {}) {
    const rows = await query(
      `SELECT scope, school_id, config_key, config_value, description, version, updated_at
       FROM configs WHERE scope = 'platform' OR school_id = ? ORDER BY config_key, scope DESC`,
      [schoolId],
    );
    return rows.map((r) => ({
      scope: r.scope,
      schoolId: r.school_id,
      key: r.config_key,
      value: parseValue(r.config_value),
      description: r.description,
      version: r.version,
      updatedAt: r.updated_at,
    }));
  },

  async invalidate(key, schoolId = null) {
    memoryCache.delete(memoryKey(key, schoolId));
    await redis.del(`cfg:${memoryKey(key, schoolId)}`);
    if (schoolId) {
      memoryCache.delete(memoryKey(key, null));
      await redis.del(`cfg:${memoryKey(key, null)}`);
    }
    logger.debug('配置缓存已失效', { key, schoolId });
  },

  async clearCache() {
    memoryCache.clear();
  },
};

function parseValue(raw) {
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}
