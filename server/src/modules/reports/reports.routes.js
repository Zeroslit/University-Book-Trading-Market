// 举报/申诉路由：/api/v1/reports、/api/v1/appeals
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
import { generateNo } from '../../lib/crypto.js';
import { parsePagination } from '../../lib/pagination.js';
import { reportService } from '../../services/report.service.js';
import { penaltyService } from '../../services/penalty.service.js';
import { notifyService } from '../../services/notify.service.js';
import { auditService } from '../../services/audit.service.js';
import { configService } from '../../services/config.service.js';
import { AppError, ERR } from '../../lib/errors.js';

export const reportsRouter = Router();
ensureNumericId(reportsRouter);
export const appealsRouter = Router();
ensureNumericId(appealsRouter);
reportsRouter.use(authenticate, schoolScope);
appealsRouter.use(authenticate, schoolScope);

reportsRouter.post('/', rateLimit('publish'), validateBody(z.object({
  targetType: z.enum(['book', 'thread', 'reply', 'message', 'user', 'order']),
  targetId: z.number().int().positive(),
  reason: z.string().min(2).max(60),
  description: z.string().max(1000).optional(),
  evidence: z.array(z.string().max(500)).max(9).optional(),
})), asyncHandler(async (req, res) => ok(res, await reportService.create({
  schoolId: req.schoolId, reporterId: req.user.id,
  targetType: req.body.targetType, targetId: req.body.targetId,
  reason: req.body.reason, description: req.body.description ?? null, evidence: req.body.evidence ?? null,
}), '举报已提交，我们会尽快受理')));

reportsRouter.get('/', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const data = await reportService.list({ schoolId: req.schoolId, status: req.query.status ?? null, page, pageSize });
  return ok(res, paged(data.list, data.total, page, pageSize));
}));

reportsRouter.get('/stats', requireSchoolModerator(), asyncHandler(async (req, res) => ok(res, await reportService.stats({ schoolId: req.schoolId }))));

reportsRouter.get('/:id', requireSchoolModerator(), asyncHandler(async (req, res) => ok(res, await reportService.detail({
  schoolId: req.schoolId, reportId: Number(req.params.id), viewer: { ...req.user, ip: req.ip },
}))));

reportsRouter.post('/:id/accept', requireSchoolModerator(), asyncHandler(async (req, res) => ok(res, await reportService.accept({
  schoolId: req.schoolId, reportId: Number(req.params.id), handlerId: req.user.id,
}), '已受理，已通知被投诉人 48 小时内举证')));

reportsRouter.post('/:id/proof', validateBody(z.object({ content: z.string().min(2).max(1000) })), asyncHandler(async (req, res) => ok(res, await reportService.submitProof({
  schoolId: req.schoolId, reportId: Number(req.params.id), userId: req.user.id, content: req.body.content,
}), '举证已提交')));

reportsRouter.post('/:id/decide', requireSchoolModerator(), validateBody(z.object({
  decision: z.enum(['valid', 'invalid']),
  note: z.string().min(2).max(500),
  severity: z.enum(['light', 'serious', 'severe']).optional(),
  type: z.enum(['warning', 'mute', 'trade_ban', 'login_ban', 'permanent_ban']).optional(),
  days: z.number().int().min(0).max(3650).nullable().optional(),
})), asyncHandler(async (req, res) => ok(res, await reportService.decide({
  schoolId: req.schoolId, reportId: Number(req.params.id), handlerId: req.user.id,
  decision: req.body.decision, note: req.body.note, severity: req.body.severity ?? 'light',
  type: req.body.type ?? null, days: req.body.days ?? null,
}), req.body.decision === 'valid' ? '已裁定成立并执行处罚' : '已裁定不成立')));

// ---------------- 申诉 ----------------
appealsRouter.post('/', validateBody(z.object({
  penaltyId: z.number().int().positive(),
  reason: z.string().min(5).max(1500),
  evidence: z.array(z.string().max(500)).max(9).optional(),
})), asyncHandler(async (req, res) => {
  const penalty = await q1(pool, 'SELECT * FROM penalties WHERE id = ? AND school_id = ? AND user_id = ?', [req.body.penaltyId, req.schoolId, req.user.id]);
  if (!penalty) throw new AppError(ERR.NOT_FOUND, '处罚记录不存在');
  if (penalty.status === 'revoked') throw new AppError(ERR.CONFLICT, '该处罚已被撤销');
  if (penalty.appeal_status === 'pending') throw new AppError(ERR.CONFLICT, '你已提交过申诉，请等待复审');

  const appealDays = Number(await configService.get('report.appeal_days', req.schoolId));
  const deadline = penalty.created_at ? new Date(new Date(penalty.created_at).getTime() + appealDays * 86400000) : null;
  if (deadline && deadline < new Date() && penalty.type !== 'permanent_ban') {
    throw new AppError(ERR.CONFLICT, `申诉期为 ${appealDays} 天，已过期。如有新证据请联系人工客服`);
  }

  const result = await withTransaction(async (conn) => {
    const r = await run(
      conn,
      `INSERT INTO appeals (appeal_no, school_id, user_id, penalty_id, reason, status)
       VALUES (?, ?, ?, ?, ?, 'pending')`,
      [generateNo('AP'), req.schoolId, req.user.id, penalty.id, req.body.reason],
    );
    await run(conn, "UPDATE penalties SET appeal_status = 'pending' WHERE id = ?", [penalty.id]);
    return r.insertId;
  });
  return ok(res, { appealId: result, status: 'pending' }, '申诉已提交，复审结果将通过站内信通知');
}));

appealsRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const isModerator = ['school_admin', 'support', 'platform_admin'].includes(req.user.role);
  const where = ['school_id = ?'];
  const params = [req.schoolId];
  if (!isModerator) { where.push('user_id = ?'); params.push(req.user.id); }
  if (req.query.status) { where.push('status = ?'); params.push(req.query.status); }
  const list = await q(
    pool,
    `SELECT id, appeal_no, user_id, penalty_id, reason, status, review_note, reviewed_at, created_at
     FROM appeals WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM appeals WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

// 复审：通过 -> 撤销处罚并回滚信誉分
appealsRouter.post('/:id/review', requireSchoolModerator(), validateBody(z.object({
  approve: z.boolean(),
  note: z.string().min(2).max(500),
})), asyncHandler(async (req, res) => {
  const appeal = await q1(pool, 'SELECT * FROM appeals WHERE id = ? AND school_id = ?', [Number(req.params.id), req.schoolId]);
  if (!appeal) throw new AppError(ERR.NOT_FOUND, '申诉不存在');
  if (appeal.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, '该申诉已复审');

  const result = await withTransaction(async (conn) => {
    await run(conn, 'UPDATE appeals SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = NOW(3) WHERE id = ?',
      [req.body.approve ? 'approved' : 'rejected', req.user.id, req.body.note, appeal.id]);
    let revoked = null;
    if (req.body.approve && appeal.penalty_id) {
      revoked = await penaltyService.revoke({
        conn, penaltyId: appeal.penalty_id, reviewerId: req.user.id,
        reason: `申诉通过：${req.body.note}`, rollbackCredit: true,
      });
      await run(conn, "UPDATE penalties SET appeal_status = 'approved' WHERE id = ?", [appeal.penalty_id]);
    } else if (appeal.penalty_id) {
      await run(conn, "UPDATE penalties SET appeal_status = 'rejected' WHERE id = ?", [appeal.penalty_id]);
    }
    return revoked;
  });

  await notifyService.notify(appeal.user_id, {
    schoolId: req.schoolId, type: 'penalty',
    title: req.body.approve ? '申诉结果：通过' : '申诉结果：未通过',
    content: req.body.approve
      ? `你的申诉已通过，处罚已撤销，信誉分已回滚。说明：${req.body.note}`
      : `你的申诉未通过。说明：${req.body.note}`,
    relatedType: 'appeal', relatedId: appeal.id,
  });
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'appeal.review', targetType: 'appeal', targetId: appeal.id, detail: { approve: req.body.approve }, ip: req.ip });
  return ok(res, { appealId: appeal.id, approved: req.body.approve, revoked: result }, req.body.approve ? '已通过申诉并撤销处罚' : '已驳回申诉');
}));
