// 认证路由：/api/v1/auth
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate, revokeToken } from '../../middleware/auth.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { q1 } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { authService } from './auth.service.js';

const phone = z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确');
const password = z.string().min(8, '密码至少 8 位').max(32, '密码最多 32 位');
const code = z.string().length(6, '验证码为 6 位数字');

export const authRouter = Router();
ensureNumericId(authRouter);

authRouter.post('/sms/send', rateLimit('sms'), validateBody(z.object({
  phone, scene: z.enum(['register', 'login', 'reset', 'bind', 'unbind']),
})), asyncHandler(async (req, res) => {
  const data = await authService.sendSms({ phone: req.body.phone, scene: req.body.scene, ip: req.ip });
  return ok(res, data, '验证码已发送');
}));

authRouter.post('/register', rateLimit('login'), validateBody(z.object({
  schoolId: z.number().int().positive({ message: '请选择学校' }),
  studentNo: z.string().min(4, '学号至少 4 位').max(32),
  phone, code, password,
  nickname: z.string().min(1).max(30).optional(),
  realName: z.string().min(2).max(30).optional(),
})), asyncHandler(async (req, res) => ok(res, await authService.register(req.body), '注册成功')));

authRouter.post('/login', rateLimit('login'), validateBody(z.object({ phone, password })), asyncHandler(async (req, res) => ok(res, await authService.login(req.body), '登录成功')));

authRouter.post('/login/wechat', rateLimit('login'), validateBody(z.object({ code: z.string().min(1) })), asyncHandler(async (req, res) => ok(res, await authService.loginWechat(req.body), '登录成功')));

authRouter.post('/refresh', validateBody(z.object({ refreshToken: z.string().min(10) })), asyncHandler(async (req, res) => ok(res, await authService.refresh(req.body))));

authRouter.post('/logout', authenticate, asyncHandler(async (req, res) => {
  await revokeToken(req.accessToken);
  return ok(res, { loggedOut: true }, '已退出登录');
}));

authRouter.post('/password/reset', authenticate, rateLimit('login'), validateBody(z.object({ phone, code, newPassword: password })), asyncHandler(async (req, res) => ok(res, await authService.changePassword({ userId: req.user.id, ...req.body }), '密码已更新')));

authRouter.post('/wechat/bind', authenticate, validateBody(z.object({ code: z.string().min(1) })), asyncHandler(async (req, res) => ok(res, await authService.bindWechat({ userId: req.user.id, code: req.body.code }))));

// 当前登录用户 + 学校信息：登录后前端据此直接进入本校图书库与论坛
authRouter.get('/me', authenticate, asyncHandler(async (req, res) => {
  const user = await authService.getUserForToken(req.user.id);
  const school = user.school_id
    ? await q1(pool, 'SELECT id, name, province, city, status, forum_sections, service_fee_bps, require_student_verification, cross_school_enabled, cross_school_mode FROM schools WHERE id = ?', [user.school_id])
    : null;
  const wallet = await q1(pool, 'SELECT balance_cents, frozen_cents FROM wallet_accounts WHERE user_id = ?', [user.id]);
  return ok(res, {
    user: authService.toProfile(user),
    school,
    wallet: { balanceCents: Number(wallet?.balance_cents || 0), frozenCents: Number(wallet?.frozen_cents || 0) },
  });
}));
