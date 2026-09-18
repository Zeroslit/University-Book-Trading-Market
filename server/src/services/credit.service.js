// 信誉分服务：100 分起始，加减分规则与档位权限全部来自 configs
// 约束：credit_logs 为事实来源（append-only），users.credit_score 只是派生缓存
import { AppError, ERR } from '../lib/errors.js';
import { configService } from './config.service.js';
import { q, q1, run } from '../db/tx.js';
import { pool } from '../db/pool.js';

const DEFAULT_BOUNDS = { min: 0, max: 100 };

export const creditService = {
  async getBounds(schoolId) {
    try {
      const bounds = await configService.get('credit.bounds', schoolId);
      return { min: Number(bounds.min), max: Number(bounds.max) };
    } catch {
      // 允许未配置边界（不影响核心规则）
      return DEFAULT_BOUNDS;
    }
  },

  // 由分值判定档位（满足 min 的最高档）
  async getTier(schoolId, score) {
    const cfg = await configService.get('credit.tiers', schoolId);
    const tiers = [...cfg.tiers].sort((a, b) => b.min - a.min);
    const found = tiers.find((t) => Number(score) >= Number(t.min)) || tiers[tiers.length - 1];
    return { key: found.key, label: found.label, min: found.min };
  },

  // 档位联动的权限（挂书数量、提现时效、能否发布、能否交易）
  async getPermissions(schoolId, userId) {
    const user = await q1(pool, 'SELECT credit_score FROM users WHERE id = ? AND school_id = ?', [userId, schoolId]);
    if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');
    const score = Number(user.credit_score);
    const tier = await this.getTier(schoolId, score);
    const permissionMap = await configService.get('credit.tier_permissions', schoolId);
    const permissions = permissionMap[tier.key] || {};
    return {
      score,
      tier: tier.key,
      tierLabel: tier.label,
      canPublish: permissions.canPublish !== false,
      canTrade: permissions.canTrade !== false,
      maxBooks: Number(permissions.maxBooks ?? 0),
      withdrawDelayHours: Number(permissions.withdrawDelayHours ?? 0),
    };
  },

  // 应用一条规则（ruleKey 对应 configs.credit.rules）
  async applyRule({ conn = pool, userId, schoolId, ruleKey, reason, relatedType = null, relatedId = null, operatorId = null, expiresAt = null, deltaOverride = null }) {
    const rules = await configService.get('credit.rules', schoolId);
    const delta = deltaOverride !== null ? Number(deltaOverride) : Number(rules[ruleKey]);
    if (!Number.isFinite(delta)) {
      throw new AppError(ERR.CONFIG_MISSING, `信誉分规则未配置：${ruleKey}`, { ruleKey });
    }
    return this.applyDelta({ conn, userId, schoolId, delta, ruleKey, reason, relatedType, relatedId, operatorId, expiresAt });
  },

  // 直接加减分（delta 为负数表示扣分）
  async applyDelta({ conn = pool, userId, schoolId, delta, ruleKey, reason, relatedType = null, relatedId = null, operatorId = null, expiresAt = null }) {
    const bounds = await this.getBounds(schoolId);
    const current = await q1(conn, 'SELECT credit_score FROM users WHERE id = ? AND school_id = ? FOR UPDATE', [userId, schoolId]);
    if (!current) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');

    const next = Math.max(bounds.min, Math.min(bounds.max, Number(current.credit_score) + Number(delta)));
    const actualDelta = next - Number(current.credit_score);

    await run(
      conn,
      `INSERT INTO credit_logs (user_id, school_id, delta, score_after, rule_key, reason, related_type, related_id, expires_at, operator_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [userId, schoolId, actualDelta, next, ruleKey, reason, relatedType, relatedId, expiresAt, operatorId],
    );
    await run(conn, 'UPDATE users SET credit_score = ? WHERE id = ? AND school_id = ?', [next, userId, schoolId]);
    return { scoreBefore: Number(current.credit_score), scoreAfter: next, delta: actualDelta };
  },

  // 申诉成功等场景：回滚指定规则产生的扣分（写反向流水，不修改历史记录）
  async rollback({ conn = pool, userId, schoolId, relatedType, relatedId, ruleKey = null, reason = '申诉通过，撤销处罚', operatorId = null }) {
    const params = [userId, schoolId, relatedType, relatedId];
    let sql = `SELECT id, delta FROM credit_logs
               WHERE user_id = ? AND school_id = ? AND related_type = ? AND related_id = ?
                 AND delta < 0 AND rolled_back = 0 AND rule_key <> 'rollback'`;
    if (ruleKey) { sql += ' AND rule_key = ?'; params.push(ruleKey); }

    const rows = await q(conn, sql, params);
    let total = 0;
    for (const row of rows) {
      await this.applyDelta({
        conn, userId, schoolId, delta: Math.abs(Number(row.delta)), ruleKey: 'rollback',
        reason, relatedType, relatedId, operatorId,
      });
      await run(conn, 'UPDATE credit_logs SET rolled_back = 1 WHERE id = ?', [row.id]);
      total += Math.abs(Number(row.delta));
    }
    return { rolledBack: total, count: rows.length };
  },

  // 从流水重算分值（对账/修复用）
  async reconcile(userId) {
    const rows = await q(
      pool,
      `SELECT COALESCE(SUM(delta), 0) AS total FROM credit_logs
       WHERE user_id = ? AND (expires_at IS NULL OR expires_at > NOW(3))`,
      [userId],
    );
    const bounds = DEFAULT_BOUNDS;
    const score = Math.max(bounds.min, Math.min(bounds.max, 100 + Number(rows[0].total)));
    await run(pool, 'UPDATE users SET credit_score = ? WHERE id = ?', [score, userId]);
    return score;
  },

  async listLogs(userId, { page = 1, pageSize = 20 } = {}) {
    const rows = await q(
      pool,
      `SELECT id, delta, score_after, rule_key, reason, related_type, related_id, expires_at, rolled_back, created_at
       FROM credit_logs WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [userId, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, 'SELECT COUNT(*) AS total FROM credit_logs WHERE user_id = ?', [userId]);
    return { list: rows, total: Number(total.total) };
  },
};
