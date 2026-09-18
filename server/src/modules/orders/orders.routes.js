// 订单路由：/api/v1/orders（资金托管全流程）
// 注意：封禁期间进行中的订单必须仍可完成或退款，因此除「下单」外不加交易准入拦截
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requireVerified, requireTradePermission } from '../../middleware/guards.js';
import { requireRoles, SUPPORT_ROLES, MODERATOR_ROLES } from '../../middleware/rbac.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { getIdempotencyKey } from '../../lib/idempotency.js';
import { parsePagination } from '../../lib/pagination.js';
import { orderService } from '../../services/order.service.js';

export const ordersRouter = Router();
ensureNumericId(ordersRouter);
ordersRouter.use(authenticate, schoolScope);

const idemKey = (req, prefix) => `${prefix}:${req.user.id}:${getIdempotencyKey(req) || `auto:${Date.now()}`}`;

ordersRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const role = req.query.role === 'seller' ? 'seller' : 'buyer';
  const data = await orderService.list({
    schoolId: req.schoolId, userId: req.user.id, role,
    status: req.query.status ?? null, page, pageSize,
  });
  return ok(res, paged(data.list, data.total, page, pageSize));
}));

ordersRouter.post('/', rateLimit('order'), requireVerified(), requireTradePermission(), validateBody(z.object({
  bookId: z.number().int().positive(),
  shipMode: z.enum(['meetup', 'mail']).optional(),
  remark: z.string().max(500).optional(),
})), asyncHandler(async (req, res) => ok(res, await orderService.create({
  schoolId: req.schoolId, buyerId: req.user.id, bookId: req.body.bookId,
  shipMode: req.body.shipMode ?? 'meetup', remark: req.body.remark ?? null,
  idempotencyKey: idemKey(req, 'order.create'),
}), '下单成功，请在 30 分钟内完成支付')));

ordersRouter.get('/:id', asyncHandler(async (req, res) => ok(res, await orderService.detail({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id, role: req.user.role,
}))));

ordersRouter.post('/:id/pay', rateLimit('order'), asyncHandler(async (req, res) => ok(res, await orderService.pay({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id,
  idempotencyKey: idemKey(req, 'order.pay'),
}), '支付成功（模拟），资金已进入托管')));

ordersRouter.post('/:id/cancel', asyncHandler(async (req, res) => ok(res, await orderService.cancel({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id,
  reason: req.body?.reason ?? '买家取消订单',
}), '订单已取消')));

ordersRouter.post('/:id/ship', validateBody(z.object({
  expressCompany: z.string().max(60).optional(),
  expressNo: z.string().max(60).optional(),
})), asyncHandler(async (req, res) => ok(res, await orderService.ship({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id,
  expressCompany: req.body.expressCompany ?? null, expressNo: req.body.expressNo ?? null,
}), '已发货，7 天后将自动确认收货')));

ordersRouter.post('/:id/confirm', rateLimit('order'), asyncHandler(async (req, res) => ok(res, await orderService.confirm({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id,
  idempotencyKey: idemKey(req, 'order.confirm'),
}), '已确认收货，货款已放给卖家')));

ordersRouter.post('/:id/refund-request', validateBody(z.object({ reason: z.string().min(2).max(500) })), asyncHandler(async (req, res) => ok(res, await orderService.requestRefund({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id, reason: req.body.reason,
}), '退款申请已提交')));

ordersRouter.post('/:id/return-request', validateBody(z.object({ reason: z.string().min(2).max(500) })), asyncHandler(async (req, res) => ok(res, await orderService.requestReturn({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id, reason: req.body.reason,
}), '退货退款申请已提交')));

ordersRouter.post('/:id/refund/agree', asyncHandler(async (req, res) => ok(res, await orderService.agreeRefund({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id,
  reason: req.body?.reason ?? '卖家同意退款',
}), '已退款，托管资金已退回买家')));

ordersRouter.post('/:id/refund/reject', validateBody(z.object({ reason: z.string().min(2).max(500) })), asyncHandler(async (req, res) => ok(res, await orderService.rejectRefund({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id, reason: req.body.reason,
}), '已拒绝退款，买家可发起争议')));

ordersRouter.post('/:id/dispute', validateBody(z.object({ reason: z.string().min(2).max(500) })), asyncHandler(async (req, res) => ok(res, await orderService.dispute({
  schoolId: req.schoolId, orderId: Number(req.params.id), userId: req.user.id, reason: req.body.reason,
}), '已进入争议，资金冻结并由客服仲裁')));

// 人工客服仲裁：强制放款 / 强制退款
ordersRouter.post('/:id/arbitrate', requireRoles(SUPPORT_ROLES), validateBody(z.object({
  action: z.enum(['release', 'refund']),
  reason: z.string().min(2).max(500),
})), asyncHandler(async (req, res) => ok(res, await orderService.arbitrate({
  schoolId: req.schoolId, orderId: Number(req.params.id), staffId: req.user.id,
  action: req.body.action, reason: req.body.reason,
}), '仲裁已完成，资金已按裁定处理')));
