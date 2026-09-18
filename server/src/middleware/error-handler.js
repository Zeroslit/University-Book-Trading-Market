// 全局错误处理：所有异常统一转为 { code, message, data, requestId }，并回写对应 HTTP 状态码
import { AppError, ERR, httpStatusOf } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { fail } from '../lib/response.js';

// 业务错误码决定 HTTP 状态；响应体 code 始终是唯一可信来源
function failWith(res, code, message, details = null) {
  res.status(httpStatusOf(code));
  return fail(res, code, message, details);
}

export function notFoundHandler(req, res) {
  return failWith(res, ERR.NOT_FOUND, `接口不存在：${req.method} ${req.originalUrl}`);
}

export function errorHandler(err, req, res, _next) {
  const requestId = res.locals.requestId || null;

  if (err instanceof AppError) {
    if (err.code >= 50000) logger.error('业务异常', { requestId, code: err.code, message: err.message });
    else logger.warn('业务失败', { requestId, code: err.code, message: err.message });
    return failWith(res, err.code, err.message, err.details);
  }

  // 参数校验（Zod 兜底：多数场景已被 validate 中间件转换）
  if (err?.name === 'ZodError') {
    return failWith(res, ERR.VALIDATION_ERROR, '参数校验失败', err.issues);
  }

  // 文件上传（multer）
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return failWith(res, ERR.FILE_TOO_LARGE, '图片体积超出限制，请压缩后重试');
  }
  if (err?.code === 'LIMIT_UNEXPECTED_FILE') {
    return failWith(res, ERR.VALIDATION_ERROR, '不支持的文件字段名（字段名应为 file）');
  }
  if (err?.message === 'UNSUPPORTED_TYPE') {
    return failWith(res, ERR.FILE_TYPE_INVALID, '仅支持 JPG/PNG/WebP 图片');
  }

  // 数据库唯一约束 -> 友好业务提示
  if (err?.code === 'ER_DUP_ENTRY') {
    const msg = String(err.message || '');
    if (msg.includes('uk_active_book')) return failWith(res, ERR.BOOK_NOT_AVAILABLE, '该教材已被其他买家下单，请刷新后重试');
    if (msg.includes('uk_school_student')) return failWith(res, ERR.STUDENT_NO_EXISTS, '该学号在本校已注册');
    if (msg.includes('uk_phone')) return failWith(res, ERR.PHONE_EXISTS, '该手机号已被注册');
    if (msg.includes('uk_idem')) return failWith(res, ERR.IDEMPOTENT_REPLAY, '重复请求，请勿重复提交');
    if (msg.includes('uk_report_no') || msg.includes('uk_reporter_target')) return failWith(res, ERR.DUPLICATE_REPORT, '你已举报过该内容，请勿重复举报');
    if (msg.includes('uk_school_code')) return failWith(res, ERR.CONFLICT, '学校编码已存在');
    if (msg.includes('uk_account')) return failWith(res, ERR.CONFLICT, '该收款账号已被绑定');
    return failWith(res, ERR.CONFLICT, '数据已存在，请勿重复提交');
  }
  if (err?.code === 'ER_NO_REFERENCED_ROW_2') {
    return failWith(res, ERR.VALIDATION_ERROR, '关联数据不存在');
  }
  if (err?.code === 'ER_LOCK_DEADLOCK' || err?.code === 'ER_LOCK_WAIT_TIMEOUT') {
    return failWith(res, ERR.CONFLICT, '操作过于频繁，请稍后重试');
  }
  if (err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.code === 'ER_ACCESS_DENIED_ERROR') {
    return failWith(res, ERR.DEPENDENCY_UNAVAILABLE, '依赖服务暂时不可用，请稍后重试');
  }

  logger.error('未捕获异常', { requestId, message: err?.message, stack: err?.stack });
  return failWith(res, ERR.INTERNAL, '服务器内部错误，请稍后重试');
}
