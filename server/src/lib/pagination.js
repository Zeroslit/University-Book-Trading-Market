// 分页与排序解析（带上限保护，避免深分页拖垮数据库）
import { badRequest } from './errors.js';

export function parsePagination(query = {}, { defaultSize = 20, maxSize = 100 } = {}) {
  const page = Math.max(1, Number.parseInt(query.page ?? 1, 10) || 1);
  const pageSize = Math.min(maxSize, Math.max(1, Number.parseInt(query.pageSize ?? defaultSize, 10) || defaultSize));
  return { page, pageSize, offset: (page - 1) * pageSize, limit: pageSize };
}

/**
 * 排序白名单：只允许代码里声明过的列，杜绝 SQL 注入
 * @param {string} input 形如 '-created_at' / 'price_cents'
 * @param {Record<string,string>} allowed 映射：前端字段 -> 数据库列
 */
export function parseSort(input, allowed, fallback) {
  if (!input) return fallback;
  const desc = String(input).startsWith('-');
  const key = String(input).replace(/^[-+]/, '');
  const column = allowed[key];
  if (!column) throw badRequest(`不支持的排序字段：${key}`, { allowed: Object.keys(allowed) });
  return { column, direction: desc ? 'DESC' : 'ASC' };
}

export function sortToSql(sort) {
  return ` ORDER BY ${sort.column} ${sort.direction}`;
}
