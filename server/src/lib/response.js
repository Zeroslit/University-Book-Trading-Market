// 统一响应体：{ code, message, data, requestId }
export function ok(res, data = null, message = 'ok') {
  return res.json({ code: 0, message, data, requestId: res.locals.requestId || null });
}

export function fail(res, code, message, details = null) {
  const body = { code, message, data: null, requestId: res.locals.requestId || null };
  if (details) body.details = details;
  return res.json(body);
}

// 分页响应
export function paged(list, total, page, pageSize) {
  return { list, total, page, pageSize, hasMore: page * pageSize < total };
}
