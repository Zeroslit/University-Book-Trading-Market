// 环境变量与常量集中出口（禁止在业务代码里直接读 process.env）
import 'dotenv/config';

function bool(value, defaultValue = false) {
  if (value === undefined || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 3000),
  appName: 'campus-book-platform',

  db: {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'root123456',
    database: process.env.DB_NAME || 'campus_book',
    connectionLimit: Number(process.env.DB_POOL || 10),
    timezone: '+08:00',
  },

  redis: {
    enabled: bool(process.env.REDIS_ENABLED, true),
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
    db: Number(process.env.REDIS_DB || 0),
  },

  jwt: {
    secret: process.env.JWT_SECRET || 'dev-only-jwt-secret-change-me',
    issuer: 'campus-book-platform',
    accessTtl: process.env.JWT_ACCESS_TTL || '2h',
    refreshTtl: process.env.JWT_REFRESH_TTL || '7d',
  },

  // 敏感字段加密与盲索引（生产必须通过环境变量注入，并支持密钥轮换）
  security: {
    aesKey: process.env.AES_KEY || 'dev-aes-key-32-bytes-length!!!',
    hmacSecret: process.env.HMAC_SECRET || 'dev-hmac-secret-change-me',
  },

  sms: {
    provider: process.env.SMS_PROVIDER || 'console', // console | mock | aliyun
    codeTtlSeconds: Number(process.env.SMS_TTL || 300),
    intervalSeconds: Number(process.env.SMS_INTERVAL || 60),
    maxAttempts: Number(process.env.SMS_MAX_ATTEMPTS || 5),
    devFixedCode: process.env.SMS_DEV_CODE || (process.env.NODE_ENV === 'production' ? '' : '123456'),
  },

  upload: {
    dir: process.env.UPLOAD_DIR || 'uploads',
    publicBase: process.env.UPLOAD_PUBLIC_BASE || '/static',
    maxSizeMb: Number(process.env.UPLOAD_MAX_MB || 5),
    allowTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxSidePx: 1080, // 与前端压缩长边一致
  },

  wechat: {
    mock: bool(process.env.WECHAT_MOCK, true), // 一期为模拟实现
    appId: process.env.WECHAT_APP_ID || '',
    appSecret: process.env.WECHAT_APP_SECRET || '',
  },

  payment: {
    mock: bool(process.env.PAYMENT_MOCK, true), // 一期禁止接入真实支付
    provider: process.env.PAYMENT_PROVIDER || 'mock',
  },

  ai: {
    // AI 客服：一期为规则 + 关键词 + 知识库检索，可替换为大模型适配器
    provider: process.env.AI_PROVIDER || 'rule-based',
    confidenceThreshold: Number(process.env.AI_CONFIDENCE || 0.55),
  },

  jobs: {
    enabled: bool(process.env.JOBS_ENABLED, true),
    tickSeconds: Number(process.env.JOBS_TICK_SECONDS || 60),
  },

  storage: {
    provider: process.env.STORAGE_PROVIDER || 'local', // local | oss
  },
};
