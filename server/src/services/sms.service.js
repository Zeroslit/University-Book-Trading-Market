// 短信验证码服务：一期为适配器实现（console/mock），二期可替换为阿里云/腾讯云
// 验证码本体只存 Redis（带 TTL 与尝试次数限制），数据库仅留发送记录
import { config } from '../config/index.js';
import { AppError, ERR } from '../lib/errors.js';
import { hmac, randomCode } from '../lib/crypto.js';
import { maskPhone } from '../lib/mask.js';
import { redis } from './redis.service.js';
import { execute, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

const SCENES = ['register', 'login', 'reset', 'bind', 'unbind'];

function codeKey(phone, scene) {
  return `sms:code:${scene}:${hmac(phone)}`;
}

function cooldownKey(phone, scene) {
  return `sms:cd:${scene}:${hmac(phone)}`;
}

function attemptKey(phone, scene) {
  return `sms:attempt:${scene}:${hmac(phone)}`;
}

export const smsService = {
  async sendCode(phone, scene, ip = null) {
    if (!SCENES.includes(scene)) throw new AppError(ERR.VALIDATION_ERROR, `不支持的验证码场景：${scene}`);

    const cooldown = await redis.ttl(cooldownKey(phone, scene));
    if (cooldown > 0) {
      throw new AppError(ERR.SMS_TOO_FREQUENT, `验证码发送过于频繁，请 ${cooldown} 秒后重试`, { retryAfter: cooldown });
    }

    const code = config.sms.devFixedCode || randomCode(6);
    await redis.set(codeKey(phone, scene), code, config.sms.codeTtlSeconds);
    await redis.set(cooldownKey(phone, scene), '1', config.sms.intervalSeconds);
    await redis.set(attemptKey(phone, scene), '0', config.sms.codeTtlSeconds);

    await execute(
      'INSERT INTO sms_logs (phone_hash, scene, status, ip) VALUES (?, ?, ?, ?)',
      [hmac(phone), scene, 'sent', ip],
    );

    if (config.sms.provider === 'console') {
      logger.info(`【模拟短信】${maskPhone(phone)} 场景=${scene} 验证码=${code}（${config.sms.codeTtlSeconds} 秒内有效）`);
    } else {
      // 二期接入真实短信服务商：此处调用 SDK
      logger.info('短信已发送', { provider: config.sms.provider, scene });
    }

    return {
      sent: true,
      ttl: config.sms.codeTtlSeconds,
      devCode: config.env === 'production' ? undefined : code, // 仅非生产环境回显，便于联调
    };
  },

  async verifyCode(phone, scene, code, { consume = true } = {}) {
    const key = codeKey(phone, scene);
    const saved = await redis.get(key);
    if (!saved) throw new AppError(ERR.SMS_CODE_INVALID, '验证码已过期，请重新获取');

    const attempts = Number(await redis.get(attemptKey(phone, scene)) || 0);
    if (attempts >= config.sms.maxAttempts) {
      await redis.del(key);
      throw new AppError(ERR.SMS_CODE_INVALID, '验证码错误次数过多，请重新获取');
    }

    if (String(saved) !== String(code)) {
      await redis.incrWithTtl(attemptKey(phone, scene), config.sms.codeTtlSeconds);
      throw new AppError(ERR.SMS_CODE_INVALID, '验证码不正确');
    }

    if (consume) {
      await redis.del(key);
      await execute(
        "UPDATE sms_logs SET status = 'verified' WHERE phone_hash = ? AND scene = ? ORDER BY id DESC LIMIT 1",
        [hmac(phone), scene],
      );
    }
    return true;
  },

  async recentLogs(phoneHash, limit = 10) {
    return query('SELECT * FROM sms_logs WHERE phone_hash = ? ORDER BY id DESC LIMIT ?', [phoneHash, Number(limit)]);
  },
};
