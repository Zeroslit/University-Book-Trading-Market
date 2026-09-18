// AI 客服路由：/api/v1/chat
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { aiCsService } from '../../services/ai-cs.service.js';

export const chatRouter = Router();
ensureNumericId(chatRouter);
chatRouter.use(authenticate, schoolScope);

chatRouter.post('/sessions', asyncHandler(async (req, res) => ok(res, await aiCsService.startSession({
  schoolId: req.schoolId, userId: req.user.id, channel: 'ai',
}), '会话已创建')));

chatRouter.get('/sessions/:id', asyncHandler(async (req, res) => ok(res, await aiCsService.sessionMessages({
  schoolId: req.schoolId, userId: req.user.id, sessionId: Number(req.params.id),
}))));

chatRouter.post('/sessions/:id/messages', rateLimit('publish'), validateBody(z.object({
  content: z.string().min(1).max(1000),
})), asyncHandler(async (req, res) => ok(res, await aiCsService.handleUserMessage({
  schoolId: req.schoolId, userId: req.user.id, sessionId: Number(req.params.id), content: req.body.content,
}))));

chatRouter.post('/sessions/:id/transfer', asyncHandler(async (req, res) => ok(res, await aiCsService.transferToHuman({
  schoolId: req.schoolId, userId: req.user.id, sessionId: Number(req.params.id),
  reason: req.body?.reason ?? '用户主动要求转人工',
}), '已转人工客服')));
