// 敏感数据保存期限清理：按 configs.retention 执行（禁止硬编码月数）
// 口径：客服会话/私信内容到期删除；审计日志到期删除；认证材料与举报证据到期脱敏（保留记录可追溯）
import { q, run } from '../db/tx.js';
import { pool } from '../db/pool.js';
import { configService } from '../services/config.service.js';
import { logger } from '../lib/logger.js';

const BATCH = 5000;

function monthsAgo(months) {
  return Math.max(1, Number(months) || 0);
}

export const retentionJob = {
  async run() {
    const policy = await configService.get('retention', null);
    const chatMonths = monthsAgo(policy.chatMonths);
    const evidenceMonths = monthsAgo(policy.evidenceMonths);
    const auditMonths = monthsAgo(policy.auditMonths);
    const verificationMonths = monthsAgo(policy.verificationMonths);

    // 1) 私信内容与客服会话消息：到期删除（保留会话壳，便于订单证据反查已裁定部分）
    const privateMsg = await run(
      pool,
      'DELETE FROM messages WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH) LIMIT ?',
      [chatMonths, BATCH],
    );
    const chatMsg = await run(
      pool,
      'DELETE FROM chat_messages WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH) LIMIT ?',
      [chatMonths, BATCH],
    );

    // 2) 审计日志：到期删除
    const audit = await run(
      pool,
      'DELETE FROM audit_logs WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH) LIMIT ?',
      [auditMonths, BATCH],
    );

    // 3) 学生认证材料：到期脱敏（学生证图片置空、校园邮箱打码），记录与审核结论保留
    const verify = await run(
      pool,
      `UPDATE user_verifications
          SET student_card_image_url = NULL,
              campus_email = IF(campus_email IS NULL, NULL, CONCAT('***@', SUBSTRING_INDEX(campus_email, '@', -1)))
        WHERE student_card_image_url IS NOT NULL
          AND submitted_at < DATE_SUB(NOW(3), INTERVAL ? MONTH)
        LIMIT ?`,
      [verificationMonths, BATCH],
    );

    // 4) 举报证据密文：到期清除，仅保留结论字段
    const evidence = await run(
      pool,
      'UPDATE reports SET evidence_enc = NULL WHERE evidence_enc IS NOT NULL AND created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH) LIMIT ?',
      [evidenceMonths, BATCH],
    );

    const result = {
      chatMonths,
      evidenceMonths,
      auditMonths,
      verificationMonths,
      purgedPrivateMessages: privateMsg.affectedRows || 0,
      purgedChatMessages: chatMsg.affectedRows || 0,
      purgedAuditLogs: audit.affectedRows || 0,
      maskedVerifications: verify.affectedRows || 0,
      clearedEvidence: evidence.affectedRows || 0,
    };
    logger.info('敏感数据保存期限清理完成', result);
    return result;
  },

  // 供管理后台/运维查看当前策略与待清理量
  async preview() {
    const policy = await configService.get('retention', null);
    const rows = await q(
      pool,
      `SELECT
         (SELECT COUNT(*) FROM messages WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH)) AS privateMessages,
         (SELECT COUNT(*) FROM chat_messages WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH)) AS chatMessages,
         (SELECT COUNT(*) FROM audit_logs WHERE created_at < DATE_SUB(NOW(3), INTERVAL ? MONTH)) AS auditLogs`,
      [monthsAgo(policy.chatMonths), monthsAgo(policy.chatMonths), monthsAgo(policy.auditMonths)],
    );
    return { policy, pending: rows[0] };
  },
};

export default retentionJob;
