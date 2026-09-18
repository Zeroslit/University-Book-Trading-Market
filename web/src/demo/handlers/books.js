// 演示版：图书库（本校数据 + 可选跨校专区）
import { table, insert, filter, nowIso, configValue } from '../store.js';
import { AppError, ERR, parseSort } from '../vendor.js';
import { creditTier, notify } from '../rules.js';
import { enforce as wordEnforce, notifyBlocked } from '../words.js';
import {
  paged, pageOf, slicePage, requireVerified, requirePublishPermission, requireTradePermission, schoolOf,
} from './util.js';

const SORTABLE = {
  createdAt: 'created_at', price: 'price_cents', views: 'view_count', title: 'title',
};
const CONDITIONS = ['new', 'like_new', 'good', 'fair', 'poor'];
const ACTIVE_ORDER_STATUS = ['pending_payment', 'paid', 'shipped', 'refund_requested', 'return_requested', 'disputed'];

function sellerOf(id) {
  return table('users').find((u) => Number(u.id) === Number(id)) || {};
}

function coverOf(bookId) {
  const image = filter('book_images', (i) => Number(i.book_id) === Number(bookId)).sort((a, b) => a.sort_order - b.sort_order)[0];
  return image ? image.url : null;
}

function activeOrderOf(bookId, schoolId) {
  return table('orders').find((o) => Number(o.book_id) === Number(bookId)
    && Number(o.school_id) === Number(schoolId)
    && ACTIVE_ORDER_STATUS.includes(o.status)) || null;
}

export function registerBookRoutes(route) {
  route('GET', '/books', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const sort = parseSort(ctx.query.sort, SORTABLE, { column: 'created_at', direction: 'DESC' });
    const school = schoolOf(ctx.schoolId);
    const wantCross = String(ctx.query.crossSchool || '') === 'true' && Number(school.cross_school_enabled);

    let rows = table('books').filter((b) => !b.deleted_at && b.status === 'on_sale');
    rows = wantCross
      ? rows.filter((b) => Number(b.school_id) === Number(ctx.schoolId) || Number(b.cross_school) === 1)
      : rows.filter((b) => Number(b.school_id) === Number(ctx.schoolId));

    const keyword = ctx.query.keyword;
    if (keyword) {
      rows = rows.filter((b) => [b.title, b.author, b.course_name, b.isbn]
        .some((v) => String(v || '').includes(String(keyword))));
    }
    if (ctx.query.course) rows = rows.filter((b) => b.course_name === ctx.query.course);
    if (ctx.query.category) rows = rows.filter((b) => b.category === ctx.query.category);
    if (ctx.query.condition) rows = rows.filter((b) => b.condition_level === ctx.query.condition);
    if (ctx.query.minPrice) rows = rows.filter((b) => Number(b.price_cents) >= Number(ctx.query.minPrice));
    if (ctx.query.maxPrice) rows = rows.filter((b) => Number(b.price_cents) <= Number(ctx.query.maxPrice));
    if (ctx.query.sellerId) rows = rows.filter((b) => Number(b.seller_id) === Number(ctx.query.sellerId));

    const key = sort.column;
    rows = [...rows].sort((a, b) => {
      const av = a[key];
      const bv = b[key];
      const cmp = typeof av === 'number' && typeof bv === 'number'
        ? av - bv
        : String(av ?? '').localeCompare(String(bv ?? ''), 'zh-CN');
      return sort.direction === 'DESC' ? -cmp : cmp;
    });

    const list = slicePage(rows, page, pageSize).map((b) => {
      const seller = sellerOf(b.seller_id);
      return {
        id: Number(b.id), school_id: Number(b.school_id), seller_id: Number(b.seller_id), title: b.title,
        author: b.author, publisher: b.publisher, isbn: b.isbn, course_name: b.course_name, category: b.category,
        condition_level: b.condition_level, original_price_cents: Number(b.original_price_cents),
        price_cents: Number(b.price_cents), status: b.status, cross_school: Number(b.cross_school),
        view_count: Number(b.view_count), created_at: b.created_at, cover_url: coverOf(b.id),
        seller_nickname: seller.nickname, seller_credit: Number(seller.credit_score || 0),
      };
    });
    return paged(list, rows.length, page, pageSize);
  });

  route('GET', '/books/:id', (ctx) => {
    const book = table('books').find((b) => Number(b.id) === Number(ctx.params.id)
      && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在或不属于本校');
    const seller = sellerOf(book.seller_id);
    const images = filter('book_images', (i) => Number(i.book_id) === Number(book.id))
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((i) => ({ url: i.url, sort_order: Number(i.sort_order), width: i.width, height: i.height }));
    const soldCount = filter('orders', (o) => Number(o.seller_id) === Number(book.seller_id)
      && ['completed', 'arbitrated_release'].includes(o.status)).length;
    const activeOrder = activeOrderOf(book.id, ctx.schoolId);
    book.view_count = Number(book.view_count || 0) + 1;

    return {
      ...book,
      school_id: Number(book.school_id), seller_id: Number(book.seller_id),
      original_price_cents: Number(book.original_price_cents), price_cents: Number(book.price_cents),
      cross_school: Number(book.cross_school), view_count: Number(book.view_count),
      seller_nickname: seller.nickname,
      seller_credit: Number(seller.credit_score || 0),
      seller_verified: seller.verification_status,
      images,
      seller: {
        id: Number(seller.id), nickname: seller.nickname, creditScore: Number(seller.credit_score || 0),
        creditTier: creditTier(ctx.schoolId, seller.credit_score), verified: seller.verification_status === 'approved',
        soldCount,
      },
      canOrder: book.status === 'on_sale' && Number(book.seller_id) !== Number(ctx.user.id),
      activeOrder: activeOrder ? { id: Number(activeOrder.id), status: activeOrder.status } : null,
      isMine: Number(book.seller_id) === Number(ctx.user.id),
    };
  });

  route('POST', '/books', (ctx) => {
    requireVerified(ctx);
    const permissions = requirePublishPermission(ctx);
    const body = ctx.body;

    if (!body.title || String(body.title).length < 2) throw new AppError(ERR.VALIDATION_ERROR, '书名至少 2 个字');
    if (!CONDITIONS.includes(body.conditionLevel)) throw new AppError(ERR.VALIDATION_ERROR, '成色取值不正确');
    if (!Number.isInteger(body.priceCents) || body.priceCents < 1) throw new AppError(ERR.VALIDATION_ERROR, '售价必须大于 0');
    if (!Array.isArray(body.images) || body.images.length < 1) throw new AppError(ERR.VALIDATION_ERROR, '至少上传 1 张图片');
    if (body.images.length > 9) throw new AppError(ERR.VALIDATION_ERROR, '图片最多 9 张');

    // 档位限制：受限档位最多同时挂 3 本书（阈值来自 configs.credit.tier_permissions）
    const onSale = filter('books', (b) => Number(b.seller_id) === Number(ctx.user.id)
      && Number(b.school_id) === Number(ctx.schoolId) && b.status === 'on_sale' && !b.deleted_at).length;
    if (onSale >= Number(permissions.maxBooks)) {
      throw new AppError(ERR.CREDIT_NOT_ALLOWED, `当前信誉分档位最多同时挂 ${permissions.maxBooks} 本书`, { maxBooks: permissions.maxBooks });
    }

    const school = schoolOf(ctx.schoolId);
    const categories = Array.isArray(school.allowed_categories) && school.allowed_categories.length
      ? school.allowed_categories : configValue('content.categories', ctx.schoolId);
    if (body.category && !categories.includes(body.category)) {
      throw new AppError(ERR.VALIDATION_ERROR, `该学校暂不支持发布「${body.category}」品类`, { allowed: categories });
    }

    // 违禁词检测：L1 打码放行；L2/L3 拦截；L4 删除并转人工
    const decision = wordEnforce({
      schoolId: ctx.schoolId, userId: ctx.user.id, scene: 'book', targetType: 'book',
      text: `${body.title}\n${body.remark || ''}`,
    });

    const book = insert('books', {
      school_id: Number(ctx.schoolId), seller_id: Number(ctx.user.id), title: body.title,
      author: body.author ?? null, publisher: body.publisher ?? null, isbn: body.isbn ?? null,
      course_name: body.courseName ?? null, category: body.category ?? null,
      condition_level: body.conditionLevel, original_price_cents: Number(body.originalPriceCents || 0),
      price_cents: Number(body.priceCents), remark: decision.text.slice(0, 1000),
      status: 'on_sale', cross_school: body.crossSchool && Number(school.cross_school_enabled) ? 1 : 0,
      view_count: 0, banned_reason: null, published_at: nowIso(), created_at: nowIso(),
      updated_at: nowIso(), deleted_at: null,
    });
    body.images.forEach((url, i) => {
      insert('book_images', {
        book_id: Number(book.id), school_id: Number(ctx.schoolId), url, sort_order: i + 1,
        width: 1080, height: 810, size_bytes: null, ocr_status: 'pending', ocr_text: null, created_at: nowIso(),
      });
    });
    if (decision.hits.length > 0) notifyBlocked({ schoolId: ctx.schoolId, userId: ctx.user.id, decision, scene: 'book' });
    return { bookId: Number(book.id), wordHits: decision.hits.map((h) => ({ word: h.word, level: h.level })) };
  }, { message: '发布成功' });

  route('PATCH', '/books/:id', (ctx) => {
    const book = table('books').find((b) => Number(b.id) === Number(ctx.params.id)
      && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
    if (Number(book.seller_id) !== Number(ctx.user.id)) throw new AppError(ERR.FORBIDDEN, '只能编辑自己发布的教材');
    if (['sold', 'locked'].includes(book.status)) throw new AppError(ERR.CONFLICT, '教材已被下单，无法编辑');

    const body = ctx.body;
    if (body.title !== undefined) book.title = body.title;
    if (body.priceCents !== undefined) book.price_cents = Number(body.priceCents);
    if (body.conditionLevel !== undefined) {
      if (!CONDITIONS.includes(body.conditionLevel)) throw new AppError(ERR.VALIDATION_ERROR, '成色取值不正确');
      book.condition_level = body.conditionLevel;
    }
    if (body.remark !== undefined) {
      const decision = wordEnforce({
        schoolId: ctx.schoolId, userId: ctx.user.id, scene: 'book', targetType: 'book', targetId: book.id, text: body.remark,
      });
      book.remark = decision.text;
    }
    book.updated_at = nowIso();
    return { bookId: Number(book.id), updated: true };
  });

  route('POST', '/books/:id/off-shelf', (ctx) => {
    const book = table('books').find((b) => Number(b.id) === Number(ctx.params.id)
      && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
    if (Number(book.seller_id) !== Number(ctx.user.id)) throw new AppError(ERR.FORBIDDEN, '只能下架自己发布的教材');
    if (book.status === 'locked') throw new AppError(ERR.CONFLICT, '教材有进行中的订单，暂不能下架');
    book.status = 'off_shelf';
    book.updated_at = nowIso();
    return { bookId: Number(book.id), status: 'off_shelf' };
  }, { message: '已下架' });

  route('POST', '/books/:id/relist', (ctx) => {
    requireVerified(ctx);
    const permissions = requirePublishPermission(ctx);
    const book = table('books').find((b) => Number(b.id) === Number(ctx.params.id)
      && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
    if (Number(book.seller_id) !== Number(ctx.user.id)) throw new AppError(ERR.FORBIDDEN, '只能上架自己发布的教材');
    if (book.status !== 'off_shelf') throw new AppError(ERR.CONFLICT, '只有已下架的教材可以重新上架');
    const onSale = filter('books', (b) => Number(b.seller_id) === Number(ctx.user.id)
      && Number(b.school_id) === Number(ctx.schoolId) && b.status === 'on_sale').length;
    if (onSale >= Number(permissions.maxBooks)) {
      throw new AppError(ERR.CREDIT_NOT_ALLOWED, `当前信誉分档位最多同时挂 ${permissions.maxBooks} 本书`);
    }
    book.status = 'on_sale';
    book.published_at = nowIso();
    return { bookId: Number(book.id), status: 'on_sale' };
  }, { message: '已重新上架' });

  route('DELETE', '/books/:id', (ctx) => {
    const book = table('books').find((b) => Number(b.id) === Number(ctx.params.id)
      && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在');
    const isOwner = Number(book.seller_id) === Number(ctx.user.id);
    const isModerator = ['school_admin', 'support', 'platform_admin'].includes(ctx.user.role);
    if (!isOwner && !isModerator) throw new AppError(ERR.FORBIDDEN, '无权删除该教材');
    book.deleted_at = nowIso();
    book.status = 'off_shelf';
    return { bookId: Number(book.id), deleted: true };
  }, { message: '已删除' });
}

export { ACTIVE_ORDER_STATUS, CONDITIONS, sellerOf, coverOf };
