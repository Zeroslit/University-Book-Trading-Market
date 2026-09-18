// 多校隔离核心中间件：把「学校上下文」锁定在服务端
// 规则：
//   1) 学生（学生/校管）学校一律取自登录态，忽略客户端传参 -> 杜绝改包越权
//   2) 跨校角色（客服/平台管理员）必须显式传 schoolId，并写审计日志
import { AppError, ERR } from '../lib/errors.js';
import { auditService } from '../services/audit.service.js';
import { ROLES } from './rbac.js';

export const CROSS_SCHOOL_ROLES = ['support', 'platform_admin'];

// 平台级全局接口（不隶属任何学校）：平台管理员无需传 schoolId，接口自身用 requireRoles(PLATFORM_ROLES) 兜底
// 说明：这些接口读写的都是平台主数据（学校开通、规则阈值、审计日志），与学校上下文无关
const PLATFORM_GLOBAL_PATHS = [/^\/schools(\/|$)/, /^\/configs(\/|$)/, /^\/audit-logs(\/|$)/];

export function schoolScope(req, res, next) {
  try {
    if (!req.user) throw new AppError(ERR.UNAUTHORIZED, '请先登录');

    if (!CROSS_SCHOOL_ROLES.includes(req.user.role)) {
      if (!req.user.schoolId) throw new AppError(ERR.SCHOOL_REQUIRED, '当前账号未绑定学校，请联系管理员');
      req.schoolId = Number(req.user.schoolId);
      req.crossSchoolAccess = false;
      return next();
    }

    const raw = req.query.schoolId ?? req.body?.schoolId ?? req.params.schoolId;
    const schoolId = Number(raw);
    if (!Number.isFinite(schoolId) || schoolId <= 0) {
      if (req.user.role === ROLES.PLATFORM_ADMIN && PLATFORM_GLOBAL_PATHS.some((re) => re.test(req.path))) {
        req.schoolId = null;
        req.crossSchoolAccess = false;
        req.platformScope = true;
        return next();
      }
      throw new AppError(ERR.SCHOOL_REQUIRED, '跨校角色访问必须显式指定 schoolId');
    }
    req.schoolId = schoolId;
    req.crossSchoolAccess = true;
    // 跨校访问留痕（异步，不阻塞主流程）
    auditService.record({
      schoolId, actorId: req.user.id, actorRole: req.user.role,
      action: 'cross_school_access', targetType: 'school', targetId: schoolId,
      detail: { path: req.originalUrl, method: req.method }, ip: req.ip,
    });
    return next();
  } catch (err) {
    return next(err);
  }
}

// 平台级角色专属：不绑定学校，但必须显式授权
export function requireCrossSchoolRole(req, res, next) {
  if (!req.user || !CROSS_SCHOOL_ROLES.includes(req.user.role)) {
    return next(new AppError(ERR.FORBIDDEN, '仅客服或平台管理员可执行该操作'));
  }
  return next();
}

// 业务层双保险：跨模块引用时校验归属同一学校
export function assertSameSchool(entity, schoolId, message = '数据不存在') {
  if (!entity || Number(entity.school_id) !== Number(schoolId)) {
    throw new AppError(ERR.NOT_FOUND, message);
  }
  return true;
}

export function assertSchoolId(schoolId) {
  const id = Number(schoolId);
  if (!Number.isFinite(id) || id <= 0) throw new AppError(ERR.SCHOOL_REQUIRED, '缺少学校上下文');
  return id;
}
