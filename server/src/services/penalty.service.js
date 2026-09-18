// 处罚服务：梯度全部来自 configs.penalty.escalation
// 计数口径：
//   - 仅统计「裁定成立」产生的处罚（reports.decision = valid）
//   - 轻度违规 12 个月滚动过期；连续 6 个月无违规可消除 1 次；严重违规永久保留
//   - 申诉成功 -> 处罚置 revoked + 回滚信誉分
import { AppError, ERR } from '../lib/errors.js';
import { configService } from './config.service.js';
import { creditService } from './credit.service.js';
import { q, q1, run } from '../db/tx.js';
import { pool } from '../db/pool.js';

const BAN_FIELD = {
  mute: 'mute_until',
  trade_ban: 'trade_ban_until',
  login_ban: 'login_ban_until',
};

function monthsBetween(from, to = new Date()) {
  const a = new Date(from);
  const b = new Date(to);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
}

export const penaltyService = {
  // 计算「有效违规次数」（用于梯度判定）
  async countEffectiveViolations(conn, { userId, schoolId }) {
    const expireMonths = Number(await configService.get('credit.light_violation_expire_months', schoolId));
    const cleanMonthsClear = Number(await configService.get('credit.clean_months_clear_count', schoolId));

    const rows = await q(
      conn,
      `SELECT id, severity, type, start_at, status FROM penalties
       WHERE user_id = ? AND school_id = ? AND status <> 'revoked' ORDER BY start_at ASC`,
      [userId, schoolId],
    );
    if (rows.length === 0) {
      return { effectiveCount: 0, total: rows.length, activeCount: 0, expiredCount: 0, severeCount: 0, reduction: 0 };
    }

    const active = rows.filter((r) => r.severity === 'severe' || monthsBetween(r.start_at) < expireMonths);
    const expiredCount = rows.length - active.length;
    const severeCount = active.filter((r) => r.severity === 'severe').length;

    // 连续无违规月数（以最近一次处罚起算）可消除计数
    const lastAt = active.length > 0 ? active[active.length - 1].start_at : rows[rows.length - 1].start_at;
    const clean = monthsBetween(lastAt);
    const reduction = cleanMonthsClear > 0 ? Math.floor(clean / cleanMonthsClear) : 0;

    const reducible = active.length - severeCount;
    const effectiveCount = severeCount + Math.max(0, reducible - reduction);

    return { effectiveCount, total: rows.length, activeCount: active.length, expiredCount, severeCount, reduction, cleanMonths: clean };
  },

  // 根据累计次数与严重程度决定处罚动作
  async decideAction(schoolId, effectiveCount, severity) {
    const cfg = await configService.get('penalty.escalation', schoolId);
    const steps = [...cfg.steps].sort((a, b) => a.times - b.times);
    if (severity === 'severe' && cfg.severeInstantBan) {
      return { ...steps[steps.length - 1], type: 'permanent_ban', days: null, reason: '严重违规一票永久封禁' };
    }
    return steps.find((s) => s.times >= effectiveCount) || steps[steps.length - 1];
  },

  // 执行处罚（由举报裁定 / 违禁词 L3 L4 / 后台一键处罚 调用）
  async apply({ conn = pool, userId, schoolId, reportId = null, severity = 'light', reason, operatorId = null, source = 'report', type = null, days = null, scoreDelta = null }) {
    const counter = await this.countEffectiveViolations(conn, { userId, schoolId });
    const effectiveCount = counter.effectiveCount + 1;
    const step = type
      ? { type, days, scoreDelta: scoreDelta ?? 0, label: '人工处罚' }
      : await this.decideAction(schoolId, effectiveCount, severity);

    const endAt = step.days ? new Date(Date.now() + Number(step.days) * 86400000) : null;
    const result = await run(
      conn,
      `INSERT INTO penalties (user_id, school_id, report_id, type, severity, effective_count, reason, start_at, end_at, status, operator_id, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW(3), ?, 'active', ?, ?)`,
      [userId, schoolId, reportId, step.type, severity, effectiveCount, reason, endAt, operatorId, source],
    );
    const penaltyId = result.insertId;

    await this.applyBanFields(conn, { userId, type: step.type, days: step.days, permanent: step.type === 'permanent_ban' });

    const delta = Number(step.scoreDelta || 0);
    if (delta !== 0) {
      await creditService.applyDelta({
        conn, userId, schoolId, delta,
        ruleKey: delta < 0 ? 'report_light' : 'adjust',
        reason: `${reason}（${step.label || step.type}）`,
        relatedType: 'penalty', relatedId: penaltyId, operatorId,
        expiresAt: severity === 'severe' ? null : new Date(Date.now() + 365 * 86400000),
      });
    }

    return { penaltyId, step, effectiveCount, endAt, creditDelta: delta, counter };
  },

  // 直接封禁（后台一键处罚 / 违禁词 L4 / 人工客服仲裁）
  async applyBanFields(conn, { userId, type, days = null, permanent = false }) {
    if (permanent || type === 'permanent_ban') {
      await run(conn, "UPDATE users SET banned_permanently = 1, status = 'banned' WHERE id = ?", [userId]);
      return;
    }
    const field = BAN_FIELD[type];
    if (!field) return; // warning 等不改变封禁字段
    const until = days ? new Date(Date.now() + Number(days) * 86400000) : null;
    if (!until) return;
    await run(
      conn,
      `UPDATE users SET ${field} = GREATEST(COALESCE(${field}, NOW(3)), ?),
         status = CASE WHEN ? = 'login_ban' THEN 'banned' ELSE status END
       WHERE id = ?`,
      [until, type, userId],
    );
  },

  // 撤销处罚（申诉通过 / 管理员纠正）：清空封禁字段并回滚信誉分
  async revoke({ conn = pool, penaltyId, reviewerId = null, reason = '申诉通过，撤销处罚', rollbackCredit = true }) {
    const penalty = await q1(conn, 'SELECT * FROM penalties WHERE id = ? FOR UPDATE', [penaltyId]);
    if (!penalty) throw new AppError(ERR.NOT_FOUND, '处罚记录不存在');
    if (penalty.status === 'revoked') return { alreadyRevoked: true, penaltyId };

    await run(conn, "UPDATE penalties SET status = 'revoked', appeal_status = 'approved' WHERE id = ?", [penaltyId]);

    const { user_id: userId, school_id: schoolId, type } = penalty;
    if (type === 'permanent_ban') {
      await run(conn, "UPDATE users SET banned_permanently = 0, status = 'active' WHERE id = ?", [userId]);
    } else if (BAN_FIELD[type]) {
      const field = BAN_FIELD[type];
      await run(conn, `UPDATE users SET ${field} = NULL, status = CASE WHEN status = 'banned' THEN 'active' ELSE status END WHERE id = ?`, [userId]);
    }

    if (rollbackCredit) {
      await creditService.rollback({
        conn, userId, schoolId, relatedType: 'penalty', relatedId: penaltyId,
        reason, operatorId: reviewerId,
      });
    }
    return { penaltyId, userId, schoolId, revoked: true };
  },

  async listByUser(userId, { page = 1, pageSize = 20 } = {}) {
    const list = await q(
      pool,
      `SELECT id, type, severity, effective_count, reason, start_at, end_at, status, appeal_status, source, created_at
       FROM penalties WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [userId, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, 'SELECT COUNT(*) AS total FROM penalties WHERE user_id = ?', [userId]);
    return { list, total: Number(total.total) };
  },

  // 定时任务：过期处罚置 expired 并清理封禁开关
  async sweepExpired() {
    const rows = await q(
      pool,
      `SELECT id, user_id, type FROM penalties
       WHERE status = 'active' AND end_at IS NOT NULL AND end_at <= NOW(3) LIMIT 200`,
    );
    for (const row of rows) {
      await run(pool, "UPDATE penalties SET status = 'expired' WHERE id = ?", [row.id]);
      if (BAN_FIELD[row.type]) {
        await run(
          pool,
          `UPDATE users SET ${BAN_FIELD[row.type]} = NULL,
             status = CASE WHEN banned_permanently = 1 THEN 'banned'
                           WHEN mute_until > NOW(3) OR trade_ban_until > NOW(3) OR login_ban_until > NOW(3) THEN 'banned'
                           ELSE 'active' END
           WHERE id = ?`,
          [row.user_id],
        );
      }
    }
    return rows.length;
  },
};
