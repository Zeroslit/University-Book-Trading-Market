// 角色权限（RBAC）
import { AppError, ERR } from '../lib/errors.js';

export const ROLES = {
  STUDENT: 'student',
  SCHOOL_ADMIN: 'school_admin',
  SUPPORT: 'support',
  PLATFORM_ADMIN: 'platform_admin',
};

// 学校内管理角色（只能看本校）
export const SCHOOL_SCOPED_ROLES = [ROLES.STUDENT, ROLES.SCHOOL_ADMIN];
export const MODERATOR_ROLES = [ROLES.SCHOOL_ADMIN, ROLES.SUPPORT, ROLES.PLATFORM_ADMIN];
export const SUPPORT_ROLES = [ROLES.SUPPORT, ROLES.PLATFORM_ADMIN];
export const PLATFORM_ROLES = [ROLES.PLATFORM_ADMIN];

export function requireRoles(...roles) {
  const allowed = roles.flat();
  return (req, res, next) => {
    if (!req.user) return next(new AppError(ERR.UNAUTHORIZED, '请先登录'));
    if (!allowed.includes(req.user.role)) {
      return next(new AppError(ERR.FORBIDDEN, '当前角色无权访问该接口'));
    }
    return next();
  };
}

// 校管只能操作本校；客服/平台管理员可跨校（需显式 schoolId，由 schoolScope 负责）
export function requireSchoolModerator() {
  return (req, res, next) => {
    if (!req.user) return next(new AppError(ERR.UNAUTHORIZED, '请先登录'));
    if (!MODERATOR_ROLES.includes(req.user.role)) {
      return next(new AppError(ERR.FORBIDDEN, '仅管理员或客服可执行该操作'));
    }
    if (req.user.role === ROLES.SCHOOL_ADMIN && Number(req.user.schoolId) !== Number(req.schoolId)) {
      return next(new AppError(ERR.FORBIDDEN, '校管只能管理本校数据'));
    }
    return next();
  };
}
