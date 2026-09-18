// 钱包服务：wallet_transactions 是唯一事实来源（append-only）
// wallet_accounts.balance_cents/frozen_cents 仅作为同事务内更新的派生缓存
// 所有资金动作必须：1) 在事务中 2) 带幂等键 3) 写流水
import { AppError, ERR } from '../lib/errors.js';
import { generateNo } from '../lib/crypto.js';
import { q, q1, run, withTransaction } from '../db/tx.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

export const walletService = {
  async ensureAccount(conn, { userId, schoolId }) {
    await run(
      conn,
      'INSERT IGNORE INTO wallet_accounts (user_id, school_id, balance_cents, frozen_cents) VALUES (?, ?, 0, 0)',
      [userId, schoolId],
    );
  },

  async lockAccount(conn, userId) {
    const account = await q1(conn, 'SELECT * FROM wallet_accounts WHERE user_id = ? FOR UPDATE', [userId]);
    if (!account) throw new AppError(ERR.NOT_FOUND, '钱包账户不存在');
    return account;
  },

  /**
   * 统一资金写入口
   * @param {object} p
   * @param {object} p.conn 事务连接（禁止传 pool）
   * @param {'balance'|'frozen'} p.account
   * @param {'in'|'out'} p.direction
   * @param {number} p.amountCents
   * @param {string} p.bizType
   */
  async record({ conn, schoolId, userId, orderId = null, withdrawId = null, account = 'balance', direction, amountCents, bizType, idempotencyKey = null, remark = null }) {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new AppError(ERR.VALIDATION_ERROR, '资金金额必须为大于 0 的整数（分）');
    }
    if (!['balance', 'frozen'].includes(account)) throw new AppError(ERR.VALIDATION_ERROR, '资金账户类型非法');
    if (!['in', 'out'].includes(direction)) throw new AppError(ERR.VALIDATION_ERROR, '资金方向非法');

    await this.ensureAccount(conn, { userId, schoolId });
    const accountRow = await this.lockAccount(conn, userId);

    let balance = Number(accountRow.balance_cents);
    let frozen = Number(accountRow.frozen_cents);

    if (account === 'balance') balance = direction === 'in' ? balance + amount : balance - amount;
    else frozen = direction === 'in' ? frozen + amount : frozen - amount;

    if (balance < 0) throw new AppError(ERR.INSUFFICIENT_BALANCE, '可用余额不足，请先充值');
    if (frozen < 0) throw new AppError(ERR.INSUFFICIENT_BALANCE, '冻结金额不足，无法完成该操作');

    let txNo = generateNo('TX');
    try {
      await run(
        conn,
        `INSERT INTO wallet_transactions (tx_no, school_id, user_id, order_id, withdraw_id, account, direction,
           amount_cents, biz_type, status, balance_after_cents, frozen_after_cents, idempotency_key, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?, ?)`,
        [txNo, schoolId, userId, orderId, withdrawId, account, direction, amount, bizType, balance, frozen, idempotencyKey, remark],
      );
    } catch (err) {
      if (err?.code === 'ER_DUP_ENTRY' && idempotencyKey) {
        // 幂等命中：不重复扣款，直接返回既有流水
        const existed = await q1(conn, 'SELECT * FROM wallet_transactions WHERE idempotency_key = ?', [idempotencyKey]);
        logger.info('资金流水幂等命中', { idempotencyKey, bizType });
        return { idempotent: true, transaction: existed };
      }
      throw err;
    }

    await run(
      conn,
      'UPDATE wallet_accounts SET balance_cents = ?, frozen_cents = ?, version = version + 1 WHERE user_id = ?',
      [balance, frozen, userId],
    );

    return { idempotent: false, txNo, balance, frozen };
  },

  async account(userId) {
    const row = await q1(pool, 'SELECT balance_cents, frozen_cents, version FROM wallet_accounts WHERE user_id = ?', [userId]);
    return {
      balanceCents: Number(row?.balance_cents || 0),
      frozenCents: Number(row?.frozen_cents || 0),
      availableCents: Number(row?.balance_cents || 0),
    };
  },

  async transactions(userId, { orderId = null, bizType = null, page = 1, pageSize = 20 } = {}) {
    const where = ['user_id = ?'];
    const params = [userId];
    if (orderId) { where.push('order_id = ?'); params.push(orderId); }
    if (bizType) { where.push('biz_type = ?'); params.push(bizType); }
    const list = await q(
      pool,
      `SELECT id, tx_no, order_id, withdraw_id, account, direction, amount_cents, biz_type, status,
              balance_after_cents, frozen_after_cents, remark, created_at
       FROM wallet_transactions WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, `SELECT COUNT(*) AS total FROM wallet_transactions WHERE ${where.join(' AND ')}`, params);
    return { list, total: Number(total.total) };
  },

  // 模拟充值（一期不接入真实支付）
  async recharge({ userId, schoolId, amountCents, idempotencyKey = null, remark = '模拟充值' }) {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount <= 0) throw new AppError(ERR.VALIDATION_ERROR, '充值金额非法');
    if (amount > 5_000_00) throw new AppError(ERR.VALIDATION_ERROR, '单笔模拟充值上限 5000 元');
    return withTransaction((conn) => this.record({
      conn, schoolId, userId, account: 'balance', direction: 'in', amountCents: amount,
      bizType: 'recharge', idempotencyKey, remark,
    }));
  },

  /**
   * 提现申请：可用余额 -> 冻结（等待打款）
   * 约束：必须已绑定收款方式 + 已实名认证；档位决定到账时效（受限档位延迟 24h）
   */
  async withdraw({ userId, schoolId, amountCents, paymentAccountId, permissions, idempotencyKey = null }) {
    const amount = Number(amountCents);
    if (!Number.isInteger(amount) || amount < 100) throw new AppError(ERR.VALIDATION_ERROR, '提现金额至少 1 元');

    return withTransaction(async (conn) => {
      const account = await q1(
        conn,
        "SELECT * FROM payment_accounts WHERE id = ? AND user_id = ? AND school_id = ? AND status = 'active'",
        [paymentAccountId, userId, schoolId],
      );
      if (!account) throw new AppError(ERR.VALIDATION_ERROR, '请先绑定有效的收款方式后再提现');

      const user = await q1(conn, 'SELECT verification_status FROM users WHERE id = ? AND school_id = ?', [userId, schoolId]);
      if (user?.verification_status !== 'approved') {
        throw new AppError(ERR.VERIFICATION_REQUIRED, '完成实名/学生认证后才能提现');
      }

      const delayHours = Number(permissions?.withdrawDelayHours || 0);
      const arrivalType = delayHours > 0 ? 'delayed' : 'instant';
      const expectAt = delayHours > 0 ? new Date(Date.now() + delayHours * 3600000) : new Date();

      const result = await run(
        conn,
        `INSERT INTO withdraw_requests (withdraw_no, school_id, user_id, payment_account_id, amount_cents, status,
           arrival_type, expect_at, idempotency_key)
         VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        [generateNo('WD'), schoolId, userId, paymentAccountId, amount, arrivalType, expectAt, idempotencyKey],
      );

      await this.record({
        conn, schoolId, userId, withdrawId: result.insertId, account: 'balance', direction: 'out',
        amountCents: amount, bizType: 'withdraw_freeze', idempotencyKey: idempotencyKey ? `${idempotencyKey}:freeze` : null,
        remark: `提现冻结（${arrivalType === 'instant' ? '即时到账' : `${delayHours} 小时后到账`}）`,
      });
      await this.record({
        conn, schoolId, userId, withdrawId: result.insertId, account: 'frozen', direction: 'in',
        amountCents: amount, bizType: 'withdraw_freeze', idempotencyKey: idempotencyKey ? `${idempotencyKey}:frozen` : null,
        remark: '提现冻结',
      });

      return { withdrawId: result.insertId, amountCents: amount, arrivalType, expectAt };
    });
  },

  // 模拟打款完成（二期接真实代付通道）
  async settleWithdraw({ withdrawId, adminId = null }) {
    return withTransaction(async (conn) => {
      const wr = await q1(conn, 'SELECT * FROM withdraw_requests WHERE id = ? FOR UPDATE', [withdrawId]);
      if (!wr) throw new AppError(ERR.NOT_FOUND, '提现记录不存在');
      if (wr.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, `提现状态 ${wr.status} 不允许打款`);
      await run(conn, "UPDATE withdraw_requests SET status = 'paid', reviewed_by = ?, reviewed_at = NOW(3) WHERE id = ?", [adminId, withdrawId]);
      await this.record({
        conn, schoolId: wr.school_id, userId: wr.user_id, withdrawId, account: 'frozen', direction: 'out',
        amountCents: Number(wr.amount_cents), bizType: 'withdraw_paid', remark: '提现打款完成（模拟）',
      });
      return { withdrawId, status: 'paid' };
    });
  },

  async listWithdrawals(userId, { page = 1, pageSize = 20 } = {}) {
    const list = await q(
      pool,
      `SELECT id, withdraw_no, amount_cents, fee_cents, status, arrival_type, expect_at, reject_reason, created_at
       FROM withdraw_requests WHERE user_id = ? ORDER BY id DESC LIMIT ? OFFSET ?`,
      [userId, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, 'SELECT COUNT(*) AS total FROM withdraw_requests WHERE user_id = ?', [userId]);
    return { list, total: Number(total.total) };
  },

  // 对账：账户缓存必须等于流水求和
  async assertConsistency(userId) {
    const row = await q1(
      pool,
      `SELECT
         COALESCE(SUM(CASE WHEN account = 'balance' AND status = 'success' THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0) AS balance,
         COALESCE(SUM(CASE WHEN account = 'frozen' AND status = 'success' THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0) AS frozen
       FROM wallet_transactions WHERE user_id = ?`,
      [userId],
    );
    const account = await q1(pool, 'SELECT balance_cents, frozen_cents FROM wallet_accounts WHERE user_id = ?', [userId]);
    return {
      ok: Number(account?.balance_cents) === Number(row.balance) && Number(account?.frozen_cents) === Number(row.frozen),
      ledger: { balanceCents: Number(row.balance), frozenCents: Number(row.frozen) },
      account: { balanceCents: Number(account?.balance_cents || 0), frozenCents: Number(account?.frozen_cents || 0) },
    };
  },
};
