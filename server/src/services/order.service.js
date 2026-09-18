// 订单服务：状态机编排 + 托管资金 + 通知 + 信誉分
// 并发防护：
//   1) 下单时 SELECT ... FOR UPDATE 锁图书行
//   2) orders.active_book_id 生成列唯一索引兜底（同一本书只能有一个进行中订单）
//   3) 状态流转用 WHERE status = ? 条件更新（乐观锁）
import { AppError, ERR } from '../lib/errors.js';
import { configService } from './config.service.js';
import { assertTransition, assertAffected } from '../lib/state-machine.js';
import { generateNo } from '../lib/crypto.js';
import { q, q1, run, withTransaction } from '../db/tx.js';
import { pool } from '../db/pool.js';
import { walletService } from './wallet.service.js';
import { escrowService } from './escrow.service.js';
import { notifyService } from './notify.service.js';
import { creditService } from './credit.service.js';
import { withIdempotency } from '../lib/idempotency.js';
import { logger } from '../lib/logger.js';

const ACTIVE_STATUSES = ['pending_payment', 'paid', 'shipped', 'refund_requested', 'return_requested', 'disputed'];

async function machineOf(schoolId) {
  return configService.get('order.state_machine', schoolId);
}

// 服务费比例：学校配置优先（schools.service_fee_bps），否则用平台默认
async function resolveFeeBps(schoolId) {
  const school = await q1(pool, 'SELECT service_fee_bps FROM schools WHERE id = ?', [schoolId]);
  if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在或未开通');
  const fallback = await configService.get('order.service_fee_bps', schoolId);
  return Number(school.service_fee_bps ?? fallback);
}

function assertParty(order, userId, role) {
  if (role === 'buyer' && Number(order.buyer_id) !== Number(userId)) {
    throw new AppError(ERR.FORBIDDEN, '只有买家可以执行该操作');
  }
  if (role === 'seller' && Number(order.seller_id) !== Number(userId)) {
    throw new AppError(ERR.FORBIDDEN, '只有卖家可以执行该操作');
  }
}

async function logTransition(conn, { order, fromStatus, toStatus, action, operatorId = null, operatorRole = null, reason = null }) {
  await run(
    conn,
    `INSERT INTO order_status_log (order_id, school_id, from_status, to_status, action, operator_id, operator_role, reason, snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON))`,
    [order.id, order.school_id, fromStatus, toStatus, action, operatorId, operatorRole, reason,
      JSON.stringify({
        orderNo: order.order_no, amountCents: order.amount_cents, status: toStatus,
        escrowStatus: order.escrow_status, bookId: order.book_id,
      })],
  );
}

// 状态流转（乐观锁）：只有处于期望状态时才更新
async function transition(conn, { order, from, to, extraSql = '', extraParams = [] }) {
  const result = await run(
    conn,
    `UPDATE orders SET status = ?, version = version + 1 ${extraSql} WHERE id = ? AND school_id = ? AND status = ?`,
    [to, ...extraParams, order.id, order.school_id, from],
  );
  assertAffected(result.affectedRows, ERR.ORDER_STATE_INVALID, `订单状态已变更（期望 ${from}），请刷新后重试`);
}

async function setBookStatus(conn, { schoolId, bookId, from, to }) {
  if (from && from.length > 0) {
    await run(
      conn,
      `UPDATE books SET status = ? WHERE id = ? AND school_id = ? AND status IN (${from.map(() => '?').join(',')})`,
      [to, bookId, schoolId, ...from],
    );
  } else {
    await run(conn, 'UPDATE books SET status = ? WHERE id = ? AND school_id = ?', [to, bookId, schoolId]);
  }
}

export const orderService = {
  // ---------------- 下单 ----------------
  async create({ schoolId, buyerId, bookId, shipMode = 'meetup', remark = null, idempotencyKey = null }) {
    const machine = await machineOf(schoolId);
    const feeBps = await resolveFeeBps(schoolId);
    const shipModes = await configService.get('order.ship_modes', schoolId);
    if (!shipModes.includes(shipMode)) {
      throw new AppError(ERR.VALIDATION_ERROR, `不支持的交付方式：${shipMode}`);
    }

    return withTransaction(async (conn) => withIdempotency(
      conn,
      { scope: 'order.create', key: idempotencyKey, payload: { bookId, shipMode }, schoolId, userId: buyerId },
      async () => {
        // 行锁：同一本书的并发下单在此串行化
        const book = await q1(
          conn,
          'SELECT * FROM books WHERE id = ? AND school_id = ? AND deleted_at IS NULL FOR UPDATE',
          [bookId, schoolId],
        );
        if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在或不属于本校');
        if (Number(book.seller_id) === Number(buyerId)) throw new AppError(ERR.VALIDATION_ERROR, '不能购买自己发布的教材');
        if (book.status !== 'on_sale') throw new AppError(ERR.BOOK_NOT_AVAILABLE, '该教材已下架或已被下单');

        const activeOrder = await q1(
          conn,
          `SELECT id FROM orders WHERE book_id = ? AND school_id = ?
             AND status IN (${ACTIVE_STATUSES.map(() => '?').join(',')}) LIMIT 1`,
          [bookId, schoolId, ...ACTIVE_STATUSES],
        );
        if (activeOrder) throw new AppError(ERR.BOOK_NOT_AVAILABLE, '该教材已有进行中的订单');

        const amount = Number(book.price_cents);
        const fee = Math.floor((amount * feeBps) / 10000);
        const orderNo = generateNo('OD');
        const result = await run(
          conn,
          `INSERT INTO orders (order_no, school_id, book_id, buyer_id, seller_id, amount_cents, service_fee_bps,
             service_fee_cents, seller_income_cents, status, escrow_status, ship_mode, remark)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
          [orderNo, schoolId, bookId, buyerId, book.seller_id, amount, feeBps, fee, amount - fee,
            machine.initial, shipMode, remark],
        );

        await setBookStatus(conn, { schoolId, bookId, from: ['on_sale'], to: 'locked' });
        const order = { id: result.insertId, order_no: orderNo, school_id: schoolId, book_id: bookId, buyer_id: buyerId, seller_id: book.seller_id, amount_cents: amount, service_fee_cents: fee, seller_income_cents: amount - fee, escrow_status: 'none' };
        await logTransition(conn, { order, fromStatus: null, toStatus: machine.initial, action: 'create', operatorId: buyerId, operatorRole: 'student', reason: '买家下单' });

        await notifyService.notify(book.seller_id, {
          schoolId, type: 'order', title: '有新的订单待付款',
          content: `《${book.title}》被下单，订单号 ${orderNo}，售价 ${(amount / 100).toFixed(2)} 元`,
          relatedType: 'order', relatedId: order.id,
        });

        return { id: order.id, orderNo, amountCents: amount, serviceFeeCents: fee, sellerIncomeCents: amount - fee, status: machine.initial, shipMode };
      },
    ));
  },

  // ---------------- 模拟支付（资金进入托管） ----------------
  async pay({ schoolId, orderId, userId, idempotencyKey = null }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => withIdempotency(
      conn,
      { scope: 'order.pay', key: idempotencyKey, payload: { orderId }, schoolId, userId },
      async () => {
        const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
        if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
        assertParty(order, userId, 'buyer');
        assertTransition(machine, order.status, 'paid', '订单');

        await escrowService.hold(conn, { order });
        await transition(conn, {
          order, from: order.status, to: 'paid',
          extraSql: ", escrow_status = 'held', paid_at = NOW(3)", extraParams: [],
        });
        const updated = { ...order, status: 'paid', escrow_status: 'held' };
        await logTransition(conn, { order: updated, fromStatus: order.status, toStatus: 'paid', action: 'pay', operatorId: userId, operatorRole: 'student', reason: '模拟支付成功，资金进入托管' });

        const amount = (Number(order.amount_cents) / 100).toFixed(2);
        await notifyService.notifyMany([order.buyer_id, order.seller_id], {
          schoolId, type: 'order', title: '订单已付款（资金托管中）',
          content: `订单 ${order.order_no} 已完成支付，金额 ${amount} 元由平台托管，卖家可发货`,
          relatedType: 'order', relatedId: order.id,
        });
        return { orderId: order.id, status: 'paid', escrowStatus: 'held' };
      },
    ));
  },

  // ---------------- 发货（启动 7 天自动确认倒计时） ----------------
  async ship({ schoolId, orderId, userId, expressCompany = null, expressNo = null }) {
    const machine = await machineOf(schoolId);
    const autoConfirmDays = Number(await configService.get('order.auto_confirm_days', schoolId));
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertParty(order, userId, 'seller');
      assertTransition(machine, order.status, 'shipped', '订单');
      if (order.ship_mode === 'mail' && (!expressCompany || !expressNo)) {
        throw new AppError(ERR.VALIDATION_ERROR, '邮寄订单必须填写快递公司与运单号');
      }

      await transition(conn, {
        order, from: order.status, to: 'shipped',
        extraSql: ', shipped_at = NOW(3), express_company = ?, express_no = ?, auto_confirm_at = DATE_ADD(NOW(3), INTERVAL ? DAY)',
        extraParams: [expressCompany, expressNo, autoConfirmDays],
      });
      await logTransition(conn, {
        order, fromStatus: order.status, toStatus: 'shipped', action: 'ship', operatorId: userId, operatorRole: 'student',
        reason: `卖家发货${expressNo ? ` ${expressCompany} ${expressNo}` : ''}`,
      });

      // 加分：按时发货 +2（规则来自 configs.credit.rules）
      await creditService.applyRule({
        conn, userId, schoolId, ruleKey: 'ship_on_time', reason: `订单 ${order.order_no} 按时发货`,
        relatedType: 'order', relatedId: order.id,
      });

      await notifyService.notify(order.buyer_id, {
        schoolId, type: 'order', title: '卖家已发货',
        content: `订单 ${order.order_no} 已发货，${autoConfirmDays} 天后将自动确认收货`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: 'shipped', autoConfirmDays };
    });
  },

  // ---------------- 确认收货（放款 + 扣服务费） ----------------
  async confirm({ schoolId, orderId, userId, idempotencyKey = null, systemTriggered = false }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => withIdempotency(
      conn,
      { scope: 'order.confirm', key: idempotencyKey, payload: { orderId }, schoolId, userId },
      async () => {
        const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
        if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
        if (!systemTriggered) assertParty(order, userId, 'buyer');
        assertTransition(machine, order.status, 'completed', '订单');

        const { income, fee } = await escrowService.release(conn, { order });
        await transition(conn, {
          order, from: order.status, to: 'completed',
          extraSql: ", escrow_status = 'released', completed_at = NOW(3), auto_confirm_at = NULL", extraParams: [],
        });
        await setBookStatus(conn, { schoolId, bookId: order.book_id, from: ['locked', 'on_sale'], to: 'sold' });
        await logTransition(conn, {
          order, fromStatus: order.status, toStatus: 'completed', action: systemTriggered ? 'auto_confirm' : 'confirm',
          operatorId: systemTriggered ? null : userId, operatorRole: systemTriggered ? 'system' : 'student',
          reason: systemTriggered ? '发货后超时自动确认收货' : '买家确认收货，放款给卖家',
        });

        await notifyService.notifyMany([order.buyer_id, order.seller_id], {
          schoolId, type: 'order', title: '订单已完成',
          content: `订单 ${order.order_no} 已完成，卖家实收 ${(income / 100).toFixed(2)} 元（平台服务费 ${(fee / 100).toFixed(2)} 元）`,
          relatedType: 'order', relatedId: order.id,
        });
        return { orderId: order.id, status: 'completed', escrowStatus: 'released', sellerIncomeCents: income, serviceFeeCents: fee };
      },
    ));
  },

  // ---------------- 未付款取消 ----------------
  async cancel({ schoolId, orderId, userId, reason = '买家取消订单' }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertParty(order, userId, 'buyer');
      assertTransition(machine, order.status, 'cancelled', '订单');
      await transition(conn, {
        order, from: order.status, to: 'cancelled',
        extraSql: ', cancelled_at = NOW(3), cancel_reason = ?', extraParams: [reason],
      });
      await setBookStatus(conn, { schoolId, bookId: order.book_id, from: ['locked'], to: 'on_sale' });
      await logTransition(conn, { order, fromStatus: order.status, toStatus: 'cancelled', action: 'cancel', operatorId: userId, operatorRole: 'student', reason });
      return { orderId: order.id, status: 'cancelled' };
    });
  },

  // ---------------- 已付款未发货：买家申请退款 ----------------
  async requestRefund({ schoolId, orderId, userId, reason }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertParty(order, userId, 'buyer');
      assertTransition(machine, order.status, 'refund_requested', '订单');
      await transition(conn, { order, from: order.status, to: 'refund_requested', extraSql: ', remark = ?', extraParams: [String(reason).slice(0, 500)] });
      await logTransition(conn, { order, fromStatus: order.status, toStatus: 'refund_requested', action: 'refund_request', operatorId: userId, operatorRole: 'student', reason });
      await notifyService.notify(order.seller_id, {
        schoolId, type: 'order', title: '买家申请退款',
        content: `订单 ${order.order_no} 申请退款，原因：${reason}。请 48 小时内处理`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: 'refund_requested' };
    });
  },

  // ---------------- 已发货：买家申请退货退款 ----------------
  async requestReturn({ schoolId, orderId, userId, reason }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertParty(order, userId, 'buyer');
      assertTransition(machine, order.status, 'return_requested', '订单');
      await transition(conn, { order, from: order.status, to: 'return_requested', extraSql: ', remark = ?', extraParams: [String(reason).slice(0, 500)] });
      await logTransition(conn, { order, fromStatus: order.status, toStatus: 'return_requested', action: 'return_request', operatorId: userId, operatorRole: 'student', reason });
      await notifyService.notify(order.seller_id, {
        schoolId, type: 'order', title: '买家申请退货退款',
        content: `订单 ${order.order_no} 申请退货退款，原因：${reason}`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: 'return_requested' };
    });
  },

  // ---------------- 卖家同意退款/退货（托管款全额退回买家） ----------------
  async agreeRefund({ schoolId, orderId, userId, reason = '卖家同意退款' }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertParty(order, userId, 'seller');
      assertTransition(machine, order.status, 'refunded', '订单');
      const { refunded } = await escrowService.refund(conn, { order, reason });
      await transition(conn, {
        order, from: order.status, to: 'refunded',
        extraSql: ', escrow_status = ?, refunded_at = NOW(3), refund_amount_cents = ?',
        extraParams: ['refunded', refunded],
      });
      await setBookStatus(conn, { schoolId, bookId: order.book_id, from: ['locked'], to: 'on_sale' });
      await logTransition(conn, { order, fromStatus: order.status, toStatus: 'refunded', action: 'refund', operatorId: userId, operatorRole: 'student', reason });
      await notifyService.notifyMany([order.buyer_id, order.seller_id], {
        schoolId, type: 'order', title: '订单已退款',
        content: `订单 ${order.order_no} 已退款 ${(refunded / 100).toFixed(2)} 元，资金已退回买家余额`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: 'refunded', refundedCents: refunded };
    });
  },

  // 卖家拒绝退款 -> 回到可争议状态
  async rejectRefund({ schoolId, orderId, userId, reason }) {
    const machine = await machineOf(schoolId);
    const target = 'paid';
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertParty(order, userId, 'seller');
      assertTransition(machine, order.status, target, '订单');
      await transition(conn, { order, from: order.status, to: target });
      await logTransition(conn, { order, fromStatus: order.status, toStatus: target, action: 'refund_reject', operatorId: userId, operatorRole: 'student', reason });
      await notifyService.notify(order.buyer_id, {
        schoolId, type: 'order', title: '卖家拒绝了退款申请',
        content: `订单 ${order.order_no} 退款被拒绝，理由：${reason}。你可以发起争议，由人工客服仲裁`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: target };
    });
  },

  // ---------------- 争议：冻结放款 + 暂停自动确认倒计时 + 创建加急工单 ----------------
  async dispute({ schoolId, orderId, userId, reason }) {
    const machine = await machineOf(schoolId);
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      if (![order.buyer_id, order.seller_id].map(Number).includes(Number(userId))) {
        throw new AppError(ERR.FORBIDDEN, '只有订单双方可以发起争议');
      }
      assertTransition(machine, order.status, 'disputed', '订单');
      await transition(conn, {
        order, from: order.status, to: 'disputed',
        extraSql: ', auto_confirm_at = NULL, dispute_reason = ?, dispute_at = NOW(3)',
        extraParams: [String(reason).slice(0, 500)],
      });
      await logTransition(conn, { order, fromStatus: order.status, toStatus: 'disputed', action: 'dispute', operatorId: userId, operatorRole: 'student', reason });

      const ticketNo = generateNo('TK');
      await run(
        conn,
        `INSERT INTO tickets (ticket_no, school_id, source, type, priority, subject, description, related_order_id,
           related_user_id, reporter_id, status, first_response_due_at, resolve_due_at)
         VALUES (?, ?, 'user', 'refund', 'urgent', ?, ?, ?, ?, ?, 'pending', DATE_ADD(NOW(3), INTERVAL 4 HOUR), DATE_ADD(NOW(3), INTERVAL 24 HOUR))`,
        [ticketNo, schoolId, `订单争议：${order.order_no}`, `争议原因：${reason}`, order.id, order.seller_id, userId],
      );

      await notifyService.notifyMany([order.buyer_id, order.seller_id], {
        schoolId, type: 'order', title: '订单进入争议处理中',
        content: `订单 ${order.order_no} 已进入争议状态，资金已冻结，自动确认收货已暂停，客服将介入仲裁`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: 'disputed', escrowFrozen: true };
    });
  },

  // ---------------- 客服仲裁：强制放款 / 强制退款 ----------------
  async arbitrate({ schoolId, orderId, staffId, action, reason }) {
    const machine = await machineOf(schoolId);
    if (!['release', 'refund'].includes(action)) {
      throw new AppError(ERR.VALIDATION_ERROR, '仲裁动作只能是 release（放款）或 refund（退款）');
    }
    const target = action === 'release' ? 'arbitrated_release' : 'arbitrated_refund';
    return withTransaction(async (conn) => {
      const order = await q1(conn, 'SELECT * FROM orders WHERE id = ? AND school_id = ? FOR UPDATE', [orderId, schoolId]);
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
      assertTransition(machine, order.status, target, '订单');

      let income = 0;
      let refunded = 0;
      if (action === 'release') {
        const r = await escrowService.release(conn, { order });
        income = r.income;
      } else {
        const r = await escrowService.refund(conn, { order, reason: `仲裁退款：${reason}` });
        refunded = r.refunded;
      }

      await transition(conn, {
        order, from: order.status, to: target,
        extraSql: ', escrow_status = ?, arbitration_result = ?, arbitrated_at = NOW(3), arbitrator_id = ?, refund_amount_cents = ?, auto_confirm_at = NULL',
        extraParams: [action === 'release' ? 'released' : 'refunded', action, staffId, refunded],
      });
      await setBookStatus(conn, { schoolId, bookId: order.book_id, from: ['locked'], to: action === 'release' ? 'sold' : 'on_sale' });
      await logTransition(conn, {
        order, fromStatus: order.status, toStatus: target, action: 'arbitrate', operatorId: staffId, operatorRole: 'support',
        reason: `平台仲裁：${action === 'release' ? '放款给卖家' : '退款给买家'}。${reason}`,
      });
      await notifyService.notifyMany([order.buyer_id, order.seller_id], {
        schoolId, type: 'order', title: '仲裁结果已出',
        content: `订单 ${order.order_no} 仲裁结果：${action === 'release' ? `放款给卖家（卖家实收 ${(income / 100).toFixed(2)} 元）` : `退款给买家（${(refunded / 100).toFixed(2)} 元）`}`,
        relatedType: 'order', relatedId: order.id,
      });
      return { orderId: order.id, status: target, income, refunded };
    });
  },

  // ---------------- 定时任务：自动确认收货 ----------------
  async autoConfirmDue({ limit = 50 } = {}) {
    const rows = await q(
      pool,
      `SELECT id, school_id FROM orders
       WHERE status = 'shipped' AND auto_confirm_at IS NOT NULL AND auto_confirm_at <= NOW(3)
       ORDER BY auto_confirm_at ASC LIMIT ?`,
      [Number(limit)],
    );
    const results = [];
    for (const row of rows) {
      try {
        const r = await this.confirm({ schoolId: row.school_id, orderId: row.id, userId: null, systemTriggered: true });
        results.push(r);
      } catch (err) {
        logger.warn('自动确认收货失败', { orderId: row.id, error: err.message });
      }
    }
    return results;
  },

  // 定时任务：逾期未发货扣分
  async overdueShip() {
    const deadlineDays = Number(await configService.get('order.ship_deadline_days', null).catch(() => 3));
    const rows = await q(
      pool,
      `SELECT id, school_id, seller_id, order_no FROM orders
       WHERE status = 'paid' AND paid_at IS NOT NULL AND paid_at <= DATE_SUB(NOW(3), INTERVAL ? DAY) LIMIT 50`,
      [deadlineDays],
    );
    for (const row of rows) {
      await creditService.applyRule({
        userId: row.seller_id, schoolId: row.school_id, ruleKey: 'late_ship',
        reason: `订单 ${row.order_no} 逾期未发货`, relatedType: 'order', relatedId: row.id,
        expiresAt: new Date(Date.now() + 365 * 86400000),
      }).catch((err) => logger.warn('逾期扣分失败', { orderId: row.id, error: err.message }));
    }
    return rows.length;
  },

  // ---------------- 查询 ----------------
  async detail({ schoolId, orderId, userId, role }) {
    const order = await q1(
      pool,
      `SELECT o.*, b.title AS book_title
       FROM orders o LEFT JOIN books b ON b.id = o.book_id
       WHERE o.id = ? AND o.school_id = ?`,
      [orderId, schoolId],
    );
    if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
    const isParty = [order.buyer_id, order.seller_id].map(Number).includes(Number(userId));
    if (!isParty && !['support', 'platform_admin', 'school_admin'].includes(role)) {
      throw new AppError(ERR.FORBIDDEN, '无权查看该订单');
    }
    const logs = await q(
      pool,
      `SELECT from_status, to_status, action, operator_id, operator_role, reason, created_at
       FROM order_status_log WHERE order_id = ? AND school_id = ? ORDER BY id ASC`,
      [orderId, schoolId],
    );
    const transactions = await q(
      pool,
      `SELECT tx_no, user_id, account, direction, amount_cents, biz_type, status, remark, created_at
       FROM wallet_transactions WHERE order_id = ? AND school_id = ? ORDER BY id ASC`,
      [orderId, schoolId],
    );
    return { order, logs, transactions, escrowAmountCents: Number(order.amount_cents) };
  },

  async list({ schoolId, userId, role = 'buyer', status = null, page = 1, pageSize = 20 }) {
    const where = ['o.school_id = ?'];
    const params = [schoolId];
    if (role === 'buyer') { where.push('o.buyer_id = ?'); params.push(userId); }
    else if (role === 'seller') { where.push('o.seller_id = ?'); params.push(userId); }
    if (status) { where.push('o.status = ?'); params.push(status); }
    const list = await q(
      pool,
      `SELECT o.id, o.order_no, o.book_id, o.amount_cents, o.status, o.escrow_status, o.ship_mode,
              o.service_fee_cents, o.auto_confirm_at, o.created_at, b.title AS book_title,
              bu.nickname AS buyer_nickname, su.nickname AS seller_nickname
       FROM orders o
       LEFT JOIN books b ON b.id = o.book_id
       LEFT JOIN users bu ON bu.id = o.buyer_id
       LEFT JOIN users su ON su.id = o.seller_id
       WHERE ${where.join(' AND ')}
       ORDER BY o.id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    const countWhere = where.map((w) => w.replace('o.', ''));
    const total = await q1(pool, `SELECT COUNT(*) AS total FROM orders o WHERE ${where.join(' AND ')}`, params);
    return { list, total: Number(total.total) };
  },
};
