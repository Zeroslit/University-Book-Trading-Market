// 违禁词路由：/api/v1/words（检测预检）、/api/v1/admin/banned-words（词库维护）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requireSchoolModerator, PLATFORM_ROLES, requireRoles } from '../../middleware/rbac.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { parsePagination } from '../../lib/pagination.js';
import { wordService } from '../../services/word.service.js';
import { auditService } from '../../services/audit.service.js';

export const wordsRouter = Router();
ensureNumericId(wordsRouter);
export const adminWordsRouter = Router();
ensureNumericId(adminWordsRouter);
wordsRouter.use(authenticate, schoolScope);
adminWordsRouter.use(authenticate, schoolScope);

// 发布前预检：返回命中词、级别、位置与处置建议（前端可直接提示用户）
wordsRouter.post('/check', rateLimit('publish'), validateBody(z.object({
  text: z.string().min(1).max(5000),
  scene: z.enum(['book', 'thread', 'reply', 'message', 'bio', 'chat']).optional(),
})), asyncHandler(async (req, res) => {
  const decision = await wordService.check({ schoolId: req.schoolId, text: req.body.text });
  return ok(res, {
    level: decision.level,
    action: decision.action,
    blocked: decision.blocked,
    maskedText: decision.text,
    hits: decision.hits.map((h) => ({ word: h.word, level: h.level, position: h.position, matchedText: h.matchedText })),
    scoreDelta: decision.scoreDelta,
    message: decision.hits.length ? wordService.buildBlockMessage(decision) : '未发现违规内容',
  });
}));

adminWordsRouter.get('/', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const list = await wordService.listWords({
    schoolId: req.schoolId, level: req.query.level ?? null, status: req.query.status ?? null,
  });
  return ok(res, list);
}));

adminWordsRouter.post('/', requireSchoolModerator(), validateBody(z.object({
  word: z.string().min(1).max(120),
  level: z.enum(['L1', 'L2', 'L3', 'L4']),
  category: z.string().max(40).optional(),
  matchType: z.enum(['keyword', 'regex']).optional(),
  scope: z.enum(['global', 'school']).optional(),
  status: z.enum(['active', 'disabled', 'whitelist']).optional(),
  action: z.enum(['hint', 'mask', 'block', 'delete']).optional(),
  scoreDelta: z.number().int().min(-100).max(0).optional(),
  remark: z.string().max(255).optional(),
})), asyncHandler(async (req, res) => {
  const scope = req.body.scope ?? 'school';
  if (scope === 'global' && !PLATFORM_ROLES.includes(req.user.role)) {
    throw new Error('只有平台管理员可以维护全局词库');
  }
  const created = await wordService.createWord({ ...req.body, scope, schoolId: scope === 'school' ? req.schoolId : null }, { actorId: req.user.id });
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'banned_word.create', targetType: 'banned_word', targetId: created.id, detail: { word: created.word, level: created.level }, ip: req.ip });
  return ok(res, created, '词条已创建');
}));

adminWordsRouter.patch('/:id', requireSchoolModerator(), validateBody(z.object({
  word: z.string().min(1).max(120).optional(),
  level: z.enum(['L1', 'L2', 'L3', 'L4']).optional(),
  category: z.string().max(40).optional(),
  matchType: z.enum(['keyword', 'regex']).optional(),
  action: z.enum(['hint', 'mask', 'block', 'delete']).optional(),
  scoreDelta: z.number().int().min(-100).max(0).optional(),
  status: z.enum(['active', 'disabled', 'whitelist']).optional(),
  remark: z.string().max(255).optional(),
})), asyncHandler(async (req, res) => ok(res, await wordService.updateWord(Number(req.params.id), req.body, { schoolId: req.schoolId }), '词条已更新')));

adminWordsRouter.delete('/:id', requireRoles(PLATFORM_ROLES.concat(['school_admin', 'support'])), asyncHandler(async (req, res) => ok(res, await wordService.deleteWord(Number(req.params.id), { actorId: req.user.id }), '词条已删除')));

adminWordsRouter.get('/hits', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const data = await wordService.listHits({
    schoolId: req.schoolId,
    userId: req.query.userId ? Number(req.query.userId) : null,
    level: req.query.level ?? null, page, pageSize,
  });
  return ok(res, paged(data.list, data.total, page, pageSize));
}));
