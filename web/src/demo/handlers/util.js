// 演示版处理器公共工具：分页、脱敏、准入校验（与后端 guards/rbac 行为一致）
import { parsePagination, AppError, ERR, maskPhone, maskStudentNo } from '../vendor.js';
import { table } from '../store.js';
import { creditPermissions } from '../rules.js';

export function paged(list, total, page, pageSize) {
  return { list, total, page, pageSize, hasMore: page * pageSize < total };
}

export function pageOf(query, options) {
  return parsePagination(query || {}, options);
}

export function slicePage(rows, page, pageSize) {
  return rows.slice((page - 1) * pageSize, page * pageSize);
}

export function phoneMaskOf(user) {
  return maskPhone(`000${user?.phone_last4 || ''}`).replace(/^000/, '');
}

export function toAuthUser(user) {
  return {
    id: Number(user.id),
    schoolId: user.school_id === null ? null : Number(user.school_id),
    role: user.role,
    nickname: user.nickname,
    avatarUrl: user.avatar_url,
    studentNoMask: user.student_no_mask || maskStudentNo(user.student_no),
    phoneMask: phoneMaskOf(user),
    phoneLast4: user.phone_last4,
    verificationStatus: user.verification_status,
    creditScore: Number(user.credit_score),
    status: user.status,
    muteUntil: user.mute_until,
    tradeBanUntil: user.trade_ban_until,
    bannedPermanently: Number(user.banned_permanently || 0),
  };
}

export function toPublicSchool(school) {
  return {
    id: Number(school.id), name: school.name, province: school.province, city: school.city,
    status: school.status, forum_sections: school.forum_sections, service_fee_bps: Number(school.service_fee_bps),
    require_student_verification: Number(school.require_student_verification),
    cross_school_enabled: Number(school.cross_school_enabled), cross_school_mode: school.cross_school_mode,
  };
}

export function schoolOf(schoolId) {
  const school = table('schools').find((s) => Number(s.id) === Number(schoolId));
  if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在或未开通');
  return school;
}

// 认证准入：认证通过前仅可浏览，不能发布与交易（学校可配置是否强制认证）
export function requireVerified(ctx) {
  const school = schoolOf(ctx.schoolId);
  if (!Number(school.require_student_verification)) return true;
  if (ctx.user.verification_status !== 'approved') {
    throw new AppError(ERR.VERIFICATION_REQUIRED, '完成学生认证后才能发布或交易', {
      verificationStatus: ctx.user.verification_status || 'unverified', path: '/verification',
    });
  }
  return true;
}

// 发布权限：禁言中 / 信誉分档位不允许发布
export function requirePublishPermission(ctx) {
  const user = ctx.user;
  if (user.banned_permanently) throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁');
  if (user.mute_until && new Date(user.mute_until) > new Date()) {
    throw new AppError(ERR.ACCOUNT_MUTED, `账号处于禁言状态，解禁时间：${new Date(user.mute_until).toLocaleString('zh-CN')}`, {
      until: user.mute_until, appealAvailable: true,
    });
  }
  const permissions = creditPermissions(ctx.schoolId, user.id);
  if (!permissions.canPublish) {
    throw new AppError(ERR.CREDIT_NOT_ALLOWED, `当前信誉分档位「${permissions.tierLabel}」不允许发布内容`, {
      score: permissions.score, tier: permissions.tier, path: '/credit',
    });
  }
  return permissions;
}

// 交易权限：限制交易中 / 信誉分过低
export function requireTradePermission(ctx) {
  const user = ctx.user;
  if (user.banned_permanently) throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁');
  if (user.trade_ban_until && new Date(user.trade_ban_until) > new Date()) {
    throw new AppError(ERR.TRADE_BANNED, `账号处于限制交易状态，解禁时间：${new Date(user.trade_ban_until).toLocaleString('zh-CN')}`, {
      until: user.trade_ban_until, appealAvailable: true,
    });
  }
  const permissions = creditPermissions(ctx.schoolId, user.id);
  if (!permissions.canTrade) {
    throw new AppError(ERR.CREDIT_NOT_ALLOWED, '信誉分过低，当前仅可浏览，无法交易', {
      score: permissions.score, tier: permissions.tier, path: '/credit',
    });
  }
  return permissions;
}

// 跨校隔离：实体不属于当前学校时统一按“不存在”返回，避免泄露存在性
export function assertSchoolScoped(entity, schoolId, message, code = ERR.NOT_FOUND) {
  if (!entity || (entity.school_id !== null && Number(entity.school_id) !== Number(schoolId))) {
    throw new AppError(code || ERR.NOT_FOUND, message);
  }
  return entity;
}

export function requireFields(body, fields) {
  const missing = fields.filter((f) => body[f] === undefined || body[f] === null || body[f] === '');
  if (missing.length) throw new AppError(ERR.VALIDATION_ERROR, `缺少必填参数：${missing.join('、')}`, { missing });
}
