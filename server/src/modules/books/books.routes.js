// 图书库路由：/api/v1/books（本校数据，schoolScope 强制注入 school_id）
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
import { parsePagination, parseSort, sortToSql } from '../../lib/pagination.js';
import { wordService } from '../../services/word.service.js';
import { creditService } from '../../services/credit.service.js';
import { configService } from '../../services/config.service.js';
import { AppError, ERR } from '../../lib/errors.js';

export const booksRouter = Router();
ensureNumericId(booksRouter);
booksRouter.use(authenticate, schoolScope);

const SORTABLE = {
  createdAt: 'b.created_at', price: 'b.price_cents', views: 'b.view_count', title: 'b.title',
};
const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'poor'];

booksRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const sort = parseSort(req.query.sort, SORTABLE, { column: 'b.created_at', direction: 'DESC' });
  const where = ['b.deleted_at IS NULL', "b.status = 'on_sale'"];
  const params = [];

  // 本校数据 + （学校开启跨校专区且前端显式筛选时）跨校池
  const school = await q1(pool, 'SELECT cross_school_enabled, cross_school_mode FROM schools WHERE id = ?', [req.schoolId]);
  const wantCross = String(req.query.crossSchool || '') === 'true' && school?.cross_school_enabled;
  if (wantCross) {
    where.push('(b.school_id = ? OR b.cross_school = 1)');
    params.push(req.schoolId);
  } else {
    where.push('b.school_id = ?');
    params.push(req.schoolId);
  }

  if (req.query.keyword) {
    where.push('(b.title LIKE ? OR b.author LIKE ? OR b.course_name LIKE ? OR b.isbn LIKE ?)');
    const kw = `%${req.query.keyword}%`;
    params.push(kw, kw, kw, kw);
  }
  if (req.query.course) { where.push('b.course_name = ?'); params.push(req.query.course); }
  if (req.query.category) { where.push('b.category = ?'); params.push(req.query.category); }
  if (req.query.condition) { where.push('b.condition_level = ?'); params.push(req.query.condition); }
  if (req.query.minPrice) { where.push('b.price_cents >= ?'); params.push(Number(req.query.minPrice)); }
  if (req.query.maxPrice) { where.push('b.price_cents <= ?'); params.push(Number(req.query.maxPrice)); }
  if (req.query.sellerId) { where.push('b.seller_id = ?'); params.push(Number(req.query.sellerId)); }

  const list = await q(
    pool,
    `SELECT b.id, b.school_id, b.seller_id, b.title, b.author, b.publisher, b.isbn, b.course_name, b.category,
            b.condition_level, b.original_price_cents, b.price_cents, b.status, b.cross_school, b.view_count, b.created_at,
            (SELECT url FROM book_images i WHERE i.book_id = b.id ORDER BY sort_order ASC LIMIT 1) AS cover_url,
            u.nickname AS seller_nickname, u.credit_score AS seller_credit
     FROM books b JOIN users u ON u.id = b.seller_id
     WHERE ${where.join(' AND ')} ${sortToSql(sort)}
     LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM books b WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

booksRouter.get('/:id', asyncHandler(async (req, res) => {
  const book = await q1(
    pool,
    `SELECT b.*, u.nickname AS seller_nickname, u.credit_score AS seller_credit, u.verification_status AS seller_verified
     FROM books b JOIN users u ON u.id = b.seller_id
     WHERE b.id = ? AND b.school_id = ? AND b.deleted_at IS NULL`,
    [Number(req.params.id), req.schoolId],
  );
  if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在或不属于本校');
  const images = await q(pool, 'SELECT url, sort_order, width, height FROM book_images WHERE book_id = ? ORDER BY sort_order ASC', [book.id]);
  const tier = await creditService.getTier(req.schoolId, book.seller_credit);
  const stats = await q1(pool, "SELECT COUNT(*) AS sold FROM orders WHERE seller_id = ? AND status IN ('completed','arbitrated_release')", [book.seller_id]);
  const activeOrder = await q1(
    pool,
    `SELECT id, status, buyer_id, seller_id FROM orders
     WHERE book_id = ? AND school_id = ? AND status IN ('pending_payment','paid','shipped','refund_requested','return_requested','disputed') LIMIT 1`,
    [book.id, req.schoolId],
  );
  await run(pool, 'UPDATE books SET view_count = view_count + 1 WHERE id = ?', [book.id]);
  return ok(res, {
    ...book,
    student_no: undefined,
    images,
    seller: {
      id: book.seller_id, nickname: book.seller_nickname, creditScore: book.seller_credit,
      creditTier: tier, verified: book.seller_verified === 'approved', soldCount: Number(stats.sold),
    },
    canOrder: book.status === 'on_sale' && !activeOrder && Number(book.seller_id) !== Number(req.user.id),
    activeOrder: activeOrder ? { id: activeOrder.id, status: activeOrder.status } : null,
    isMine: Number(book.seller_id) === Number(req.user.id),
  });
}));

booksRouter.post('/', rateLimit('publish'), requireVerified(), requirePublishPermission(), validateBody(z.object({
  title: z.string().min(2).max(200),
  author: z.string().max(120).optional(),
  publisher: z.string().max(120).optional(),
  isbn: z.string().max(20).optional(),
  courseName: z.string().max(120).optional(),
  category: z.string().max(40).optional(),
  conditionLevel: z.enum(CONDITIONS),
  originalPriceCents: z.number().int().min(0).max(1000000),
  priceCents: z.number().int().min(1).max(1000000),
  remark: z.string().max(1000).optional(),
  crossSchool: z.boolean().optional(),
  images: z.array(z.string().max(500)).min(1, '至少上传 1 张图片').max(9),
})), asyncHandler(async (req, res) => {
  const body = req.body;
  const permissions = req.creditPermissions;

  // 档位限制：受限档位最多挂 3 本书（阈值来自 configs.credit.tier_permissions）
  const onSale = await q1(pool, "SELECT COUNT(*) AS total FROM books WHERE seller_id = ? AND school_id = ? AND status = 'on_sale' AND deleted_at IS NULL", [req.user.id, req.schoolId]);
  if (Number(onSale.total) >= Number(permissions.maxBooks)) {
    throw new AppError(ERR.CREDIT_NOT_ALLOWED, `当前信誉分档位最多同时挂 ${permissions.maxBooks} 本书`, { maxBooks: permissions.maxBooks });
  }

  // 品类白名单（学校可配置）
  const school = await q1(pool, 'SELECT allowed_categories, cross_school_enabled FROM schools WHERE id = ?', [req.schoolId]);
  const categories = school?.allowed_categories?.length ? school.allowed_categories : await configService.get('content.categories', req.schoolId);
  if (body.category && !categories.includes(body.category)) {
    throw new AppError(ERR.VALIDATION_ERROR, `该学校暂不支持发布「${body.category}」品类`, { allowed: categories });
  }

  // 违禁词检测：L1 打码放行；L2/L3 拦截；L4 删除并转人工
  const decision = await wordService.enforce({
    schoolId: req.schoolId, userId: req.user.id, scene: 'book', targetType: 'book',
    text: `${body.title}\n${body.remark || ''}`,
  });

  const bookId = await withTransaction(async (conn) => {
    const result = await run(
      conn,
      `INSERT INTO books (school_id, seller_id, title, author, publisher, isbn, course_name, category, condition_level,
         original_price_cents, price_cents, remark, status, cross_school, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'on_sale', ?, NOW(3))`,
      [req.schoolId, req.user.id, body.title, body.author ?? null, body.publisher ?? null, body.isbn ?? null,
        body.courseName ?? null, body.category ?? null, body.conditionLevel,
        body.originalPriceCents, body.priceCents, decision.text.slice(0, 1000),
        body.crossSchool && school?.cross_school_enabled ? 1 : 0],
    );
    for (let i = 0; i < body.images.length; i += 1) {
      await run(conn, 'INSERT INTO book_images (book_id, school_id, url, sort_order, ocr_status) VALUES (?, ?, ?, ?, ?)',
        [result.insertId, req.schoolId, body.images[i], i + 1, 'pending']);
    }
    return result.insertId;
  });

  if (decision.hits.length > 0) await wordService.notifyBlocked({ schoolId: req.schoolId, userId: req.user.id, decision, scene: 'book' });
  return ok(res, { bookId, wordHits: decision.hits.map((h) => ({ word: h.word, level: h.level })) }, '发布成功');
}));

booksRouter.patch('/:id', validateBody(z.object({
  title: z.string().min(2).max(200).optional(),
  priceCents: z.number().int().min(1).max(1000000).optional(),
  remark: z.string().max(1000).optional(),
  conditionLevel: z.enum(CONDITIONS).optional(),
})), asyncHandler(async (req, res) => {
  const book = await q1(pool, 'SELECT * FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
  if (Number(book.seller_id) !== Number(req.user.id)) throw new AppError(ERR.FORBIDDEN, '只能编辑自己发布的教材');
  if (['sold', 'locked'].includes(book.status)) throw new AppError(ERR.CONFLICT, '教材已被下单，无法编辑');

  let remark = book.remark;
  if (req.body.remark !== undefined) {
    const decision = await wordService.enforce({ schoolId: req.schoolId, userId: req.user.id, scene: 'book', targetType: 'book', targetId: book.id, text: req.body.remark });
    remark = decision.text;
  }
  await run(
    pool,
    'UPDATE books SET title = ?, price_cents = ?, remark = ?, condition_level = ? WHERE id = ? AND school_id = ?',
    [req.body.title ?? book.title, req.body.priceCents ?? book.price_cents, remark,
      req.body.conditionLevel ?? book.condition_level, book.id, req.schoolId],
  );
  return ok(res, { bookId: book.id, updated: true });
}));

booksRouter.post('/:id/off-shelf', asyncHandler(async (req, res) => {
  const book = await q1(pool, 'SELECT * FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
  if (Number(book.seller_id) !== Number(req.user.id)) throw new AppError(ERR.FORBIDDEN, '只能下架自己发布的教材');
  if (book.status === 'locked') throw new AppError(ERR.CONFLICT, '教材有进行中的订单，暂不能下架');
  await run(pool, "UPDATE books SET status = 'off_shelf' WHERE id = ? AND school_id = ?", [book.id, req.schoolId]);
  return ok(res, { bookId: book.id, status: 'off_shelf' }, '已下架');
}));

booksRouter.post('/:id/relist', requireVerified(), requirePublishPermission(), asyncHandler(async (req, res) => {
  const book = await q1(pool, 'SELECT * FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
  if (Number(book.seller_id) !== Number(req.user.id)) throw new AppError(ERR.FORBIDDEN, '只能上架自己发布的教材');
  if (book.status !== 'off_shelf') throw new AppError(ERR.CONFLICT, '只有已下架的教材可以重新上架');
  const onSale = await q1(pool, "SELECT COUNT(*) AS total FROM books WHERE seller_id = ? AND school_id = ? AND status = 'on_sale'", [req.user.id, req.schoolId]);
  if (Number(onSale.total) >= Number(req.creditPermissions.maxBooks)) {
    throw new AppError(ERR.CREDIT_NOT_ALLOWED, `当前信誉分档位最多同时挂 ${req.creditPermissions.maxBooks} 本书`);
  }
  await run(pool, "UPDATE books SET status = 'on_sale', published_at = NOW(3) WHERE id = ? AND school_id = ? AND status = 'off_shelf'", [book.id, req.schoolId]);
  return ok(res, { bookId: book.id, status: 'on_sale' }, '已重新上架');
}));

booksRouter.delete('/:id', asyncHandler(async (req, res) => {
  const book = await q1(pool, 'SELECT * FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL', [Number(req.params.id), req.schoolId]);
  if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
  const isOwner = Number(book.seller_id) === Number(req.user.id);
  const isModerator = ['school_admin', 'support', 'platform_admin'].includes(req.user.role);
  if (!isOwner && !isModerator) throw new AppError(ERR.FORBIDDEN, '无权删除该教材');
  await run(pool, "UPDATE books SET deleted_at = NOW(3), status = 'off_shelf' WHERE id = ? AND school_id = ?", [book.id, req.schoolId]);
  return ok(res, { bookId: book.id, deleted: true }, '已删除');
}));
