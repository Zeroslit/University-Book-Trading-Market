// 参数校验：Zod Schema -> 统一错误码
import { AppError, ERR } from '../lib/errors.js';

function formatIssues(error) {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

export function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const issues = formatIssues(result.error);
      return next(new AppError(ERR.VALIDATION_ERROR, `参数校验失败：${issues[0].path || 'body'} ${issues[0].message}`, issues));
    }
    req[source] = result.data;
    return next();
  };
}

export const validateBody = (schema) => validate(schema, 'body');
export const validateQuery = (schema) => validate(schema, 'query');
export const validateParams = (schema) => validate(schema, 'params');

// 路径参数校验：非法 id（如 /books/undefined、/orders/abc）在进入 SQL 之前就被拦成 400，
// 避免 Number(NaN) 落到数据库层产生 500。用法：ensureNumericId(someRouter)
export function ensureNumericId(router, names = ['id']) {
  for (const name of names) {
    router.param(name, (req, res, next, value) => {
      if (!/^\d+$/.test(String(value))) {
        return next(new AppError(ERR.VALIDATION_ERROR, `路径参数 ${name} 必须为正整数`));
      }
      return next();
    });
  }
  return router;
}
