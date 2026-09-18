// 管理后台路由：/api/v1/admin（学校配置 / 用户管理 / 内容审核 / 仲裁 / 看板 / 阈值 / 审计）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { requireRoles, requireSchoolModerator, PLATFORM_ROLES, MODERATOR_ROLES } from '../../middleware/rbac.js';
import { q, q1, run, withTransaction } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { configService } from '../../services/config.service.js';
import { penaltyService } from '../../services/penalty.service.js';
import { reportService } from '../../services/report.service.js';
import { ticketService } from '../../services/ticket.service.js';
import { creditService } from '../../services/credit.service.js';
import { notifyService } from '../../services/notify.service.js';
import { auditService } from '../../services/audit.service.js';
import { parsePagination } from '../../lib/pagination.js';
import { AppError, ERR } from '../../lib/errors.js';

export const adminRouter = Router();
ensureNumericId(adminRouter);
adminRouter.use(authenticate, schoolScope);

// ---------------- 数据看板 ----------------
adminRouter.get('/dashboard', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const schoolId = req.schoolId;
  const [orders, users, books, threads, escrow, reports, tickets] = await Promise.all([
    q(pool, 'SELECT status, COUNT(*) AS total, SUM(amount_cents) AS amount FROM orders WHERE school_id = ? GROUP BY status', [schoolId]),
    q(pool, 'SELECT verification_status, COUNT(*) AS total FROM users WHERE school_id = ? GROUP BY verification_status', [schoolId]),
    q1(pool, "SELECT COUNT(*) AS total FROM books WHERE school_id = ? AND status = 'on_sale' AND deleted_at IS NULL", [schoolId]),
    q1(pool, "SELECT COUNT(*) AS total FROM threads WHERE school_id = ? AND status = 'published' AND deleted_at IS NULL", [schoolId]),
    q1(pool, "SELECT COALESCE(SUM(CASE WHEN account='frozen' THEN (CASE WHEN direction='in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END),0) AS frozen FROM wallet_transactions WHERE school_id = ? AND status='success'", [schoolId]),
    reportService.stats({ schoolId }),
    ticketService.stats({ schoolId }),
  ]);
  const gmv = orders.filter((o) => ['completed', 'arbitrated_release'].includes(o.status)).reduce((sum, o) => sum + Number(o.amount || 0), 0);
  const fee = await q1(pool, "SELECT COALESCE(SUM(amount_cents),0) AS fee FROM wallet_transactions WHERE school_id = ? AND biz_type = 'fee' AND status = 'success'", [schoolId]);
  return ok(res, {
    schoolId, orders, users, onSaleBooks: Number(books.total), publishedThreads: Number(threads.total),
    escrowFrozenCents: Number(escrow.frozen), gmvCents: gmv, platformFeeCents: Number(fee.fee),
    reports, tickets,
  });
}));

// ---------------- 学校开通与配置 ----------------
adminRouter.get('/schools', requireRoles(PLATFORM_ROLES), asyncHandler(async (req, res) => {
  const rows = await q(pool, 'SELECT id, name, province, city, code, status, service_fee_bps, require_student_verification, cross_school_enabled, cross_school_mode, created_at FROM schools ORDER BY id ASC');
  return ok(res, rows);
}));

adminRouter.post('/schools', requireRoles(PLATFORM_ROLES), validateBody(z.object({
  name: z.string().min(2).max(120),
  province: z.string().min(2).max(60),
  city: z.string().min(2).max(60),
  code: z.string().min(2).max(40),
  serviceFeeBps: z.number().int().min(0).max(2000).optional(),
  requireStudentVerification: z.boolean().optional(),
  crossSchoolEnabled: z.boolean().optional(),
  crossSchoolMode: z.enum(['off', 'mail']).optional(),
  forumSections: z.array(z.object({ key: z.string(), name: z.string() })).optional(),
})), asyncHandler(async (req, res) => {
  const sections = req.body.forumSections ?? [{ key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' }];
  const result = await run(
    pool,
    `INSERT INTO schools (name, province, city, code, status, forum_sections, service_fee_bps,
       allowed_categories, require_student_verification, cross_school_enabled, cross_school_mode)
     VALUES (?, ?, ?, ?, 'active', CAST(? AS JSON), ?, CAST(? AS JSON), ?, ?, ?)`,
    [req.body.name, req.body.province, req.body.city, req.body.code, JSON.stringify(sections),
      req.body.serviceFeeBps ?? 200, JSON.stringify(await configService.get('content.categories', null).catch(() => ['教材'])),
      req.body.requireStudentVerification === false ? 0 : 1,
      req.body.crossSchoolEnabled ? 1 : 0, req.body.crossSchoolMode ?? 'off'],
  );
  auditService.record({ actorId: req.user.id, actorRole: req.user.role, action: 'school.create', targetType: 'school', targetId: result.insertId, detail: req.body, ip: req.ip });
  return ok(res, { schoolId: result.insertId }, '学校已开通并生成论坛版块');
}));

// 学校级独立配置：服务费比例、品类、是否需认证、跨校专区
adminRouter.patch('/schools/:id', requireRoles(PLATFORM_ROLES), validateBody(z.object({
  status: z.enum(['pending', 'active', 'suspended']).optional(),
  serviceFeeBps: z.number().int().min(0).max(2000).optional(),
  allowedCategories: z.array(z.string()).optional(),
  requireStudentVerification: z.boolean().optional(),
  crossSchoolEnabled: z.boolean().optional(),
  crossSchoolMode: z.enum(['off', 'mail']).optional(),
  forumSections: z.array(z.object({ key: z.string(), name: z.string() })).optional(),
})), asyncHandler(async (req, res) => {
  const fields = [];
  const params = [];
  const map = {
    status: 'status', serviceFeeBps: 'service_fee_bps', requireStudentVerification: 'require_student_verification',
    crossSchoolEnabled: 'cross_school_enabled', crossSchoolMode: 'cross_school_mode',
  };
  for (const [key, column] of Object.entries(map)) {
    if (req.body[key] !== undefined) {
      fields.push(`${column} = ?`);
      params.push(typeof req.body[key] === 'boolean' ? (req.body[key] ? 1 : 0) : req.body[key]);
    }
  }
  for (const [key, column] of [['allowedCategories', 'allowed_categories'], ['forumSections', 'forum_sections']]) {
    if (req.body[key] !== undefined) {
      fields.push(`${column} = CAST(? AS JSON)`);
      params.push(JSON.stringify(req.body[key]));
    }
  }
  if (fields.length === 0) throw new AppError(ERR.VALIDATION_ERROR, '没有需要更新的字段');
  params.push(Number(req.params.id));
  await run(pool, `UPDATE schools SET ${fields.join(', ')} WHERE id = ?`, params);
  auditService.record({ schoolId: Number(req.params.id), actorId: req.user.id, actorRole: req.user.role, action: 'school.update', targetType: 'school', targetId: Number(req.params.id), detail: req.body, ip: req.ip });
  return ok(res, { schoolId: Number(req.params.id), updated: true }, '学校配置已更新');
}));

// ---------------- 用户管理 ----------------
adminRouter.get('/users', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const where = ['school_id = ?', 'deleted_at IS NULL'];
  const params = [req.schoolId];
  if (req.query.keyword) { where.push('(nickname LIKE ? OR student_no_mask LIKE ? OR student_no = ?)'); params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`, req.query.keyword); }
  if (req.query.verificationStatus) { where.push('verification_status = ?'); params.push(req.query.verificationStatus); }
  if (req.query.banned === 'true') { where.push('(banned_permanently = 1 OR login_ban_until > NOW(3) OR trade_ban_until > NOW(3) OR mute_until > NOW(3))'); }
  const list = await q(pool, `SELECT id, nickname, student_no_mask, phone_last4, role, status, verification_status, credit_score, mute_until, trade_ban_until, login_ban_until, banned_permanently, created_at FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM users WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

// 一键处罚（禁言 / 禁止交易 / 禁止登录 / 永久封禁）
adminRouter.post('/users/:id/ban', requireSchoolModerator(), validateBody(z.object({
  type: z.enum(['warning', 'mute', 'trade_ban', 'login_ban', 'permanent_ban']),
  days: z.number().int().min(0).max(3650).nullable().optional(),
  reason: z.string().min(2).max(500),
})), asyncHandler(async (req, res) => {
  const user = await q1(pool, 'SELECT id FROM users WHERE id = ? AND school_id = ?', [Number(req.params.id), req.schoolId]);
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在或不属于本校');
  if (req.body.type === 'permanent_ban' && !PLATFORM_ROLES.includes(req.user.role)) {
    throw new AppError(ERR.FORBIDDEN, '永久封禁只能由平台管理员执行');
  }
  const result = await withTransaction(async (conn) => penaltyService.apply({
    conn, userId: user.id, schoolId: req.schoolId, severity: req.body.type === 'permanent_ban' ? 'severe' : 'light',
    source: 'admin', reason: req.body.reason, operatorId: req.user.id,
    type: req.body.type, days: req.body.days ?? null, scoreDelta: null,
  }));
  await notifyService.notify(user.id, {
    schoolId: req.schoolId, type: 'ban', title: '账号处罚通知',
    content: `原因：${req.body.reason}；处罚：${result.step.label || result.step.type}${result.endAt ? `，解封时间 ${new Date(result.endAt).toLocaleString('zh-CN')}` : ''}。你可以在「我的-违规记录」提交申诉`,
    relatedType: 'penalty', relatedId: result.penaltyId,
  });
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'user.ban', targetType: 'user', targetId: user.id, detail: req.body, ip: req.ip });
  return ok(res, result, '处罚已执行');
}));

adminRouter.post('/users/:id/unban', requireSchoolModerator(), validateBody(z.object({
  type: z.enum(['mute', 'trade_ban', 'login_ban', 'permanent_ban', 'all']),
  reason: z.string().max(500).optional(),
})), asyncHandler(async (req, res) => {
  const user = await q1(pool, 'SELECT id FROM users WHERE id = ? AND school_id = ?', [Number(req.params.id), req.schoolId]);
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在或不属于本校');
  const type = req.body.type;
  if (type === 'permanent_ban' && !PLATFORM_ROLES.includes(req.user.role)) throw new AppError(ERR.FORBIDDEN, '仅平台管理员可解除永久封禁');
  await run(
    pool,
    `UPDATE users SET
       mute_until = CASE WHEN ? IN ('mute','all') THEN NULL ELSE mute_until END,
       trade_ban_until = CASE WHEN ? IN ('trade_ban','all') THEN NULL ELSE trade_ban_until END,
       login_ban_until = CASE WHEN ? IN ('login_ban','all') THEN NULL ELSE login_ban_until END,
       banned_permanently = CASE WHEN ? IN ('permanent_ban','all') THEN 0 ELSE banned_permanently END,
       status = 'active'
     WHERE id = ? AND school_id = ?`,
    [type, type, type, type, user.id, req.schoolId],
  );
  // 同步撤销对应处罚记录
  await run(
    pool,
    `UPDATE penalties SET status = 'revoked' WHERE user_id = ? AND status = 'active' AND (? = 'all' OR type = ?)`,
    [user.id, type, type],
  );
  await notifyService.notify(user.id, { schoolId: req.schoolId, type: 'ban', title: '账号限制已解除', content: req.body.reason || '你的账号限制已被解除，请遵守平台规则' });
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'user.unban', targetType: 'user', targetId: user.id, detail: req.body, ip: req.ip });
  return ok(res, { userId: user.id, unbanType: type }, '已解除限制');
}));

// 风控一屏
adminRouter.get('/users/:id/risk', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const userId = Number(req.params.id);
  const user = await q1(pool, 'SELECT id, nickname, student_no_mask, phone_last4, role, status, verification_status, credit_score, mute_until, trade_ban_until, login_ban_until, banned_permanently, created_at FROM users WHERE id = ? AND school_id = ?', [userId, req.schoolId]);
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在或不属于本校');
  const permissions = await creditService.getPermissions(req.schoolId, userId);
  const penalties = await q(pool, 'SELECT id, type, severity, effective_count, reason, start_at, end_at, status, appeal_status, source FROM penalties WHERE user_id = ? ORDER BY id DESC LIMIT 20', [userId]);
  const credits = await q(pool, 'SELECT delta, score_after, rule_key, reason, created_at FROM credit_logs WHERE user_id = ? ORDER BY id DESC LIMIT 20', [userId]);
  const counter = await penaltyService.countEffectiveViolations(pool, { userId, schoolId: req.schoolId });
  const orders = await q(pool, 'SELECT id, order_no, status, amount_cents, buyer_id, seller_id, created_at FROM orders WHERE school_id = ? AND (buyer_id = ? OR seller_id = ?) ORDER BY id DESC LIMIT 10', [req.schoolId, userId, userId]);
  const tickets = await q(pool, 'SELECT id, ticket_no, type, status, subject, created_at FROM tickets WHERE school_id = ? AND (reporter_id = ? OR related_user_id = ?) ORDER BY id DESC LIMIT 10', [req.schoolId, userId, userId]);
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'user.risk_view', targetType: 'user', targetId: userId, ip: req.ip });
  return ok(res, { user, permissions, violationCounter: counter, penalties, credits, orders, tickets });
}));

// ---------------- 内容审核队列 ----------------
adminRouter.get('/contents', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const type = req.query.type || 'book';
  let list;
  if (type === 'thread') {
    list = await q(pool, `SELECT t.id, t.title, t.content, t.status, t.created_at, t.author_id, t.word_hit_level, u.nickname AS author_nickname FROM threads t JOIN users u ON u.id = t.author_id WHERE t.school_id = ? AND t.deleted_at IS NULL ORDER BY t.id DESC LIMIT ? OFFSET ?`, [req.schoolId, pageSize, offset]);
  } else if (type === 'reply') {
    list = await q(pool, `SELECT r.id, r.content AS title, r.content, r.status, r.created_at, r.author_id, NULL AS word_hit_level, u.nickname AS author_nickname FROM replies r JOIN users u ON u.id = r.author_id WHERE r.school_id = ? AND r.deleted_at IS NULL ORDER BY r.id DESC LIMIT ? OFFSET ?`, [req.schoolId, pageSize, offset]);
  } else {
    list = await q(pool, `SELECT b.id, b.title, b.remark AS content, b.status, b.created_at, b.seller_id AS author_id, b.banned_reason, u.nickname AS author_nickname FROM books b JOIN users u ON u.id = b.seller_id WHERE b.school_id = ? AND b.deleted_at IS NULL ORDER BY b.id DESC LIMIT ? OFFSET ?`, [req.schoolId, pageSize, offset]);
  }
  const hits = await q(pool, `SELECT target_type, target_id, level, word, COUNT(*) AS total FROM word_hits WHERE school_id = ? AND target_id IS NOT NULL GROUP BY target_type, target_id, level, word`, [req.schoolId]);
  const hitMap = new Map(hits.map((h) => [`${h.target_type}:${h.target_id}`, h]));
  return ok(res, paged(list.map((row) => ({ ...row, wordHit: hitMap.get(`${type}:${row.id}`) || null })), list.length, page, pageSize));
}));

adminRouter.post('/contents/:type/:id/review', requireSchoolModerator(), validateBody(z.object({
  action: z.enum(['approve', 'hide', 'delete']),
  reason: z.string().max(255).optional(),
})), asyncHandler(async (req, res) => {
  const { type, id } = req.params;
  const { action, reason } = req.body;
  const table = { book: 'books', thread: 'threads', reply: 'replies' }[type];
  if (!table) throw new AppError(ERR.VALIDATION_ERROR, '不支持的内容类型');
  const statusMap = { approve: type === 'book' ? 'on_sale' : 'published', hide: type === 'book' ? 'off_shelf' : 'hidden', delete: 'deleted' };
  const deletedAt = action === 'delete' ? 'deleted_at = NOW(3),' : '';
  const reasonField = type === 'book' ? 'banned_reason' : null;
  const result = await run(
    pool,
    `UPDATE ${table} SET status = ?, ${deletedAt} ${reasonField ? `${reasonField} = ?,` : ''} updated_at = NOW(3) WHERE id = ? AND school_id = ?`,
    reasonField ? [statusMap[action], reason ?? null, Number(id), req.schoolId] : [statusMap[action], Number(id), req.schoolId],
  );
  if (result.affectedRows === 0) throw new AppError(ERR.NOT_FOUND, '内容不存在或不属于本校');
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'content.review', targetType: type, targetId: Number(id), detail: { action, reason }, ip: req.ip });
  return ok(res, { type, id: Number(id), action, status: statusMap[action] }, '审核完成');
}));

// ---------------- 订单仲裁（客服/管理员查看本校订单，重点为争议中订单） ----------------
adminRouter.get('/orders', requireSchoolModerator(), asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query);
  const where = ['o.school_id = ?'];
  const params = [req.schoolId];
  if (req.query.status) { where.push('o.status = ?'); params.push(req.query.status); }
  if (req.query.orderNo) { where.push('o.order_no = ?'); params.push(req.query.orderNo); }
  const list = await q(
    pool,
    `SELECT o.id, o.order_no, o.book_id, o.amount_cents, o.service_fee_cents, o.status, o.escrow_status,
            o.ship_mode, o.dispute_reason, o.dispute_at, o.arbitration_result, o.created_at, o.auto_confirm_at,
            b.title AS book_title, bu.nickname AS buyer_nickname, su.nickname AS seller_nickname
     FROM orders o
     LEFT JOIN books b ON b.id = o.book_id
     LEFT JOIN users bu ON bu.id = o.buyer_id
     LEFT JOIN users su ON su.id = o.seller_id
     WHERE ${where.join(' AND ')}
     ORDER BY (o.status = 'disputed') DESC, o.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, offset],
  );
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM orders o WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));
// ---------------- 规则阈值配置 ----------------
adminRouter.get('/configs', requireSchoolModerator(), asyncHandler(async (req, res) => ok(res, await configService.list({ schoolId: req.query.schoolId ? Number(req.query.schoolId) : req.schoolId }))));

adminRouter.put('/configs/:key', requireRoles(PLATFORM_ROLES), validateBody(z.object({
  value: z.unknown(),
  scope: z.enum(['platform', 'school']).optional(),
  schoolId: z.number().int().positive().nullable().optional(),
  version: z.number().int().positive().nullable().optional(),
  description: z.string().max(255).optional(),
})), asyncHandler(async (req, res) => {
  const result = await configService.set(req.params.key, req.body.value, {
    scope: req.body.scope ?? 'platform', schoolId: req.body.schoolId ?? null,
    actorId: req.user.id, description: req.body.description ?? null, version: req.body.version ?? null,
  });
  auditService.record({ schoolId: req.body.schoolId ?? null, actorId: req.user.id, actorRole: req.user.role, action: 'config.update', targetType: 'config', targetId: null, detail: { key: req.params.key, value: req.body.value }, ip: req.ip });
  return ok(res, result, '规则阈值已更新');
}));

// ---------------- 审计日志 ----------------
adminRouter.get('/audit-logs', requireRoles(PLATFORM_ROLES), asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const rows = await auditService.list({ schoolId: req.schoolId, action: req.query.action ?? null, page, pageSize });
  return ok(res, paged(rows, rows.length, page, pageSize));
}));


