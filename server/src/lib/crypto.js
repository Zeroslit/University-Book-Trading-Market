// 敏感数据加密（AES-256-GCM）与盲索引（HMAC-SHA256）
// 约定：数据库只存密文(_enc)、脱敏值(_mask/_last4) 与盲索引(_hash)，绝不存明文
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { config } from '../config/index.js';

const KEY = crypto.createHash('sha256').update(String(config.security.aesKey)).digest(); // 固定 32 字节
const HMAC_KEY = String(config.security.hmacSecret);

// 加密：输出 Buffer，格式 [12B IV][16B AuthTag][密文]
export function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

export function decrypt(buf) {
  if (!buf) return null;
  const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const enc = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

// 盲索引：用于唯一约束与等值检索（同一明文 + 同一密钥 => 同一结果）
export function hmac(value) {
  if (value === null || value === undefined) return null;
  return crypto.createHmac('sha256', HMAC_KEY).update(String(value)).digest('hex');
}

export const fingerprint = hmac;

export async function hashPassword(plain) {
  return bcrypt.hash(String(plain), 10);
}

export async function verifyPassword(plain, hash) {
  if (!hash) return false;
  return bcrypt.compare(String(plain), hash);
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

export function randomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += crypto.randomInt(0, 10);
  return code;
}

// 业务单号：前缀 + yyyyMMddHHmmss + 6 位随机
export function generateNo(prefix) {
  const d = new Date();
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `${prefix}${stamp}${crypto.randomInt(100000, 999999)}`;
}
