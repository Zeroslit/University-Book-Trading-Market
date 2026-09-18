// 登录态解析：JWT（access + refresh）+ Redis 黑名单（支持封禁即时踢下线）
import jwt from 'jsonwebtoken';
import { config } from '../config/index.js';
import { AppError, ERR } from '../lib/errors.js';
import { queryOne } from '../db/pool.js';
import { redis } from '../services/redis.service.js';

export function signTokens(user) {
  const payload = { sub: user.id, role: user.role, schoolId: user.school_id ?? null };
  const accessToken = jwt.sign(payload, config.jwt.secret, {
    expiresIn: config.jwt.accessTtl, issuer: config.jwt.issuer,
  });
  const refreshToken = jwt.sign({ ...payload, type: 'refresh' }, config.jwt.secret, {
    expiresIn: config.jwt.refreshTtl, issuer: config.jwt.issuer,
  });
  return { accessToken, refreshToken, expiresIn: config.jwt.accessTtl };
}

export function verifyToken(token) {
  try {
    return jwt.verify(token, config.jwt.secret, { issuer: config.jwt.issuer });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new AppError(ERR.TOKEN_EXPIRED, '登录已过期，请重新登录');
    throw new AppError(ERR.TOKEN_INVALID, '登录凭证无效');
  }
}

export async function revokeToken(token) {
  try {
    const payload = verifyToken(token);
    const ttl = Math.max(1, payload.exp - Math.floor(Date.now() / 1000));
    await redis.set(`jwt:blacklist:${token}`, '1', ttl);
  } catch {
    // 已过期或非法 token 无需入黑名单
  }
}

function extractToken(req) {
  const header = req.get('Authorization') || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

// 校验封禁开关：禁止登录 / 永久封禁（封禁不影响进行中的订单资金）
function assertNotLoginBanned(user) {
  if (user.banned_permanently) {
    throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁，可在「我的-违规记录」提交申诉', {
      reason: 'permanent_ban', until: null, appealAvailable: true, appealPath: '/appeals',
    });
  }
  if (user.login_ban_until && new Date(user.login_ban_until) > new Date()) {
    throw new AppError(ERR.LOGIN_BANNED, `账号已被禁止登录，解封时间：${new Date(user.login_ban_until).toLocaleString('zh-CN')}`, {
      reason: 'login_ban', until: user.login_ban_until, appealAvailable: true, appealPath: '/appeals',
    });
  }
}

export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    if (!token) throw new AppError(ERR.UNAUTHORIZED, '请先登录');
    if (await redis.get(`jwt:blacklist:${token}`)) throw new AppError(ERR.TOKEN_INVALID, '登录已失效，请重新登录');

    const payload = verifyToken(token);
    if (payload.type === 'refresh') throw new AppError(ERR.TOKEN_INVALID, '请使用 accessToken 访问接口');

    const user = await queryOne(
      `SELECT id, school_id, role, status, verification_status, credit_score, nickname,
              mute_until, trade_ban_until, login_ban_until, banned_permanently
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [payload.sub],
    );
    if (!user) throw new AppError(ERR.UNAUTHORIZED, '账号不存在或已注销');
    if (user.status === 'banned' && !user.banned_permanently && !user.login_ban_until) {
      throw new AppError(ERR.LOGIN_BANNED, '账号已被封禁，可在「我的-违规记录」提交申诉', { appealAvailable: true });
    }
    assertNotLoginBanned(user);

    req.user = {
      id: user.id,
      role: user.role,
      schoolId: user.school_id ?? null,
      verificationStatus: user.verification_status,
      creditScore: user.credit_score,
      nickname: user.nickname,
      muteUntil: user.mute_until,
      tradeBanUntil: user.trade_ban_until,
    };
    req.accessToken = token;
    next();
  } catch (err) {
    next(err);
  }
}

// 可选登录：公开接口也能拿到登录态（用于返回“我是否已收藏/已下单”等）
export async function optionalAuth(req, res, next) {
  const token = extractToken(req);
  if (!token) return next();
  return authenticate(req, res, next);
}
