// 统一错误码与业务异常
export const ERR = {
  OK: 0,

  // 400xx 参数与校验
  VALIDATION_ERROR: 40001,
  SMS_CODE_INVALID: 40002,
  SMS_TOO_FREQUENT: 40003,
  FILE_TYPE_INVALID: 40004,
  FILE_TOO_LARGE: 40005,

  // 401xx 认证
  UNAUTHORIZED: 40101,
  TOKEN_EXPIRED: 40102,
  TOKEN_INVALID: 40103,
  PASSWORD_ERROR: 40104,

  // 403xx 权限与封禁
  FORBIDDEN: 40301,
  SCHOOL_REQUIRED: 40302,
  CROSS_SCHOOL_DENIED: 40303,
  VERIFICATION_REQUIRED: 40304,
  ACCOUNT_MUTED: 40305,
  TRADE_BANNED: 40306,
  LOGIN_BANNED: 40307,
  CREDIT_NOT_ALLOWED: 40308,
  COOLDOWN_ACTIVE: 40309,

  // 404xx 不存在（跨校访问统一返回 404，避免泄露存在性）
  NOT_FOUND: 40401,
  BOOK_NOT_FOUND: 40402,
  ORDER_NOT_FOUND: 40403,
  USER_NOT_FOUND: 40404,
  TARGET_NOT_FOUND: 40405,

  // 409xx 冲突与状态
  PHONE_EXISTS: 40901,
  STUDENT_NO_EXISTS: 40902,
  CONFLICT: 40903,
  BOOK_NOT_AVAILABLE: 40904,
  ORDER_STATE_INVALID: 40905,
  INSUFFICIENT_BALANCE: 40906,
  IDEMPOTENT_REPLAY: 40907,
  ALREADY_CLAIMED: 40908,
  DUPLICATE_REPORT: 40909,

  // 422xx 内容风控
  CONTENT_BLOCKED: 42201,
  CONTENT_BLOCKED_PENALTY: 42202,
  CONTENT_MASKED: 42203,

  // 429xx 限流
  RATE_LIMITED: 42901,

  // 500xx 系统
  INTERNAL: 50000,
  CONFIG_MISSING: 50001,
  DB_ERROR: 50002,
  DEPENDENCY_UNAVAILABLE: 50003,
};

// HTTP 状态码映射：业务错误码 -> HTTP 状态
const HTTP_STATUS = {
  40001: 400, 40002: 400, 40003: 429, 40004: 400, 40005: 400,
  40101: 401, 40102: 401, 40103: 401, 40104: 401,
  40301: 403, 40302: 403, 40303: 403, 40304: 403, 40305: 403,
  40306: 403, 40307: 403, 40308: 403, 40309: 429,
  40401: 404, 40402: 404, 40403: 404, 40404: 404, 40405: 404,
  40901: 409, 40902: 409, 40903: 409, 40904: 409, 40905: 409,
  40906: 409, 40907: 409, 40908: 409, 40909: 409,
  42201: 422, 42202: 422, 42203: 200,
  42901: 429,
  50000: 500, 50001: 500, 50002: 500, 50003: 503,
};

export class AppError extends Error {
  constructor(code, message, details = null) {
    super(message || '业务处理失败');
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.httpStatus = HTTP_STATUS[code] || 400;
  }
}

// 业务错误码 -> HTTP 状态（错误处理中间件统一使用，避免全部返回 200）
export function httpStatusOf(code) {
  return HTTP_STATUS[code] || 400;
}

// 常用快捷构造（中文提示，便于前端直接展示）
export const badRequest = (msg = '参数校验失败', details) => new AppError(ERR.VALIDATION_ERROR, msg, details);
export const unauthorized = (msg = '请先登录') => new AppError(ERR.UNAUTHORIZED, msg);
export const forbidden = (msg = '无权限执行该操作') => new AppError(ERR.FORBIDDEN, msg);
export const notFound = (msg = '数据不存在') => new AppError(ERR.NOT_FOUND, msg);
export const conflict = (msg = '操作冲突，请刷新后重试') => new AppError(ERR.CONFLICT, msg);
export const schoolRequired = (msg = '缺少学校上下文') => new AppError(ERR.SCHOOL_REQUIRED, msg);
