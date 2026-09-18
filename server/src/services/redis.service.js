// Redis 封装：缓存 / 限流 / 验证码 / 幂等锁
// 开发环境 Redis 不可用时自动降级为进程内存实现（仅打印警告），生产必须使用真实 Redis
import Redis from 'ioredis';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';

class MemoryStore {
  constructor() {
    this.map = new Map();
  }

  #alive(key) {
    const item = this.map.get(key);
    if (!item) return null;
    if (item.expireAt && item.expireAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return item;
  }

  async get(key) {
    const item = this.#alive(key);
    return item ? String(item.value) : null;
  }

  async set(key, value, ttlSeconds) {
    this.map.set(key, { value, expireAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null });
    return 'OK';
  }

  async del(key) {
    this.map.delete(key);
    return 1;
  }

  async incr(key) {
    const item = this.#alive(key);
    const next = (item ? Number(item.value) : 0) + 1;
    this.map.set(key, { value: next, expireAt: item?.expireAt ?? null });
    return next;
  }

  async expire(key, ttlSeconds) {
    const item = this.#alive(key);
    if (!item) return 0;
    item.expireAt = Date.now() + ttlSeconds * 1000;
    return 1;
  }

  async ttl(key) {
    const item = this.#alive(key);
    if (!item || !item.expireAt) return -1;
    return Math.max(0, Math.ceil((item.expireAt - Date.now()) / 1000));
  }
}

class RedisService {
  constructor() {
    this.memory = new MemoryStore();
    this.client = null;
    this.available = false;
    this.degraded = false;
  }

  async init() {
    if (!config.redis.enabled) {
      this.degraded = true;
      logger.warn('Redis 已禁用（REDIS_ENABLED=false），使用内存实现');
      return;
    }
    try {
      this.client = new Redis({
        host: config.redis.host,
        port: config.redis.port,
        password: config.redis.password,
        db: config.redis.db,
        lazyConnect: true,
        maxRetriesPerRequest: 1,
        retryStrategy: (times) => Math.min(times * 200, 2000),
      });
      this.client.on('error', (err) => {
        if (!this.degraded) logger.warn('Redis 连接异常，降级为内存实现', { error: err.message });
        this.degraded = true;
        this.available = false;
      });
      await this.client.connect();
      this.available = true;
      this.degraded = false;
      logger.info('Redis 连接成功');
    } catch (err) {
      this.degraded = true;
      this.available = false;
      logger.warn('Redis 不可用，降级为内存实现（仅限开发环境）', { error: err.message });
    }
  }

  get useReal() {
    return this.available && !this.degraded && this.client;
  }

  async get(key) {
    if (this.useReal) return this.client.get(key);
    return this.memory.get(key);
  }

  async set(key, value, ttlSeconds) {
    if (this.useReal) {
      if (ttlSeconds) return this.client.set(key, value, 'EX', ttlSeconds);
      return this.client.set(key, value);
    }
    return this.memory.set(key, value, ttlSeconds);
  }

  async del(key) {
    if (this.useReal) return this.client.del(key);
    return this.memory.del(key);
  }

  // 原子自增并设置过期（限流用）
  async incrWithTtl(key, ttlSeconds) {
    if (this.useReal) {
      const count = await this.client.incr(key);
      if (count === 1) await this.client.expire(key, ttlSeconds);
      return count;
    }
    const count = await this.memory.incr(key);
    if (count === 1) await this.memory.expire(key, ttlSeconds);
    return count;
  }

  async ttl(key) {
    if (this.useReal) return this.client.ttl(key);
    return this.memory.ttl(key);
  }

  // 健康检查用：real=真实 Redis，memory=内存降级，disabled=显式关闭
  status() {
    if (!config.redis.enabled) return 'disabled';
    return this.useReal ? 'real' : 'memory';
  }

  async close() {
    if (this.client) await this.client.quit().catch(() => {});
  }
}

export const redis = new RedisService();
