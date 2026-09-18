// 通知路由：/api/v1/notifications
import { Router } from 'express';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { parsePagination } from '../../lib/pagination.js';
import { notifyService } from '../../services/notify.service.js';

export const notificationsRouter = Router();
ensureNumericId(notificationsRouter);
notificationsRouter.use(authenticate);

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const isRead = req.query.isRead === undefined ? null : String(req.query.isRead) === 'true';
  const list = await notifyService.list(req.user.id, { isRead, type: req.query.type ?? null, page, pageSize });
  return ok(res, paged(list, list.length, page, pageSize));
}));

notificationsRouter.get('/unread-count', asyncHandler(async (req, res) => ok(res, {
  unread: await notifyService.unreadCount(req.user.id),
})));

notificationsRouter.post('/read-all', asyncHandler(async (req, res) => {
  await notifyService.markRead(req.user.id, null);
  return ok(res, { readAll: true }, '已全部标记为已读');
}));

notificationsRouter.post('/:id/read', asyncHandler(async (req, res) => {
  await notifyService.markRead(req.user.id, Number(req.params.id));
  return ok(res, { read: true });
}));
