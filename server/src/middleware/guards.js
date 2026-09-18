// 业务准入校验：学生认证、信誉分档位权限、禁言/禁止交易封禁开关
import { AppError, ERR } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { creditService } from '../services/credit.service.js';

// 需求：认证通过前仅可浏览，不能发布与交易（学校可配置是否强制认证）
export function requireVerified() {
  return async (req, res, next) => {
    try {
      const school = await queryOne('SELECT require_student_verification FROM schools WHERE id = ?', [req.schoolId]);
      if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在或未开通');
      if (!school.require_student_verification) return next();
      const user = await queryOne('SELECT verification_status FROM users WHERE id = ? AND school_id = ?', [req.user.id, req.schoolId]);
      if (!user || user.verification_status !== 'approved') {
        throw new AppError(ERR.VERIFICATION_REQUIRED, '完成学生认证后才能发布或交易', {
          verificationStatus: user?.verification_status || 'unverified', path: '/verification',
        });
      }
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// 发布权限：禁言 / 信誉分档位（高风险禁发、禁止交易档位禁发）
export function requirePublishPermission() {
  return async (req, res, next) => {
    try {
      const user = await queryOne('SELECT mute_until, trade_ban_until, banned_permanently FROM users WHERE id = ?', [req.user.id]);
      if (!user) throw new AppError(ERR.UNAUTHORIZED, '账号不存在');
      if (user.banned_permanently) throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁');
      if (user.mute_until && new Date(user.mute_until) > new Date()) {
        throw new AppError(ERR.ACCOUNT_MUTED, `账号处于禁言状态，解禁时间：${new Date(user.mute_until).toLocaleString('zh-CN')}`, {
          until: user.mute_until, appealAvailable: true,
        });
      }
      const permissions = await creditService.getPermissions(req.schoolId, req.user.id);
      if (!permissions.canPublish) {
        throw new AppError(ERR.CREDIT_NOT_ALLOWED, `当前信誉分档位「${permissions.tierLabel}」不允许发布内容`, {
          score: permissions.score, tier: permissions.tier, path: '/credit',
        });
      }
      req.creditPermissions = permissions;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// 交易权限：禁止交易封禁 / 信誉分低于交易门槛
export function requireTradePermission() {
  return async (req, res, next) => {
    try {
      const user = await queryOne('SELECT trade_ban_until, banned_permanently FROM users WHERE id = ?', [req.user.id]);
      if (!user) throw new AppError(ERR.UNAUTHORIZED, '账号不存在');
      if (user.banned_permanently) throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁');
      if (user.trade_ban_until && new Date(user.trade_ban_until) > new Date()) {
        throw new AppError(ERR.TRADE_BANNED, `账号处于限制交易状态，解禁时间：${new Date(user.trade_ban_until).toLocaleString('zh-CN')}`, {
          until: user.trade_ban_until, appealAvailable: true,
        });
      }
      const permissions = await creditService.getPermissions(req.schoolId, req.user.id);
      if (!permissions.canTrade) {
        throw new AppError(ERR.CREDIT_NOT_ALLOWED, '信誉分过低，当前仅可浏览，无法交易', {
          score: permissions.score, tier: permissions.tier, path: '/credit',
        });
      }
      req.creditPermissions = permissions;
      return next();
    } catch (err) {
      return next(err);
    }
  };
}
