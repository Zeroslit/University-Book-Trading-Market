// 学校路由：/api/v1/schools（公开，用于注册下拉选择与申请开通）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { requireRoles, PLATFORM_ROLES } from '../../middleware/rbac.js';
import { q, q1, run } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { encrypt, hmac } from '../../lib/crypto.js';
import { parsePagination } from '../../lib/pagination.js';
import { configService } from '../../services/config.service.js';
import { notifyService } from '../../services/notify.service.js';
import { AppError, ERR } from '../../lib/errors.js';

export const schoolsRouter = Router();
ensureNumericId(schoolsRouter);

// 按省/市/关键词搜索学校（学生注册必须从下拉选择，禁止手填）
schoolsRouter.get('/', asyncHandler(async (req, res) => {
  const { page, pageSize, offset } = parsePagination(req.query, { defaultSize: 20, maxSize: 50 });
  const where = ["status = 'active'"];
  const params = [];
  if (req.query.keyword) { where.push('name LIKE ?'); params.push(`%${req.query.keyword}%`); }
  if (req.query.province) { where.push('province = ?'); params.push(req.query.province); }
  if (req.query.city) { where.push('city = ?'); params.push(req.query.city); }
  const list = await q(pool, `SELECT id, name, province, city, code, status FROM schools WHERE ${where.join(' AND ')} ORDER BY province, city, name LIMIT ? OFFSET ?`, [...params, pageSize, offset]);
  const total = await q1(pool, `SELECT COUNT(*) AS total FROM schools WHERE ${where.join(' AND ')}`, params);
  return ok(res, paged(list, Number(total.total), page, pageSize));
}));

// 省份 + 城市级联（含每所学校数量）
schoolsRouter.get('/provinces', asyncHandler(async (req, res) => {
  const rows = await q(pool, "SELECT province, city, COUNT(*) AS total FROM schools WHERE status = 'active' GROUP BY province, city ORDER BY province, city");
  const grouped = {};
  for (const row of rows) {
    grouped[row.province] = grouped[row.province] || { province: row.province, cities: [] };
    grouped[row.province].cities.push({ city: row.city, total: Number(row.total) });
  }
  return ok(res, Object.values(grouped));
}));

// 学校详情与公开配置（前端据此渲染论坛版块、跨校开关、服务费说明、是否需要认证）
schoolsRouter.get('/:id', asyncHandler(async (req, res) => {
  const school = await q1(pool, 'SELECT id, name, province, city, code, status, forum_sections, service_fee_bps, allowed_categories, require_student_verification, cross_school_enabled, cross_school_mode FROM schools WHERE id = ?', [Number(req.params.id)]);
  if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在');
  const categories = school.allowed_categories || await configService.get('content.categories', school.id).catch(() => []);
  const uploadLimits = await configService.get('upload.image', school.id).catch(() => null);
  return ok(res, { ...school, allowed_categories: categories, uploadLimits });
}));

// 申请开通学校（找不到自己的学校时使用）
schoolsRouter.post('/applications', asyncHandler(async (req, res) => {
  const body = z.object({
    schoolName: z.string().min(2).max(120),
    province: z.string().min(2).max(60),
    city: z.string().min(2).max(60),
    applicantName: z.string().min(2).max(60),
    phone: z.string().regex(/^1[3-9]\d{9}$/),
    note: z.string().max(500).optional(),
  }).parse(req.body);

  const existed = await q1(pool, "SELECT id FROM school_applications WHERE applicant_phone_hash = ? AND status = 'pending'", [hmac(body.phone)]);
  if (existed) throw new AppError(ERR.CONFLICT, '你已提交过申请，请耐心等待审核');

  const result = await run(
    pool,
    `INSERT INTO school_applications (school_name, province, city, applicant_name, applicant_phone_enc, applicant_phone_last4, applicant_phone_hash, note, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [body.schoolName, body.province, body.city, body.applicantName, encrypt(body.phone), body.phone.slice(-4), hmac(body.phone), body.note ?? null],
  );
  return ok(res, { applicationId: result.insertId, status: 'pending' }, '申请已提交，管理员审核通过后即可在注册页选择你的学校');
}));

// 平台管理员：查看/审核学校开通申请
schoolsRouter.get('/applications/list', authenticate, requireRoles(PLATFORM_ROLES), asyncHandler(async (req, res) => {
  const rows = await q(pool, 'SELECT id, school_name, province, city, applicant_name, applicant_phone_last4, note, status, created_at FROM school_applications ORDER BY id DESC LIMIT 100');
  return ok(res, rows);
}));

schoolsRouter.post('/applications/:id/review', authenticate, requireRoles(PLATFORM_ROLES), asyncHandler(async (req, res) => {
  const body = z.object({ approve: z.boolean(), note: z.string().max(255).optional(), code: z.string().max(40).optional() }).parse(req.body);
  const application = await q1(pool, 'SELECT * FROM school_applications WHERE id = ?', [Number(req.params.id)]);
  if (!application) throw new AppError(ERR.NOT_FOUND, '申请不存在');
  if (application.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, '该申请已处理');

  let schoolId = null;
  if (body.approve) {
    const sections = [{ key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' }];
    const result = await run(
      pool,
      `INSERT INTO schools (name, province, city, code, status, forum_sections, service_fee_bps, allowed_categories, require_student_verification)
       VALUES (?, ?, ?, ?, 'active', CAST(? AS JSON), 200, CAST(? AS JSON), 1)`,
      [application.school_name, application.province, application.city,
        body.code || `NEW-${Date.now()}`, JSON.stringify(sections),
        JSON.stringify(await configService.get('content.categories', null).catch(() => ['教材']))],
    );
    schoolId = result.insertId; // 审核通过后自动建校并生成论坛版块
  }
  await run(pool, 'UPDATE school_applications SET status = ?, reviewer_id = ?, review_note = ?, reviewed_at = NOW(3) WHERE id = ?',
    [body.approve ? 'approved' : 'rejected', req.user.id, body.note ?? null, application.id]);
  return ok(res, { applicationId: application.id, approved: body.approve, schoolId }, body.approve ? '已开通学校并生成论坛版块' : '已驳回申请');
}));
