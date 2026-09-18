// 学生认证路由：/api/v1/verifications
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requireSchoolModerator } from '../../middleware/rbac.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { q, q1, run, withTransaction } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { notifyService } from '../../services/notify.service.js';
import { auditService } from '../../services/audit.service.js';
import { maskEmail } from '../../lib/mask.js';
import { AppError, ERR } from '../../lib/errors.js';
import { parsePagination } from '../../lib/pagination.js';

export const verificationsRouter = Router();
ensureNumericId(verificationsRouter);
verificationsRouter.use(authenticate, schoolScope);

// 提交认证：支持 学生证图片 / 校园邮箱 两种方式
verificationsRouter.post('/', rateLimit('publish'), validateBody(z.object({
  method: z.enum(['student_card', 'campus_email']),
  studentCardImageUrl: z.string().max(500).optional(),
  campusEmail: z.string().email().max(120).optional(),
})), asyncHandler(async (req, res) => {
  const { method, studentCardImageUrl, campusEmail } = req.body;
  if (method === 'student_card' && !studentCardImageUrl) throw new AppError(ERR.VALIDATION_ERROR, '请上传学生证照片');
  if (method === 'campus_email' && !campusEmail) throw new AppError(ERR.VALIDATION_ERROR, '请填写校园邮箱');

  const pending = await q1(pool, "SELECT id FROM user_verifications WHERE user_id = ? AND status = 'pending'", [req.user.id]);
  if (pending) throw new AppError(ERR.CONFLICT, '你已有待审核的认证申请，请耐心等待');

  const result = await withTransaction(async (conn) => {
    const r = await run(
      conn,
      `INSERT INTO user_verifications (user_id, school_id, method, student_card_image_url, campus_email, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [req.user.id, req.schoolId, method, studentCardImageUrl ?? null, campusEmail ?? null],
    );
    await run(conn, "UPDATE users SET verification_status = 'pending' WHERE id = ? AND school_id = ?", [req.user.id, req.schoolId]);
    return r.insertId;
  });

  return ok(res, { verificationId: result, status: 'pending' }, '认证材料已提交，审核结果将通过站内信通知');
}));

verificationsRouter.get('/me', asyncHandler(async (req, res) => {
  const rows = await q(
    pool,
    `SELECT id, method, student_card_image_url, campus_email, status, review_note, submitted_at, reviewed_at
     FROM user_verifications WHERE user_id = ? AND school_id = ? ORDER BY id DESC`,
    [req.user.id, req.schoolId],
  );
  return ok(res, rows.map((r) => ({ ...r, campus_email: r.campus_email ? maskEmail(r.campus_email) : null })));
}));

// 审核队列（本校）：校管/客服/平台
verificationsRouter.get('/', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const status = req.query.status || 'pending';
  const list = await q(
    pool,
    `SELECT v.id, v.user_id, v.method, v.student_card_image_url, v.campus_email, v.status, v.submitted_at,
            u.nickname, u.student_no_mask, u.credit_score
     FROM user_verifications v JOIN users u ON u.id = v.user_id
     WHERE v.school_id = ? AND v.status = ? ORDER BY v.id ASC LIMIT ? OFFSET ?`,
    [req.schoolId, status, pageSize, offset],
  );
  const total = await q1(pool, 'SELECT COUNT(*) AS total FROM user_verifications WHERE school_id = ? AND status = ?', [req.schoolId, status]);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

verificationsRouter.post('/:id/review', requireSchoolModerator(), validateBody(z.object({
  approve: z.boolean(),
  note: z.string().max(255).optional(),
})), asyncHandler(async (req, res) => {
  const { approve, note } = req.body;
  const verification = await q1(pool, 'SELECT * FROM user_verifications WHERE id = ? AND school_id = ?', [Number(req.params.id), req.schoolId]);
  if (!verification) throw new AppError(ERR.NOT_FOUND, '认证记录不存在');
  if (verification.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, '该认证已审核');

  await withTransaction(async (conn) => {
    await run(conn, 'UPDATE user_verifications SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = NOW(3) WHERE id = ?',
      [approve ? 'approved' : 'rejected', req.user.id, note ?? null, verification.id]);
    await run(conn, "UPDATE users SET verification_status = ? WHERE id = ? AND school_id = ?",
      [approve ? 'approved' : 'rejected', verification.user_id, req.schoolId]);
  });

  await notifyService.notify(verification.user_id, {
    schoolId: req.schoolId, type: 'verification',
    title: approve ? '学生认证已通过' : '学生认证未通过',
    content: approve ? '认证通过，现在可以发布教材并交易了' : `认证未通过：${note || '材料不清晰，请重新提交'}`,
    relatedType: 'user_verification', relatedId: verification.id,
  });
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'verification.review', targetType: 'user_verification', targetId: verification.id, detail: { approve, note }, ip: req.ip });
  return ok(res, { verificationId: verification.id, status: approve ? 'approved' : 'rejected' }, approve ? '已通过认证' : '已驳回认证');
}));
