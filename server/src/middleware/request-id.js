// 请求 ID：贯穿日志、响应与错误排查
import crypto from 'node:crypto';

export function requestId(req, res, next) {
  const id = req.get('X-Request-Id') || crypto.randomUUID();
  res.locals.requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}
