// 资金托管服务：支付托管 / 放款（扣服务费）/ 退款
// 全部动作在调用方事务内执行，并通过「订单号 + 阶段 + 账户」派生幂等键，天然防重复执行
import { AppError, ERR } from '../lib/errors.js';
import { walletService } from './wallet.service.js';
import { q1 } from '../db/tx.js';
import { pool } from '../db/pool.js';

export const escrowService = {
  // 平台服务费收款账户（种子数据中的 platform_admin 用户）
  async platformAccount() {
    const row = await q1(
      pool,
      "SELECT id, school_id FROM users WHERE role = 'platform_admin' AND deleted_at IS NULL ORDER BY id ASC LIMIT 1",
    );
    return row;
  },

  async assertPlatformAccount(conn) {
    const row = await q1(conn, "SELECT id FROM users WHERE role = 'platform_admin' AND deleted_at IS NULL ORDER BY id ASC LIMIT 1");
    if (!row) throw new AppError(ERR.CONFIG_MISSING, '平台服务费账户缺失，请先执行种子数据初始化');
    return row.id;
  },

  // 买家付款 -> 可用余额转托管冻结
  async hold(conn, { order }) {
    const base = `order:${order.id}:pay`;
    const out = await walletService.record({
      conn, schoolId: order.school_id, userId: order.buyer_id, orderId: order.id,
      account: 'balance', direction: 'out', amountCents: order.amount_cents,
      bizType: 'pay', idempotencyKey: `${base}:balance`, remark: `订单 ${order.order_no} 支付（转入托管）`,
    });
    const frozen = await walletService.record({
      conn, schoolId: order.school_id, userId: order.buyer_id, orderId: order.id,
      account: 'frozen', direction: 'in', amountCents: order.amount_cents,
      bizType: 'escrow_hold', idempotencyKey: `${base}:frozen`, remark: `订单 ${order.order_no} 资金托管冻结`,
    });
    return { out, frozen };
  },

  // 确认收货 -> 释放买家托管：卖家到账（已扣服务费）+ 平台服务费入账
  async release(conn, { order }) {
    const base = `order:${order.id}:release`;
    const amount = Number(order.amount_cents);
    const fee = Number(order.service_fee_cents);
    const income = Number(order.seller_income_cents);

    await walletService.record({
      conn, schoolId: order.school_id, userId: order.buyer_id, orderId: order.id,
      account: 'frozen', direction: 'out', amountCents: amount,
      bizType: 'escrow_release', idempotencyKey: `${base}:buyer-frozen`, remark: `订单 ${order.order_no} 确认收货，释放托管`,
    });
    await walletService.record({
      conn, schoolId: order.school_id, userId: order.seller_id, orderId: order.id,
      account: 'balance', direction: 'in', amountCents: income,
      bizType: 'settle', idempotencyKey: `${base}:seller`, remark: `订单 ${order.order_no} 放款（已扣服务费 ${(fee / 100).toFixed(2)} 元）`,
    });
    if (fee > 0) {
      const platformId = await this.assertPlatformAccount(conn);
      await walletService.record({
        conn, schoolId: order.school_id, userId: platformId, orderId: order.id,
        account: 'balance', direction: 'in', amountCents: fee,
        bizType: 'fee', idempotencyKey: `${base}:fee`, remark: `订单 ${order.order_no} 平台服务费`,
      });
    }
    return { settled: true, income, fee };
  },

  // 退款 -> 托管冻结解冻并退回买家可用余额
  async refund(conn, { order, amountCents = null, reason = '订单退款' }) {
    const base = `order:${order.id}:refund`;
    const amount = Number(amountCents ?? order.amount_cents);
    await walletService.record({
      conn, schoolId: order.school_id, userId: order.buyer_id, orderId: order.id,
      account: 'frozen', direction: 'out', amountCents: amount,
      bizType: 'refund', idempotencyKey: `${base}:frozen`, remark: `${reason}（释放托管）`,
    });
    await walletService.record({
      conn, schoolId: order.school_id, userId: order.buyer_id, orderId: order.id,
      account: 'balance', direction: 'in', amountCents: amount,
      bizType: 'refund', idempotencyKey: `${base}:balance`, remark: `${reason}（退回余额）`,
    });
    return { refunded: amount };
  },
};
