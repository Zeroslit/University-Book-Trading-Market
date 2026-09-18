// 论坛路由：/api/v1/threads 与 /api/v1/replies（求书帖 / 转让帖 / 评论回复）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requireVerified, requirePublishPermission } from '../../middleware/guards.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { q, q1, run, withTransaction } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { parsePagination } from '../../lib/pagination.js';
import { wordService } from '../../services/word.service.js';
import { AppError, ERR } from '../../lib/errors.js';

export const threadsRouter = Router();
ensureNumericId(threadsRouter);
export const repliesRouter = Router();
ensureNumericId(repliesRouter);
threadsRouter.use(authenticate, schoolScope);
repliesRouter.use(authenticate, schoolScope);

threadsRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const where = ["t.school_id = ?", "t.status = 'published'", 't.deleted_at IS NULL'];
  const params = [req.schoolId];
  if (req.query.type) { where.push('t.type = ?'); params.push(req.query.type); }
  if (req.query.category) { where.push('t.category = ?'); params.push(req.query.category); }
  if (req.query.keyword) { where.push('(t.title LIKE ? OR t.content LIKE ?)'); params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`); }
  const list = await q(
    pool,
    `SELECT t.id, t.type, t.title, t.category, t.view_count, t.reply_count, t.created_at,
            u.id AS author_id, u.nickname AS author_nickname, u.credit_score AS author_credit,
            (SELECT url FROM thread_images i WHERE i.thread_id = t.id ORDER BY sort_order ASC LIMIT 1) AS cover_url
     FROM threads t JOIN users u ON u.id = t.author_id
     WHERE ${where.join(' AND ')} ORDER BY t.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM threads t WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

threadsRouter.get('/:id', asyncHandler(async (req, res) => {
  const thread = await q1(
    pool,
    `SELECT t.*, u.nickname AS author_nickname, u.credit_score AS author_credit, u.verification_status AS author_verified
     FROM threads t JOIN users u ON u.id = t.author_id
     WHERE t.id = ? AND t.school_id = ? AND t.deleted_at IS NULL`,
    [Number(req.params.id), req.schoolId],
  );
  if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在或不属于本校');
  const images = await q(pool, 'SELECT url FROM thread_images WHERE thread_id = ? ORDER BY sort_order ASC', [thread.id]);
  const replies = await q(
    pool,
    `SELECT r.id, r.parent_id, r.floor_no, r.content, r.status, r.created_at,
            u.id AS author_id, u.nickname AS author_nickname, u.credit_score AS author_credit
     FROM replies r JOIN users u ON u.id = r.author_id
     WHERE r.thread_id = ? AND r.school_id = ? AND r.deleted_at IS NULL AND r.status = 'published'
     ORDER BY r.floor_no ASC LIMIT 200`,
    [thread.id, req.schoolId],
  );
  await run(pool, 'UPDATE threads SET view_count = view_count + 1 WHERE id = ?', [thread.id]);
  return ok(res, { ...thread, images, replies, isMine: Number(thread.author_id) === Number(req.user.id) });
}));

threadsRouter.post('/', rateLimit('publish'), requireVerified(), requirePublishPermission(), validateBody(z.object({
  type: z.enum(['seek', 'sell']),
  title: z.string().min(4).max(200),
  content: z.string().min(4).max(5000),
  category: z.string().max(40).optional(),
  images: z.array(z.string().max(500)).max(9).optional(),
})), asyncHandler(async (req, res) => {
  const body = req.body;
  const decision = await wordService.enforce({
    schoolId: req.schoolId, userId: req.user.id, scene: 'thread', targetType: 'thread',
    text: `${body.title}\n${body.content}`,
  });
  const threadId = await withTransaction(async (conn) => {
    const result = await run(
      conn,
      `INSERT INTO threads (school_id, author_id, type, title, content, category, status, word_hit_level)
       VALUES (?, ?, ?, ?, ?, ?, 'published', ?)`,
      [req.schoolId, req.user.id, body.type, body.title, body.content, body.category ?? null, decision.level],
    );
    const images = body.images || [];
    for (let i = 0; i < images.length; i += 1) {
      await run(conn, 'INSERT INTO thread_images (thread_id, school_id, url, sort_order) VALUES (?, ?, ?, ?)',
        [result.insertId, req.schoolId, images[i], i + 1]);
    }
    return result.insertId;
  });
  return ok(res, { threadId, wordHits: decision.hits.map((h) => ({ word: h.word, level: h.level })) }, '发布成功');
}));

threadsRouter.patch('/:id', validateBody(z.object({
  title: z.string().min(4).max(200).optional(),
  content: z.string().min(4).max(5000).optional(),
})), asyncHandler(async (req, res) => {
  const thread = await q1(pool, 'SELECT * FROM threads WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在');
  if (Number(thread.author_id) !== Number(req.user.id)) throw new AppError(ERR.FORBIDDEN, '只能编辑自己的帖子');
  const decision = await wordService.enforce({
    schoolId: req.schoolId, userId: req.user.id, scene: 'thread', targetType: 'thread', targetId: thread.id,
    text: `${req.body.title ?? thread.title}\n${req.body.content ?? thread.content}`,
  });
  await run(pool, 'UPDATE threads SET title = ?, content = ?, word_hit_level = ? WHERE id = ? AND school_id = ?',
    [req.body.title ?? thread.title, req.body.content ?? thread.content, decision.level, thread.id, req.schoolId]);
  return ok(res, { threadId: thread.id, updated: true });
}));

threadsRouter.delete('/:id', asyncHandler(async (req, res) => {
  const thread = await q1(pool, 'SELECT * FROM threads WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在');
  const isOwner = Number(thread.author_id) === Number(req.user.id);
  const isModerator = ['school_admin', 'support', 'platform_admin'].includes(req.user.role);
  if (!isOwner && !isModerator) throw new AppError(ERR.FORBIDDEN, '无权删除该帖子');
  await run(pool, "UPDATE threads SET status = 'deleted', deleted_at = NOW(3) WHERE id = ? AND school_id = ?", [thread.id, req.schoolId]);
  return ok(res, { threadId: thread.id, deleted: true }, '已删除');
}));

// 评论 / 楼中楼回复
threadsRouter.post('/:id/replies', rateLimit('publish'), requireVerified(), requirePublishPermission(), validateBody(z.object({
  content: z.string().min(1).max(2000),
  parentId: z.number().int().positive().optional(),
})), asyncHandler(async (req, res) => {
  const thread = await q1(pool, "SELECT * FROM threads WHERE id = ? AND school_id = ? AND status = 'published' AND deleted_at IS NULL", [Number(req.params.id), req.schoolId]);
  if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在或已关闭');

  if (req.body.parentId) {
    const parent = await q1(pool, 'SELECT id FROM replies WHERE id = ? AND thread_id = ? AND school_id = ?', [req.body.parentId, thread.id, req.schoolId]);
    if (!parent) throw new AppError(ERR.NOT_FOUND, '回复的目标评论不存在');
  }

  const decision = await wordService.enforce({
    schoolId: req.schoolId, userId: req.user.id, scene: 'reply', targetType: 'thread', targetId: thread.id,
    text: req.body.content,
  });

  const replyId = await withTransaction(async (conn) => {
    const floor = await q1(conn, 'SELECT COALESCE(MAX(floor_no), 0) + 1 AS next FROM replies WHERE thread_id = ?', [thread.id]);
    const result = await run(
      conn,
      `INSERT INTO replies (school_id, thread_id, author_id, parent_id, floor_no, content, status)
       VALUES (?, ?, ?, ?, ?, ?, 'published')`,
      [req.schoolId, thread.id, req.user.id, req.body.parentId ?? null, Number(floor.next), decision.text],
    );
    await run(conn, 'UPDATE threads SET reply_count = reply_count + 1 WHERE id = ?', [thread.id]);
    return result.insertId;
  });

  return ok(res, { replyId, floorNo: null }, '评论成功');
}));

repliesRouter.delete('/:id', asyncHandler(async (req, res) => {
  const reply = await q1(pool, 'SELECT * FROM replies WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!reply) throw new AppError(ERR.NOT_FOUND, '评论不存在');
  const isOwner = Number(reply.author_id) === Number(req.user.id);
  const isModerator = ['school_admin', 'support', 'platform_admin'].includes(req.user.role);
  if (!isOwner && !isModerator) throw new AppError(ERR.FORBIDDEN, '无权删除该评论');
  await withTransaction(async (conn) => {
    await run(conn, "UPDATE replies SET status = 'deleted', deleted_at = NOW(3) WHERE id = ? AND school_id = ?", [reply.id, req.schoolId]);
    await run(conn, 'UPDATE threads SET reply_count = GREATEST(reply_count - 1, 0) WHERE id = ?', [reply.thread_id]);
  });
  return ok(res, { replyId: reply.id, deleted: true }, '已删除');
}));
