// 审计留痕：管理动作、跨校访问、敏感数据读取都必须记录
import { execute, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export const auditService = {
  // 异步写入，不阻塞主流程；失败只记日志
  record(payload) {
    const {
      schoolId = null, actorId = null, actorRole = null, action, targetType = null,
      targetId = null, detail = null, ip = null, userAgent = null,
    } = payload || {};
    if (!action) return;
    execute(
      `INSERT INTO audit_logs (school_id, actor_id, actor_role, action, target_type, target_id, detail, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)`,
      [schoolId, actorId, actorRole, action, targetType, targetId,
        detail ? JSON.stringify(detail) : null, ip, userAgent],
    ).catch((err) => logger.warn('审计日志写入失败', { error: err.message, action }));
  },

  async list({ schoolId = null, actorId = null, action = null, page = 1, pageSize = 20 }) {
    const where = [];
    const params = [];
    if (schoolId) { where.push('school_id = ?'); params.push(schoolId); }
    if (actorId) { where.push('actor_id = ?'); params.push(actorId); }
    if (action) { where.push('action = ?'); params.push(action); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await query(
      `SELECT * FROM audit_logs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    return rows;
  },
};
