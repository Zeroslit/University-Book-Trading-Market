// 工单服务：队列 / 抢单 / 快捷回复 / SLA 超时升级 / 统计
// SLA 与是否自动升级全部来自 configs.ticket.sla 与 configs.ticket.auto_escalate
import { AppError, ERR } from '../lib/errors.js';
import { configService } from './config.service.js';
import { notifyService } from './notify.service.js';
import { generateNo } from '../lib/crypto.js';
import { q, q1, run, withTransaction } from '../db/tx.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

const URGENT_TYPES = ['refund', 'order'];

async function slaOf(schoolId, type) {
  const sla = await configService.get('ticket.sla', schoolId);
  return URGENT_TYPES.includes(type) ? sla.urgent : sla.normal;
}

async function log(conn, { ticketId, schoolId, action, operatorId = null, operatorType = 'system', fromStatus = null, toStatus = null, note = null }) {
  await run(
    conn,
    `INSERT INTO ticket_logs (ticket_id, school_id, action, operator_id, operator_type, from_status, to_status, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [ticketId, schoolId, action, operatorId, operatorType, fromStatus, toStatus, note],
  );
}

export const ticketService = {
  async create({ schoolId, source = 'user', type = 'other', subject, description = null, relatedOrderId = null, relatedUserId = null, reporterId = null, priority = null, conn = pool }) {
    const sla = await slaOf(schoolId, type);
    const finalPriority = priority || (URGENT_TYPES.includes(type) ? 'urgent' : 'normal');
    const result = await run(
      conn,
      `INSERT INTO tickets (ticket_no, school_id, source, type, priority, subject, description, related_order_id,
         related_user_id, reporter_id, status, first_response_due_at, resolve_due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
         DATE_ADD(NOW(3), INTERVAL ? HOUR), DATE_ADD(NOW(3), INTERVAL ? HOUR))`,
      [generateNo('TK'), schoolId, source, type, finalPriority, subject, description, relatedOrderId, relatedUserId, reporterId,
        Number(sla.firstResponseHours), Number(sla.resolveHours)],
    );
    const ticketId = result.insertId;
    await log(conn, { ticketId, schoolId, action: 'create', operatorId: reporterId, operatorType: source === 'ai' ? 'ai' : 'user', toStatus: 'pending', note: subject });

    const autoEscalate = await configService.get('ticket.auto_escalate', schoolId);
    if (autoEscalate && finalPriority === 'urgent') {
      await log(conn, { ticketId, schoolId, action: 'escalate', operatorType: 'system', fromStatus: 'pending', toStatus: 'pending', note: '资金类工单，自动标记加急' });
      await run(conn, "UPDATE tickets SET escalated = 1, escalated_at = NOW(3) WHERE id = ?", [ticketId]);
    }
    if (reporterId) {
      await notifyService.notify(reporterId, {
        schoolId, type: 'ticket', title: '工单已创建',
        content: `工单 ${ticketId} 已创建，${finalPriority === 'urgent' ? '资金类问题将在 4 小时内响应' : '我们将在 24 小时内响应'}`,
        relatedType: 'ticket', relatedId: ticketId,
      });
    }
    return { ticketId, priority: finalPriority, sla };
  },

  // 抢单：乐观锁（只有未被接单时才能抢到）
  async claim({ schoolId, ticketId, staffId }) {
    return withTransaction(async (conn) => {
      const ticket = await q1(conn, 'SELECT * FROM tickets WHERE id = ? AND school_id = ? FOR UPDATE', [ticketId, schoolId]);
      if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
      if (ticket.assignee_id && Number(ticket.assignee_id) !== Number(staffId)) {
        throw new AppError(ERR.ALREADY_CLAIMED, '该工单已被其他客服接单');
      }
      const result = await run(
        conn,
        `UPDATE tickets SET assignee_id = ?, status = CASE WHEN status IN ('pending','escalated') THEN 'processing' ELSE status END
         WHERE id = ? AND school_id = ? AND (assignee_id IS NULL OR assignee_id = ?)`,
        [staffId, ticketId, schoolId, staffId],
      );
      if (result.affectedRows === 0) throw new AppError(ERR.ALREADY_CLAIMED, '该工单已被其他客服接单');
      await log(conn, { ticketId, schoolId, action: 'claim', operatorId: staffId, operatorType: 'staff', fromStatus: ticket.status, toStatus: 'processing', note: '客服接单' });
      return { ticketId, assigneeId: staffId, status: 'processing' };
    });
  },

  async reply({ schoolId, ticketId, staffId, content, quickReplyKey = null }) {
    return withTransaction(async (conn) => {
      const ticket = await q1(conn, 'SELECT * FROM tickets WHERE id = ? AND school_id = ? FOR UPDATE', [ticketId, schoolId]);
      if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
      // 首次响应时间用于 SLA 统计
      if (!ticket.first_response_at) {
        await run(conn, 'UPDATE tickets SET first_response_at = NOW(3) WHERE id = ? AND school_id = ?', [ticketId, schoolId]);
      }
      await log(conn, { ticketId, schoolId, action: 'reply', operatorId: staffId, operatorType: 'staff', note: content });
      if (ticket.reporter_id) {
        await notifyService.notify(ticket.reporter_id, {
          schoolId, type: 'ticket', title: `工单 ${ticketId} 有新回复`,
          content, relatedType: 'ticket', relatedId: ticketId,
        });
      }
      return { ticketId, replied: true, quickReplyKey };
    });
  },

  async resolve({ schoolId, ticketId, staffId, resolution }) {
    return withTransaction(async (conn) => {
      const ticket = await q1(conn, 'SELECT * FROM tickets WHERE id = ? AND school_id = ? FOR UPDATE', [ticketId, schoolId]);
      if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
      if (['resolved', 'closed'].includes(ticket.status)) throw new AppError(ERR.ORDER_STATE_INVALID, '工单已结束');
      await run(
        conn,
        "UPDATE tickets SET status = 'resolved', resolution = ?, closed_at = NOW(3), assignee_id = COALESCE(assignee_id, ?) WHERE id = ? AND school_id = ?",
        [resolution, staffId, ticketId, schoolId],
      );
      await log(conn, { ticketId, schoolId, action: 'resolve', operatorId: staffId, operatorType: 'staff', fromStatus: ticket.status, toStatus: 'resolved', note: resolution });
      if (ticket.reporter_id) {
        await notifyService.notify(ticket.reporter_id, {
          schoolId, type: 'ticket', title: '工单已处理完成',
          content: `工单 ${ticketId} 处理结果：${resolution}`, relatedType: 'ticket', relatedId: ticketId,
        });
      }
      return { ticketId, status: 'resolved' };
    });
  },

  async escalate({ schoolId, ticketId, operatorId = null, note = '人工升级' }) {
    return withTransaction(async (conn) => {
      const ticket = await q1(conn, 'SELECT * FROM tickets WHERE id = ? AND school_id = ? FOR UPDATE', [ticketId, schoolId]);
      if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
      await run(conn, "UPDATE tickets SET escalated = 1, escalated_at = NOW(3), priority = 'urgent' WHERE id = ? AND school_id = ?", [ticketId, schoolId]);
      await log(conn, { ticketId, schoolId, action: 'escalate', operatorId, operatorType: operatorId ? 'staff' : 'system', fromStatus: ticket.status, toStatus: ticket.status, note });
      if (ticket.reporter_id) {
        await notifyService.notify(ticket.reporter_id, {
          schoolId, type: 'ticket', title: '你的工单已加急',
          content: `工单 ${ticketId} 已升级为加急处理，我们会优先响应`, relatedType: 'ticket', relatedId: ticketId,
        });
      }
      return { ticketId, escalated: true };
    });
  },

  // 定时任务：SLA 超时自动升级
  async autoEscalateDue({ limit = 100 } = {}) {
    const autoEscalate = await configService.get('ticket.auto_escalate', null).catch(() => true);
    if (!autoEscalate) return 0;
    const rows = await q(
      pool,
      `SELECT id, school_id FROM tickets
       WHERE escalated = 0 AND status IN ('pending', 'processing')
         AND ((first_response_at IS NULL AND first_response_due_at <= NOW(3)) OR resolve_due_at <= NOW(3))
       LIMIT ?`,
      [Number(limit)],
    );
    for (const row of rows) {
      try {
        await this.escalate({ schoolId: row.school_id, ticketId: row.id, operatorId: null, note: 'SLA 超时，系统自动升级' });
      } catch (err) {
        logger.warn('工单自动升级失败', { ticketId: row.id, error: err.message });
      }
    }
    return rows.length;
  },

  async list({ schoolId, status = null, assigneeId = null, priority = null, page = 1, pageSize = 20 }) {
    const where = ['school_id = ?'];
    const params = [schoolId];
    if (status) { where.push('status = ?'); params.push(status); }
    if (assigneeId) { where.push('assignee_id = ?'); params.push(assigneeId); }
    if (priority) { where.push('priority = ?'); params.push(priority); }
    const list = await q(
      pool,
      `SELECT id, ticket_no, source, type, priority, subject, status, assignee_id, escalated,
              first_response_at, first_response_due_at, resolve_due_at,
              TIMESTAMPDIFF(MINUTE, NOW(3), first_response_due_at) AS first_response_left_minutes,
              created_at
       FROM tickets WHERE ${where.join(' AND ')}
       ORDER BY (priority = 'urgent') DESC, COALESCE(first_response_at, first_response_due_at) ASC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, `SELECT COUNT(*) AS total FROM tickets WHERE ${where.join(' AND ')}`, params);
    return { list, total: Number(total.total) };
  },

  // 客服一屏：工单 + 关联订单快照 + 用户风控信息
  async detail({ schoolId, ticketId, viewer }) {
    const { orderService } = await import('./order.service.js');
    const ticket = await q1(pool, 'SELECT * FROM tickets WHERE id = ? AND school_id = ?', [ticketId, schoolId]);
    if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
    const logs = await q(pool, 'SELECT * FROM ticket_logs WHERE ticket_id = ? AND school_id = ? ORDER BY id ASC', [ticketId, schoolId]);

    let orderSnapshot = null;
    if (ticket.related_order_id) {
      const order = await q1(pool, 'SELECT * FROM orders WHERE id = ? AND school_id = ?', [ticket.related_order_id, schoolId]);
      if (order) {
        const statusLogs = await q(pool, 'SELECT from_status, to_status, action, reason, created_at FROM order_status_log WHERE order_id = ? ORDER BY id ASC', [order.id]);
        const transactions = await q(pool, 'SELECT tx_no, user_id, account, direction, amount_cents, biz_type, remark FROM wallet_transactions WHERE order_id = ? ORDER BY id ASC', [order.id]);
        orderSnapshot = { order, statusLogs, transactions };
      }
    }

    let userRisk = null;
    if (ticket.related_user_id || ticket.reporter_id) {
      const uid = ticket.related_user_id || ticket.reporter_id;
      const user = await q1(
        pool,
        'SELECT id, nickname, role, status, verification_status, credit_score, mute_until, trade_ban_until, login_ban_until, banned_permanently, student_no_mask FROM users WHERE id = ? AND (school_id = ? OR school_id IS NULL)',
        [uid, schoolId],
      );
      const penalties = user ? await q(pool, 'SELECT id, type, severity, effective_count, reason, status, start_at, end_at FROM penalties WHERE user_id = ? ORDER BY id DESC LIMIT 10', [uid]) : [];
      const reports = user ? await q(pool, "SELECT id, report_no, decision, reason, decided_at FROM reports WHERE target_user_id = ? AND school_id = ? ORDER BY id DESC LIMIT 10", [uid, schoolId]) : [];
      userRisk = { user, penalties, reports };
    }
    if (viewer) {
      const { auditService } = await import('./audit.service.js');
      auditService.record({ schoolId, actorId: viewer.id, actorRole: viewer.role, action: 'ticket.view_snapshot', targetType: 'ticket', targetId: ticketId, ip: viewer.ip });
    }
    return { ticket, logs, orderSnapshot, userRisk };
  },

  async stats({ schoolId }) {
    const rows = await q(
      pool,
      `SELECT status, priority, COUNT(*) AS total,
              SUM(CASE WHEN first_response_at IS NOT NULL AND first_response_due_at IS NOT NULL AND first_response_at <= first_response_due_at THEN 1 ELSE 0 END) AS on_time,
              SUM(CASE WHEN escalated = 1 THEN 1 ELSE 0 END) AS escalated
       FROM tickets WHERE school_id = ? GROUP BY status, priority`,
      [schoolId],
    );
    const overdue = await q1(
      pool,
      `SELECT COUNT(*) AS total FROM tickets
       WHERE school_id = ? AND status IN ('pending','processing') AND resolve_due_at <= NOW(3)`,
      [schoolId],
    );
    return { groups: rows, overdue: Number(overdue.total) };
  },
};
