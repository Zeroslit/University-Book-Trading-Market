// 客服工单路由：/api/v1/tickets
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requireSchoolModerator } from '../../middleware/rbac.js';
import { parsePagination } from '../../lib/pagination.js';
import { ticketService } from '../../services/ticket.service.js';
import { AppError, ERR } from '../../lib/errors.js';

export const ticketsRouter = Router();
ensureNumericId(ticketsRouter);
ticketsRouter.use(authenticate, schoolScope);

ticketsRouter.post('/', validateBody(z.object({
  type: z.enum(['order', 'refund', 'account', 'content', 'other']).optional(),
  subject: z.string().min(4).max(200),
  description: z.string().max(2000).optional(),
  relatedOrderId: z.number().int().positive().optional(),
})), asyncHandler(async (req, res) => ok(res, await ticketService.create({
  schoolId: req.schoolId, source: 'user', type: req.body.type ?? 'other',
  subject: req.body.subject, description: req.body.description ?? null,
  relatedOrderId: req.body.relatedOrderId ?? null, reporterId: req.user.id,
}), '工单已创建')));

ticketsRouter.get('/', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const data = await ticketService.list({
    schoolId: req.schoolId, status: req.query.status ?? null,
    assigneeId: req.query.assigneeId ? Number(req.query.assigneeId) : null,
    priority: req.query.priority ?? null, page, pageSize,
  });
  return ok(res, paged(data.list, data.total, page, pageSize));
}));

ticketsRouter.get('/stats', requireSchoolModerator(), asyncHandler(async (req, res) => ok(res, await ticketService.stats({ schoolId: req.schoolId }))));

ticketsRouter.get('/:id', asyncHandler(async (req, res) => {
  const data = await ticketService.detail({ schoolId: req.schoolId, ticketId: Number(req.params.id), viewer: { ...req.user, ip: req.ip } });
  const isModerator = ['school_admin', 'support', 'platform_admin'].includes(req.user.role);
  const isOwner = Number(data.ticket.reporter_id) === Number(req.user.id);
  if (!isModerator && !isOwner) throw new AppError(ERR.FORBIDDEN, '无权查看该工单');
  if (!isModerator) return ok(res, { ticket: data.ticket, logs: data.logs });
  return ok(res, data);
}));

ticketsRouter.post('/:id/claim', requireSchoolModerator(), asyncHandler(async (req, res) => ok(res, await ticketService.claim({
  schoolId: req.schoolId, ticketId: Number(req.params.id), staffId: req.user.id,
}), '接单成功')));

ticketsRouter.post('/:id/reply', requireSchoolModerator(), validateBody(z.object({
  content: z.string().min(1).max(1000),
  quickReplyKey: z.string().max(40).optional(),
})), asyncHandler(async (req, res) => ok(res, await ticketService.reply({
  schoolId: req.schoolId, ticketId: Number(req.params.id), staffId: req.user.id,
  content: req.body.content, quickReplyKey: req.body.quickReplyKey ?? null,
}), '已回复用户')));

ticketsRouter.post('/:id/resolve', requireSchoolModerator(), validateBody(z.object({
  resolution: z.string().min(2).max(1000),
})), asyncHandler(async (req, res) => ok(res, await ticketService.resolve({
  schoolId: req.schoolId, ticketId: Number(req.params.id), staffId: req.user.id, resolution: req.body.resolution,
}), '工单已处理完成')));

ticketsRouter.post('/:id/escalate', requireSchoolModerator(), validateBody(z.object({
  note: z.string().max(500).optional(),
})), asyncHandler(async (req, res) => ok(res, await ticketService.escalate({
  schoolId: req.schoolId, ticketId: Number(req.params.id), operatorId: req.user.id,
  note: req.body.note ?? '人工升级',
}), '工单已升级')));
