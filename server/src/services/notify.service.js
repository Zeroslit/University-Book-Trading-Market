// 通知服务：站内信（必达）+ 微信订阅消息（一期为模拟适配器）
import { execute, query } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { config } from '../config/index.js';

export const notifyService = {
  async notify(userId, payload) {
    const { schoolId, type, title, content, relatedType = null, relatedId = null, channel = 'inbox' } = payload;
    if (!userId || !schoolId) {
      logger.warn('通知缺少必要参数，已跳过', { userId, schoolId, type });
      return null;
    }
    const result = await execute(
      `INSERT INTO notifications (school_id, user_id, type, title, content, channel, related_type, related_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sent')`,
      [schoolId, userId, type, title, content, channel, relatedType, relatedId],
    );
    // 微信订阅消息：一期模拟（记录日志，不真正推送）
    await this.sendWechatSubscribe(userId, { type, title, content });
    return result.insertId;
  },

  async notifyMany(userIds, payload) {
    const unique = [...new Set((userIds || []).filter(Boolean))];
    for (const userId of unique) {
      // eslint-disable-next-line no-await-in-loop
      await this.notify(userId, payload);
    }
  },

  async sendWechatSubscribe(userId, payload) {
    if (!config.wechat.mock) {
      // 二期：调用微信订阅消息接口（需用户授权模板）
      logger.info('微信订阅消息（真实通道未接入）', { userId, type: payload.type });
      return { sent: false, reason: 'wechat_not_configured' };
    }
    logger.debug('模拟微信订阅消息', { userId, title: payload.title });
    return { sent: true, mock: true };
  },

  async list(userId, { isRead = null, type = null, page = 1, pageSize = 20 }) {
    const where = ['user_id = ?'];
    const params = [userId];
    if (isRead !== null) { where.push('is_read = ?'); params.push(isRead ? 1 : 0); }
    if (type) { where.push('type = ?'); params.push(type); }
    const rows = await query(
      `SELECT id, type, title, content, related_type, related_id, is_read, sent_at
       FROM notifications WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    return rows;
  },

  async unreadCount(userId) {
    const rows = await query('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND is_read = 0', [userId]);
    return Number(rows[0]?.total || 0);
  },

  async markRead(userId, id = null) {
    if (id) {
      await execute('UPDATE notifications SET is_read = 1, read_at = NOW(3) WHERE id = ? AND user_id = ?', [id, userId]);
    } else {
      await execute('UPDATE notifications SET is_read = 1, read_at = NOW(3) WHERE user_id = ? AND is_read = 0', [userId]);
    }
  },
};
