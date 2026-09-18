// 举报/投诉服务：举报 -> 受理 -> 48h 举证 -> 裁定 -> 处罚扣分 -> 3 天申诉期 -> 复审
// 只有「裁定成立」才计入违规次数；恶意投诉（裁定不成立）不计
import { AppError, ERR } from '../lib/errors.js';
import { configService } from './config.service.js';
import { penaltyService } from './penalty.service.js';
import { creditService } from './credit.service.js';
import { notifyService } from './notify.service.js';
import { auditService } from './audit.service.js';
import { encrypt, decrypt, generateNo } from '../lib/crypto.js';
import { q, q1, run } from '../db/tx.js';
import { pool } from '../db/pool.js';

// 举报对象 -> 被投诉人解析（全部按 school_id 过滤，防止跨校反查）
async function resolveTargetUser(conn, schoolId, targetType, targetId) {
  const tableMap = {
    book: { table: 'books', column: 'seller_id' },
    thread: { table: 'threads', column: 'author_id' },
    reply: { table: 'replies', column: 'author_id' },
    message: { table: 'messages', column: 'sender_id' },
    user: { table: 'users', column: 'id' },
  };
  if (targetType === 'order') {
    const order = await q1(conn, 'SELECT buyer_id, seller_id FROM orders WHERE id = ? AND school_id = ?', [targetId, schoolId]);
    if (!order) throw new AppError(ERR.TARGET_NOT_FOUND, '举报的订单不存在或不属于本校');
    return { targetUserId: order.seller_id, related: order };
  }
  const conf = tableMap[targetType];
  if (!conf) throw new AppError(ERR.VALIDATION_ERROR, `不支持的举报类型：${targetType}`);
  const row = await q1(conn, `SELECT ${conf.column} AS uid FROM ${conf.table} WHERE id = ? AND school_id = ?`, [targetId, schoolId]);
  if (!row) throw new AppError(ERR.TARGET_NOT_FOUND, '举报的内容不存在或不属于本校');
  return { targetUserId: row.uid, related: row };
}

export const reportService = {
  async create({ schoolId, reporterId, targetType, targetId, reason, description, evidence = null }) {
    const { targetUserId } = await resolveTargetUser(pool, schoolId, targetType, targetId);
    if (Number(targetUserId) === Number(reporterId)) {
      throw new AppError(ERR.VALIDATION_ERROR, '不能举报自己发布的内容');
    }
    const result = await run(
      pool,
      `INSERT INTO reports (report_no, school_id, reporter_id, target_type, target_id, target_user_id, reason, description, evidence_enc, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [generateNo('RP'), schoolId, reporterId, targetType, targetId, targetUserId, reason, description,
        evidence ? encrypt(JSON.stringify(evidence)) : null],
    );
    return { reportId: result.insertId, status: 'pending' };
  },

  // 受理：通知被投诉人 48 小时内举证
  async accept({ schoolId, reportId, handlerId }) {
    const proofHours = Number(await configService.get('order.report_proof_hours', schoolId));
    const report = await q1(pool, 'SELECT * FROM reports WHERE id = ? AND school_id = ?', [reportId, schoolId]);
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (report.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, `当前状态（${report.status}）不可受理`);

    await run(
      pool,
      `UPDATE reports SET status = 'proving', handler_id = ?, accepted_at = NOW(3),
         proof_deadline_at = DATE_ADD(NOW(3), INTERVAL ? HOUR) WHERE id = ? AND school_id = ?`,
      [handlerId, proofHours, reportId, schoolId],
    );
    await notifyService.notify(report.target_user_id, {
      schoolId, type: 'report', title: '你收到一条投诉',
      content: `有人举报你的内容（原因：${report.reason}），请在 ${proofHours} 小时内提交举证材料，逾期将按平台规则处理`,
      relatedType: 'report', relatedId: reportId,
    });
    await notifyService.notify(report.reporter_id, {
      schoolId, type: 'report', title: '举报已受理',
      content: `你的举报已受理，平台将在举证期结束后作出裁定`,
      relatedType: 'report', relatedId: reportId,
    });
    return { reportId, status: 'proving', proofDeadlineHours: proofHours };
  },

  async submitProof({ schoolId, reportId, userId, content }) {
    const report = await q1(pool, 'SELECT * FROM reports WHERE id = ? AND school_id = ?', [reportId, schoolId]);
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (Number(report.target_user_id) !== Number(userId)) throw new AppError(ERR.FORBIDDEN, '只有被投诉人可以提交举证');
    if (report.status !== 'proving') throw new AppError(ERR.ORDER_STATE_INVALID, '当前不在举证阶段');
    if (report.proof_deadline_at && new Date(report.proof_deadline_at) < new Date()) {
      throw new AppError(ERR.CONFLICT, '举证期限已过，如需补充材料请联系客服');
    }
    await run(pool, 'UPDATE reports SET proof_content = ? WHERE id = ? AND school_id = ?', [content, reportId, schoolId]);
    await notifyService.notify(report.reporter_id, {
      schoolId, type: 'report', title: '被投诉人已提交举证',
      content: '平台将在举证期结束后作出裁定',
      relatedType: 'report', relatedId: reportId,
    });
    return { reportId, status: 'proving' };
  },

  // 裁定：成立 -> 处罚 + 扣分 + 记违规 + 3 天申诉期；不成立 -> 不计违规
  async decide({ schoolId, reportId, handlerId, decision, note, severity = 'light', type = null, days = null }) {
    const appealDays = Number(await configService.get('report.appeal_days', schoolId));
    const report = await q1(pool, 'SELECT * FROM reports WHERE id = ? AND school_id = ?', [reportId, schoolId]);
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (!['accepted', 'proving'].includes(report.status)) {
      throw new AppError(ERR.ORDER_STATE_INVALID, `当前状态（${report.status}）不可裁定`);
    }
    if (!['valid', 'invalid'].includes(decision)) throw new AppError(ERR.VALIDATION_ERROR, '裁定结果只能是 valid 或 invalid');

    const { withTransaction } = await import('../db/tx.js');
    return withTransaction(async (conn) => {
      let penalty = null;
      if (decision === 'valid') {
        penalty = await penaltyService.apply({
          conn, userId: report.target_user_id, schoolId, reportId, severity, source: 'report',
          reason: `举报成立（${report.reason}）：${note || '经核实违规'}`, operatorId: handlerId,
          type, days, scoreDelta: null,
        });
      }
      await run(
        conn,
        `UPDATE reports SET status = 'decided', decision = ?, decision_note = ?, severity = ?, decided_at = NOW(3),
           appeal_deadline_at = DATE_ADD(NOW(3), INTERVAL ? DAY), handler_id = ? WHERE id = ? AND school_id = ?`,
        [decision, note, severity, appealDays, handlerId, reportId, schoolId],
      );
      await notifyService.notifyMany([report.reporter_id, report.target_user_id], {
        schoolId, type: 'report',
        title: decision === 'valid' ? '举报裁定：成立' : '举报裁定：不成立',
        content: decision === 'valid'
          ? `裁定成立，已对被投诉人执行处罚（${penalty?.step?.label || penalty?.step?.type}）。如有异议可在 ${appealDays} 天内申诉`
          : '经核实证据不足，本次举报不成立，不记为违规',
        relatedType: 'report', relatedId: reportId,
      });
      auditService.record({
        schoolId, actorId: handlerId, action: 'report.decide', targetType: 'report', targetId: reportId,
        detail: { decision, severity, penaltyId: penalty?.penaltyId ?? null },
      });
      return { reportId, decision, penalty, appealDays };
    });
  },

  async list({ schoolId, status = null, page = 1, pageSize = 20 }) {
    const where = ['school_id = ?'];
    const params = [schoolId];
    if (status) { where.push('status = ?'); params.push(status); }
    const list = await q(
      pool,
      `SELECT id, report_no, reporter_id, target_type, target_id, target_user_id, reason, status, severity,
              decision, handler_id, proof_deadline_at, decided_at, appeal_deadline_at, created_at
       FROM reports WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, `SELECT COUNT(*) AS total FROM reports WHERE ${where.join(' AND ')}`, params);
    return { list, total: Number(total.total) };
  },

  // 详情：证据为密文，只有管理员/客服可读，并记录敏感读取审计
  async detail({ schoolId, reportId, viewer }) {
    const report = await q1(pool, 'SELECT * FROM reports WHERE id = ? AND school_id = ?', [reportId, schoolId]);
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    const canSeeEvidence = ['school_admin', 'support', 'platform_admin'].includes(viewer?.role);
    if (canSeeEvidence) {
      auditService.record({
        schoolId, actorId: viewer.id, actorRole: viewer.role, action: 'report.read_evidence',
        targetType: 'report', targetId: reportId, ip: viewer.ip,
      });
    }
    return {
      ...report,
      evidence: canSeeEvidence && report.evidence_enc ? JSON.parse(decrypt(report.evidence_enc)) : undefined,
      evidence_enc: undefined,
    };
  },

  async stats({ schoolId }) {
    const rows = await q(
      pool,
      `SELECT status, severity, COUNT(*) AS total FROM reports WHERE school_id = ? GROUP BY status, severity`,
      [schoolId],
    );
    const penalties = await q1(
      pool,
      "SELECT COUNT(*) AS total FROM penalties WHERE school_id = ? AND status <> 'revoked'",
      [schoolId],
    );
    const validCount = await q1(
      pool,
      "SELECT COUNT(*) AS total FROM reports WHERE school_id = ? AND decision = 'valid'",
      [schoolId],
    );
    return { byStatus: rows, activePenalties: Number(penalties.total), validReports: Number(validCount.total) };
  },
};
