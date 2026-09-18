// 接口限流：阈值来自 configs（rate_limit.default / rate_limit.sensitive），Redis 计数 + 内存降级
import { AppError, ERR } from '../lib/errors.js';
import { redis } from '../services/redis.service.js';
import { configService } from '../services/config.service.js';

export function rateLimit(scene = 'default') {
  return async (req, res, next) => {
    try {
      const base = await configService.get('rate_limit.default', req.schoolId ?? null);
      let max = Number(base.max);
      let windowSeconds = Number(base.windowSeconds);
      if (scene !== 'default') {
        const sensitive = await configService.get('rate_limit.sensitive', req.schoolId ?? null);
        if (sensitive && sensitive[scene]) max = Number(sensitive[scene]);
      }
      const identity = req.user?.id ? `u:${req.user.id}` : `ip:${req.ip}`;
      const key = `rl:${scene}:${identity}`;
      const count = await redis.incrWithTtl(key, windowSeconds);
      res.setHeader('X-RateLimit-Limit', max);
      res.setHeader('X-RateLimit-Remaining', Math.max(0, max - count));
      if (count > max) {
        throw new AppError(ERR.RATE_LIMITED, `操作过于频繁，请 ${windowSeconds} 秒后重试`, { scene, max, windowSeconds });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
