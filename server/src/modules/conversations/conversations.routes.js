// 私信路由：/api/v1/conversations
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requirePublishPermission } from '../../middleware/guards.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { q, q1, run, withTransaction } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { parsePagination } from '../../lib/pagination.js';
import { wordService } from '../../services/word.service.js';
import { notifyService } from '../../services/notify.service.js';
import { AppError, ERR } from '../../lib/errors.js';

export const conversationsRouter = Router();
ensureNumericId(conversationsRouter);
conversationsRouter.use(authenticate, schoolScope);

function contextKey(a, b, bookId, threadId) {
  return `${Math.min(a, b)}-${Math.max(a, b)}-${bookId || 0}-${threadId || 0}`;
}

conversationsRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const list = await q(
    pool,
    `SELECT c.id, c.book_id, c.thread_id, c.last_message_at, c.last_message_preview, c.status,
            CASE WHEN c.buyer_id = ? THEN c.seller_id ELSE c.buyer_id END AS peer_id,
            u.nickname AS peer_nickname, u.credit_score AS peer_credit,
            (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id AND m.receiver_id = ? AND m.is_read = 0) AS unread
     FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.buyer_id = ? THEN c.seller_id ELSE c.buyer_id END
     WHERE c.school_id = ? AND (c.buyer_id = ? OR c.seller_id = ?)
     ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT ? OFFSET ?`,
    [req.user.id, req.user.id, req.user.id, req.schoolId, req.user.id, req.user.id, pageSize, offset],
  );
  const total = await q1(pool, 'SELECT COUNT(*) AS total FROM conversations WHERE school_id = ? AND (buyer_id = ? OR seller_id = ?)', [req.schoolId, req.user.id, req.user.id]);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

// 基于图书或帖子发起私信（同一上下文自动复用会话）
conversationsRouter.post('/', rateLimit('publish'), validateBody(z.object({
  bookId: z.number().int().positive().optional(),
  threadId: z.number().int().positive().optional(),
  targetUserId: z.number().int().positive().optional(),
})), asyncHandler(async (req, res) => {
  const { bookId, threadId } = req.body;
  if (!bookId && !threadId) throw new AppError(ERR.VALIDATION_ERROR, '必须关联图书或帖子');

  let ownerId = req.body.targetUserId ?? null;
  if (bookId) {
    const book = await q1(pool, 'SELECT seller_id FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [bookId, req.schoolId]);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在或不属于本校');
    ownerId = book.seller_id;
  } else if (threadId) {
    const thread = await q1(pool, 'SELECT author_id FROM threads WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [threadId, req.schoolId]);
    if (!thread) throw new AppError(ERR.NOT_FOUND, '帖子不存在或不属于本校');
    ownerId = thread.author_id;
  }
  if (!ownerId) throw new AppError(ERR.VALIDATION_ERROR, '缺少沟通对象');
  if (Number(ownerId) === Number(req.user.id)) throw new AppError(ERR.VALIDATION_ERROR, '不能和自己发起会话');

  const key = contextKey(req.user.id, ownerId, bookId, threadId);
  const existed = await q1(pool, 'SELECT id FROM conversations WHERE school_id = ? AND context_key = ?', [req.schoolId, key]);
  if (existed) return ok(res, { conversationId: existed.id, reused: true });

  const result = await run(
    pool,
    `INSERT INTO conversations (school_id, buyer_id, seller_id, book_id, thread_id, context_key)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [req.schoolId, req.user.id, ownerId, bookId ?? null, threadId ?? null, key],
  );
  return ok(res, { conversationId: result.insertId, reused: false }, '会话已创建');
}));

conversationsRouter.get('/:id/messages', asyncHandler(async (req, res) => {
  const conv = await q1(pool, 'SELECT * FROM conversations WHERE id = ? AND school_id = ?', [Number(req.params.id), req.schoolId]);
  if (!conv) throw new AppError(ERR.NOT_FOUND, '会话不存在');
  if (![conv.buyer_id, conv.seller_id].map(Number).includes(Number(req.user.id))) {
    throw new AppError(ERR.FORBIDDEN, '你不在该会话中');
  }
  const { page, pageSize, offset } = parsePagination(req.query, { defaultSize: 50, maxSize: 200 });
  const list = await q(
    pool,
    `SELECT id, sender_id, receiver_id, content, image_url, is_read, read_at, created_at
     FROM messages WHERE conversation_id = ? AND status <> 'deleted'
     ORDER BY id DESC LIMIT ? OFFSET ?`,
    [conv.id, pageSize, offset],
  );
  // 标记对方发来的消息为已读
  await run(pool, 'UPDATE messages SET is_read = 1, read_at = NOW(3) WHERE conversation_id = ? AND receiver_id = ? AND is_read = 0', [conv.id, req.user.id]);
  return ok(res, { list: list.reverse(), page, pageSize });
}));

conversationsRouter.post('/:id/messages', rateLimit('publish'), requirePublishPermission(), validateBody(z.object({
  content: z.string().max(2000).optional(),
  imageUrl: z.string().max(500).optional(),
})), asyncHandler(async (req, res) => {
  const conv = await q1(pool, 'SELECT * FROM conversations WHERE id = ? AND school_id = ?', [Number(req.params.id), req.schoolId]);
  if (!conv) throw new AppError(ERR.NOT_FOUND, '会话不存在');
  if (![conv.buyer_id, conv.seller_id].map(Number).includes(Number(req.user.id))) {
    throw new AppError(ERR.FORBIDDEN, '你不在该会话中');
  }
  if (!req.body.content && !req.body.imageUrl) throw new AppError(ERR.VALIDATION_ERROR, '消息内容不能为空');

  const receiverId = Number(conv.buyer_id) === Number(req.user.id) ? conv.seller_id : conv.buyer_id;
  let content = req.body.content ?? null;
  let decision = { hits: [], level: null, text: content };
  if (content) {
    decision = await wordService.enforce({
      schoolId: req.schoolId, userId: req.user.id, scene: 'message', targetType: 'conversation', targetId: conv.id, text: content,
    });
    content = decision.text;
  }

  const messageId = await withTransaction(async (conn) => {
    const result = await run(
      conn,
      `INSERT INTO messages (school_id, conversation_id, sender_id, receiver_id, content, image_url, word_hit_level)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [req.schoolId, conv.id, req.user.id, receiverId, content, req.body.imageUrl ?? null, decision.level],
    );
    await run(
      conn,
      'UPDATE conversations SET last_message_at = NOW(3), last_message_preview = ? WHERE id = ?',
      [(content || '[图片]').slice(0, 200), conv.id],
    );
    return result.insertId;
  });

  await notifyService.notify(receiverId, {
    schoolId: req.schoolId, type: 'system', title: '你有一条新私信',
    content: (content || '[图片]').slice(0, 100),
    relatedType: 'conversation', relatedId: conv.id,
  });
  return ok(res, { messageId, wordHits: decision.hits.map((h) => ({ word: h.word, level: h.level })) }, '已发送');
}));
