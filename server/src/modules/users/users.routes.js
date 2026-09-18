// 用户路由：/api/v1/users
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { q, q1, run } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { maskStudentNo, maskPhone } from '../../lib/mask.js';
import { creditService } from '../../services/credit.service.js';
import { wordService } from '../../services/word.service.js';
import { AppError, ERR } from '../../lib/errors.js';
import { parsePagination } from '../../lib/pagination.js';

export const usersRouter = Router();
ensureNumericId(usersRouter);
usersRouter.use(authenticate, schoolScope);

usersRouter.get('/me/profile', asyncHandler(async (req, res) => {
  const user = await q1(pool, 'SELECT id, school_id, student_no, student_no_mask, phone_last4, nickname, avatar_url, bio, real_name_mask, role, status, verification_status, credit_score, mute_until, trade_ban_until, login_ban_until, banned_permanently, created_at FROM users WHERE id = ?', [req.user.id]);
  return ok(res, {
    ...user,
    phoneMask: maskPhone(`000${user.phone_last4}`).replace(/^000/, ''),
    studentNoMask: user.student_no_mask || maskStudentNo(user.student_no),
    student_no: undefined,
  });
}));

usersRouter.patch('/me/profile', validateBody(z.object({
  nickname: z.string().min(1).max(30).optional(),
  avatarUrl: z.string().max(500).optional(),
  bio: z.string().max(200).optional(),
})), asyncHandler(async (req, res) => {
  const fields = [];
  const params = [];
  if (req.body.nickname) { fields.push('nickname = ?'); params.push(req.body.nickname); }
  if (req.body.avatarUrl) { fields.push('avatar_url = ?'); params.push(req.body.avatarUrl); }
  let maskedBio = null;
  if (req.body.bio !== undefined) {
    // 个人简介同样要过违禁词检测（L1 打码，L2/L3 拦截）
    const decision = await wordService.check({ schoolId: req.schoolId, text: req.body.bio });
    if (decision.blocked) {
      throw new AppError(ERR.CONTENT_BLOCKED, `个人简介包含不允许的内容：${decision.hits.map((h) => h.word).join('、')}`, {
        hits: decision.hits,
      });
    }
    maskedBio = decision.text;
    if (decision.hits.length > 0) await wordService.notifyBlocked({ schoolId: req.schoolId, userId: req.user.id, decision, scene: 'bio' });
    fields.push('bio = ?');
    params.push(maskedBio);
  }
  if (fields.length === 0) throw new AppError(ERR.VALIDATION_ERROR, '没有需要更新的字段');
  params.push(req.user.id, req.schoolId);
  await run(pool, `UPDATE users SET ${fields.join(', ')} WHERE id = ? AND school_id = ?`, params);
  return ok(res, { updated: true, bio: maskedBio });
}));

usersRouter.get('/me/credit', asyncHandler(async (req, res) => {
  const permissions = await creditService.getPermissions(req.schoolId, req.user.id);
  return ok(res, permissions);
}));

usersRouter.get('/me/credit/logs', asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  return ok(res, await creditService.listLogs(req.user.id, { page, pageSize }));
}));

// 他人公开资料：只暴露信誉分档位、成交量等非敏感信息
usersRouter.get('/:id/public', asyncHandler(async (req, res) => {
  const user = await q1(pool, 'SELECT id, nickname, avatar_url, credit_score, verification_status, school_id, created_at FROM users WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');
  const tier = await creditService.getTier(req.schoolId, user.credit_score);
  const stats = await q1(pool, "SELECT COUNT(*) AS sold FROM orders WHERE seller_id = ? AND school_id = ? AND status IN ('completed','arbitrated_release')", [user.id, req.schoolId]);
  const onSale = await q1(pool, "SELECT COUNT(*) AS total FROM books WHERE seller_id = ? AND school_id = ? AND status = 'on_sale'", [user.id, req.schoolId]);
  return ok(res, {
    id: user.id, nickname: user.nickname, avatarUrl: user.avatar_url,
    creditScore: user.credit_score, creditTier: tier, verified: user.verification_status === 'approved',
    soldCount: Number(stats.sold), onSaleCount: Number(onSale.total), joinedAt: user.created_at,
  });
}));
