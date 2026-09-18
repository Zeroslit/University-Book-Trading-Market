// 知识库路由：/api/v1/kb/articles（AI 客服 FAQ 数据源）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRoles, PLATFORM_ROLES } from '../../middleware/rbac.js';
import { q, q1, run } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { parsePagination } from '../../lib/pagination.js';
import { AppError, ERR } from '../../lib/errors.js';

export const kbRouter = Router();
ensureNumericId(kbRouter);

// 检索（登录后可用；学校可看平台通用 + 本校知识）
kbRouter.get('/articles', authenticate, asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const schoolId = req.user.schoolId;
  const keyword = req.query.keyword ? `%${req.query.keyword}%` : null;
  const where = ["status = 'published'", '(school_id IS NULL OR school_id = ?)'];
  const params = [schoolId];
  if (keyword) { where.push('(question LIKE ? OR answer LIKE ? OR keywords LIKE ?)'); params.push(keyword, keyword, keyword); }
  const list = await q(pool, `SELECT id, category, question, answer, keywords FROM kb_articles WHERE ${where.join(' AND ')} ORDER BY id ASC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM kb_articles WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

kbRouter.get('/articles/:id', authenticate, asyncHandler(async (req, res) => {
  const article = await q1(pool, 'SELECT * FROM kb_articles WHERE id = ?', [Number(req.params.id)]);
  if (!article) throw new AppError(ERR.NOT_FOUND, '知识条目不存在');
  await run(pool, 'UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?', [article.id]);
  return ok(res, article);
}));

kbRouter.post('/articles', authenticate, requireRoles(PLATFORM_ROLES), validateBody(z.object({
  category: z.string().max(40).optional(),
  question: z.string().min(4).max(300),
  answer: z.string().min(4),
  keywords: z.string().max(300).optional(),
  schoolId: z.number().int().positive().nullable().optional(),
})), asyncHandler(async (req, res) => {
  const result = await run(
    pool,
    `INSERT INTO kb_articles (school_id, category, question, answer, keywords, status, updated_by)
     VALUES (?, ?, ?, ?, ?, 'published', ?)`,
    [req.body.schoolId ?? null, req.body.category ?? '通用', req.body.question, req.body.answer, req.body.keywords ?? null, req.user.id],
  );
  return ok(res, { articleId: result.insertId }, '知识条目已创建');
}));

kbRouter.patch('/articles/:id', authenticate, requireRoles(PLATFORM_ROLES), validateBody(z.object({
  category: z.string().max(40).optional(),
  question: z.string().min(4).max(300).optional(),
  answer: z.string().min(4).optional(),
  keywords: z.string().max(300).optional(),
  status: z.enum(['published', 'draft', 'offline']).optional(),
})), asyncHandler(async (req, res) => {
  const fields = [];
  const params = [];
  for (const key of ['category', 'question', 'answer', 'keywords', 'status']) {
    if (req.body[key] !== undefined) { fields.push(`${key} = ?`); params.push(req.body[key]); }
  }
  if (fields.length === 0) throw new AppError(ERR.VALIDATION_ERROR, '没有需要更新的字段');
  params.push(Number(req.params.id));
  await run(pool, `UPDATE kb_articles SET ${fields.join(', ')}, updated_by = ${Number(req.user.id)} WHERE id = ?`, params);
  return ok(res, { articleId: Number(req.params.id) }, '知识条目已更新');
}));

kbRouter.delete('/articles/:id', authenticate, requireRoles(PLATFORM_ROLES), asyncHandler(async (req, res) => {
  await run(pool, "UPDATE kb_articles SET status = 'offline' WHERE id = ?", [Number(req.params.id)]);
  return ok(res, { articleId: Number(req.params.id), status: 'offline' }, '知识条目已下线');
}));
