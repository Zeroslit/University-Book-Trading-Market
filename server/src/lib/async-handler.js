// 统一包裹 async 路由，异常交给全局错误中间件
export const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
