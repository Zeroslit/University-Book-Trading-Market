// 演示版：交易与资金托管（状态机由 configs.order.state_machine 驱动）+ 钱包
import { table, insert, filter, nowIso, isoAfter, generateNo, configValue } from '../store.js';
import { AppError, ERR, assertTransition } from '../vendor.js';
import {
  notify, notifyMany, walletAccount, walletRecord, escrowHold, escrowRelease, escrowRefund,
  escrowFrozenCents, creditPermissions, applyCreditRule, audit,
} from '../rules.js';
import { requireVerified, requireTradePermission, paged, pageOf, slicePage } from './util.js';

const ACTIVE_STATUSES = ['pending_payment', 'paid', 'shipped', 'refund_requested', 'return_requested', 'disputed'];

function machineOf(schoolId) {
  return configValue('order.state_machine', schoolId);
}

function feeBpsOf(schoolId) {
  const school = table('schools').find((s) => Number(s.id) === Number(schoolId));
  return Number(school?.service_fee_bps ?? configValue('order.service_fee_bps', schoolId));
}

function orderOf(ctx, orderId) {
  const order = table('orders').find((o) => Number(o.id) === Number(orderId) && Number(o.school_id) === Number(ctx.schoolId));
  if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '订单不存在');
  return order;
}

function assertParty(order, userId, role) {
  if (role === 'buyer' && Number(order.buyer_id) !== Number(userId)) throw new AppError(ERR.FORBIDDEN, '只有买家可以执行该操作');
  if (role === 'seller' && Number(order.seller_id) !== Number(userId)) throw new AppError(ERR.FORBIDDEN, '只有卖家可以执行该操作');
}

function logTransition({ order, fromStatus, toStatus, action, operatorId = null, operatorRole = null, reason = null }) {
  insert('order_status_log', {
    order_id: Number(order.id), school_id: Number(order.school_id), from_status: fromStatus, to_status: toStatus,
    action, operator_id: operatorId, operator_role: operatorRole, reason,
    snapshot: JSON.stringify({
      orderNo: order.order_no, amountCents: order.amount_cents, status: toStatus,
      escrowStatus: order.escrow_status, bookId: order.book_id,
    }),
    created_at: nowIso(),
  });
}

function setBookStatus(bookId, schoolId, from, to) {
  const book = table('books').find((b) => Number(b.id) === Number(bookId) && Number(b.school_id) === Number(schoolId));
  if (book && (!from || from.includes(book.status))) {
    book.status = to;
    book.updated_at = nowIso();
  }
}

function transition(order, { from, to, extra = {} }) {
  assertTransition(machineOf(order.school_id), from, to, '订单');
  order.status = to;
  order.version = Number(order.version || 0) + 1;
  Object.assign(order, extra);
  order.updated_at = nowIso();
}

export function registerTradeRoutes(route) {
  // ---------------- 订单 ----------------
  route('GET', '/orders', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const role = ctx.query.role === 'seller' ? 'seller' : 'buyer';
    const me = Number(ctx.user.id);
    let rows = filter('orders', (o) => Number(o.school_id) === Number(ctx.schoolId)
      && (role === 'buyer' ? Number(o.buyer_id) === me : Number(o.seller_id) === me));
    if (ctx.query.status) rows = rows.filter((o) => o.status === ctx.query.status);
    rows = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
    const list = slicePage(rows, page, pageSize).map((o) => {
      const book = table('books').find((b) => Number(b.id) === Number(o.book_id)) || {};
      const buyer = table('users').find((u) => Number(u.id) === Number(o.buyer_id)) || {};
      const seller = table('users').find((u) => Number(u.id) === Number(o.seller_id)) || {};
      return {
        id: Number(o.id), order_no: o.order_no, book_id: Number(o.book_id), amount_cents: Number(o.amount_cents),
        status: o.status, escrow_status: o.escrow_status, ship_mode: o.ship_mode,
        service_fee_cents: Number(o.service_fee_cents), auto_confirm_at: o.auto_confirm_at, created_at: o.created_at,
        book_title: book.title, buyer_nickname: buyer.nickname, seller_nickname: seller.nickname,
      };
    });
    return paged(list, rows.length, page, pageSize);
  });

  route('GET', '/orders/:id', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    const isParty = [order.buyer_id, order.seller_id].map(Number).includes(Number(ctx.user.id));
    if (!isParty && !['support', 'platform_admin', 'school_admin'].includes(ctx.user.role)) {
      throw new AppError(ERR.FORBIDDEN, '无权查看该订单');
    }
    const book = table('books').find((b) => Number(b.id) === Number(order.book_id)) || {};
    const logs = filter('order_status_log', (l) => Number(l.order_id) === Number(order.id))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((l) => ({
        from_status: l.from_status, to_status: l.to_status, action: l.action, operator_id: l.operator_id,
        operator_role: l.operator_role, reason: l.reason, created_at: l.created_at,
      }));
    const transactions = filter('wallet_transactions', (t) => Number(t.order_id) === Number(order.id))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((t) => ({
        tx_no: t.tx_no, user_id: Number(t.user_id), account: t.account, direction: t.direction,
        amount_cents: Number(t.amount_cents), biz_type: t.biz_type, status: t.status,
        remark: t.remark, created_at: t.created_at,
      }));
    return {
      order: { ...order, book_title: book.title },
      logs,
      transactions,
      escrowAmountCents: Number(order.amount_cents),
    };
  });

  route('POST', '/orders', (ctx) => {
    requireVerified(ctx);
    requireTradePermission(ctx);
    const bookId = Number(ctx.body.bookId);
    const shipMode = ctx.body.shipMode || 'meetup';
    const machine = machineOf(ctx.schoolId);
    const feeBps = feeBpsOf(ctx.schoolId);
    const shipModes = configValue('order.ship_modes', ctx.schoolId);
    if (!shipModes.includes(shipMode)) throw new AppError(ERR.VALIDATION_ERROR, `不支持的交付方式：${shipMode}`);

    const book = table('books').find((b) => Number(b.id) === bookId
      && Number(b.school_id) === Number(ctx.schoolId) && !b.deleted_at);
    if (!book) throw new AppError(ERR.BOOK_NOT_FOUND, '教材不存在或不属于本校');
    if (Number(book.seller_id) === Number(ctx.user.id)) throw new AppError(ERR.VALIDATION_ERROR, '不能购买自己发布的教材');
    if (book.status !== 'on_sale') throw new AppError(ERR.BOOK_NOT_AVAILABLE, '该教材已下架或已被下单');
    const active = table('orders').find((o) => Number(o.book_id) === bookId
      && Number(o.school_id) === Number(ctx.schoolId) && ACTIVE_STATUSES.includes(o.status));
    if (active) throw new AppError(ERR.BOOK_NOT_AVAILABLE, '该教材已有进行中的订单');

    const amount = Number(book.price_cents);
    const fee = Math.floor((amount * feeBps) / 10000);
    const order = insert('orders', {
      order_no: generateNo('OD'), school_id: Number(ctx.schoolId), book_id: bookId,
      buyer_id: Number(ctx.user.id), seller_id: Number(book.seller_id), amount_cents: amount,
      service_fee_bps: feeBps, service_fee_cents: fee, seller_income_cents: amount - fee,
      status: machine.initial, escrow_status: 'none', ship_mode: shipMode,
      express_company: null, express_no: null, paid_at: null, shipped_at: null, auto_confirm_at: null,
      completed_at: null, cancelled_at: null, refunded_at: null, refund_amount_cents: 0,
      dispute_reason: null, dispute_at: null, arbitration_result: null, arbitrated_at: null,
      arbitrator_id: null, cancel_reason: null, remark: ctx.body.remark ?? null, version: 0,
      active_book_id: bookId, created_at: nowIso(), updated_at: nowIso(),
    });
    setBookStatus(book.id, ctx.schoolId, ['on_sale'], 'locked');
    logTransition({
      order, fromStatus: null, toStatus: machine.initial, action: 'create',
      operatorId: ctx.user.id, operatorRole: 'student', reason: '买家下单',
    });
    notify(book.seller_id, {
      schoolId: Number(ctx.schoolId), type: 'order', title: '有新的订单待付款',
      content: `《${book.title}》被下单，订单号 ${order.order_no}，售价 ${(amount / 100).toFixed(2)} 元`,
      relatedType: 'order', relatedId: order.id,
    });
    return {
      id: Number(order.id), orderNo: order.order_no, amountCents: amount, serviceFeeCents: fee,
      sellerIncomeCents: amount - fee, status: machine.initial, shipMode,
    };
  }, { message: '下单成功，请在 30 分钟内完成支付' });

  route('POST', '/orders/:id/pay', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'buyer');
    const wallet = walletAccount(ctx.user.id);
    if (Number(wallet.balance_cents) < Number(order.amount_cents)) {
      throw new AppError(ERR.INSUFFICIENT_BALANCE, `余额不足，还需充值 ${((Number(order.amount_cents) - Number(wallet.balance_cents)) / 100).toFixed(2)} 元`, {
        needCents: Number(order.amount_cents) - Number(wallet.balance_cents), path: '/wallet',
      });
    }
    escrowHold({ order });
    transition(order, { from: order.status, to: 'paid', extra: { escrow_status: 'held', paid_at: nowIso() } });
    logTransition({
      order, fromStatus: 'pending_payment', toStatus: 'paid', action: 'pay',
      operatorId: ctx.user.id, operatorRole: 'student', reason: '模拟支付成功，资金进入托管',
    });
    notifyMany([order.buyer_id, order.seller_id], {
      schoolId: Number(ctx.schoolId), type: 'order', title: '订单已付款（资金托管中）',
      content: `订单 ${order.order_no} 已完成支付，金额 ${(Number(order.amount_cents) / 100).toFixed(2)} 元由平台托管，卖家可发货`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'paid', escrowStatus: 'held' };
  }, { message: '支付成功（模拟），资金已进入托管' });

  route('POST', '/orders/:id/cancel', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'buyer');
    const reason = ctx.body?.reason ?? '买家取消订单';
    const from = order.status;
    transition(order, { from, to: 'cancelled', extra: { cancelled_at: nowIso(), cancel_reason: reason } });
    setBookStatus(order.book_id, ctx.schoolId, ['locked'], 'on_sale');
    logTransition({ order, fromStatus: from, toStatus: 'cancelled', action: 'cancel', operatorId: ctx.user.id, operatorRole: 'student', reason });
    return { orderId: Number(order.id), status: 'cancelled' };
  }, { message: '订单已取消' });

  route('POST', '/orders/:id/ship', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'seller');
    const days = Number(configValue('order.auto_confirm_days', ctx.schoolId));
    const from = order.status;
    transition(order, {
      from, to: 'shipped',
      extra: {
        shipped_at: nowIso(), auto_confirm_at: isoAfter(days * 86400000),
        express_company: ctx.body?.expressCompany ?? null, express_no: ctx.body?.expressNo ?? null,
      },
    });
    logTransition({ order, fromStatus: from, toStatus: 'shipped', action: 'ship', operatorId: ctx.user.id, operatorRole: 'student', reason: '卖家已发货' });
    applyCreditRule({
      schoolId: ctx.schoolId, userId: order.seller_id, ruleKey: 'ship_on_time',
      reason: `订单 ${order.order_no} 按时发货`, relatedType: 'order', relatedId: order.id,
    });
    notifyMany([order.buyer_id, order.seller_id], {
      schoolId: Number(ctx.schoolId), type: 'order', title: '卖家已发货',
      content: `订单 ${order.order_no} 已发货，${days} 天后未确认将自动确认收货`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'shipped', autoConfirmAt: order.auto_confirm_at };
  }, { message: '已发货，7 天后将自动确认收货' });

  route('POST', '/orders/:id/confirm', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'buyer');
    const from = order.status;
    const { income, fee } = escrowRelease({ order });
    transition(order, { from, to: 'completed', extra: { escrow_status: 'released', completed_at: nowIso(), auto_confirm_at: null } });
    setBookStatus(order.book_id, ctx.schoolId, ['locked', 'on_sale'], 'sold');
    logTransition({ order, fromStatus: from, toStatus: 'completed', action: 'confirm', operatorId: ctx.user.id, operatorRole: 'student', reason: '买家确认收货，放款给卖家' });
    notifyMany([order.buyer_id, order.seller_id], {
      schoolId: Number(ctx.schoolId), type: 'order', title: '订单已完成',
      content: `订单 ${order.order_no} 已完成，卖家实收 ${(income / 100).toFixed(2)} 元（平台服务费 ${(fee / 100).toFixed(2)} 元）`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'completed', escrowStatus: 'released', sellerIncomeCents: income, serviceFeeCents: fee };
  }, { message: '已确认收货，货款已放给卖家' });

  route('POST', '/orders/:id/refund-request', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'buyer');
    const from = order.status;
    transition(order, { from, to: 'refund_requested', extra: { remark: String(ctx.body.reason).slice(0, 500) } });
    logTransition({ order, fromStatus: from, toStatus: 'refund_requested', action: 'refund_request', operatorId: ctx.user.id, operatorRole: 'student', reason: ctx.body.reason });
    notify(order.seller_id, {
      schoolId: Number(ctx.schoolId), type: 'order', title: '买家申请退款',
      content: `订单 ${order.order_no} 申请退款，原因：${ctx.body.reason}。请 48 小时内处理`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'refund_requested' };
  }, { message: '退款申请已提交' });

  route('POST', '/orders/:id/return-request', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'buyer');
    const from = order.status;
    transition(order, { from, to: 'return_requested', extra: { remark: String(ctx.body.reason).slice(0, 500) } });
    logTransition({ order, fromStatus: from, toStatus: 'return_requested', action: 'return_request', operatorId: ctx.user.id, operatorRole: 'student', reason: ctx.body.reason });
    notify(order.seller_id, {
      schoolId: Number(ctx.schoolId), type: 'order', title: '买家申请退货退款',
      content: `订单 ${order.order_no} 申请退货退款，原因：${ctx.body.reason}`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'return_requested' };
  }, { message: '退货退款申请已提交' });

  route('POST', '/orders/:id/refund/agree', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'seller');
    const from = order.status;
    const reason = ctx.body?.reason ?? '卖家同意退款';
    const { refunded } = escrowRefund({ order, reason });
    transition(order, { from, to: 'refunded', extra: { escrow_status: 'refunded', refunded_at: nowIso(), refund_amount_cents: refunded } });
    setBookStatus(order.book_id, ctx.schoolId, ['locked'], 'on_sale');
    logTransition({ order, fromStatus: from, toStatus: 'refunded', action: 'refund', operatorId: ctx.user.id, operatorRole: 'student', reason });
    notifyMany([order.buyer_id, order.seller_id], {
      schoolId: Number(ctx.schoolId), type: 'order', title: '订单已退款',
      content: `订单 ${order.order_no} 已退款 ${(refunded / 100).toFixed(2)} 元，资金已退回买家余额`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'refunded', refundedCents: refunded };
  }, { message: '已退款，托管资金已退回买家' });

  route('POST', '/orders/:id/refund/reject', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    assertParty(order, ctx.user.id, 'seller');
    const from = order.status;
    const backTo = from === 'refund_requested' ? 'paid' : 'shipped';
    transition(order, { from, to: backTo, extra: { remark: String(ctx.body.reason).slice(0, 500) } });
    logTransition({ order, fromStatus: from, toStatus: backTo, action: 'refund_reject', operatorId: ctx.user.id, operatorRole: 'student', reason: ctx.body.reason });
    notify(order.buyer_id, {
      schoolId: Number(ctx.schoolId), type: 'order', title: '卖家拒绝了退款申请',
      content: `订单 ${order.order_no} 退款申请被拒绝，理由：${ctx.body.reason}。你可以发起争议，由客服仲裁`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: backTo };
  }, { message: '已拒绝退款，买家可发起争议' });

  route('POST', '/orders/:id/dispute', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    const isParty = [order.buyer_id, order.seller_id].map(Number).includes(Number(ctx.user.id));
    if (!isParty) throw new AppError(ERR.FORBIDDEN, '只有订单双方可以发起争议');
    const from = order.status;
    transition(order, {
      from, to: 'disputed',
      extra: { dispute_reason: ctx.body.reason, dispute_at: nowIso(), auto_confirm_at: null },
    });
    logTransition({ order, fromStatus: from, toStatus: 'disputed', action: 'dispute', operatorId: ctx.user.id, operatorRole: 'student', reason: ctx.body.reason });
    const ticket = insert('tickets', {
      ticket_no: generateNo('TK'), school_id: Number(ctx.schoolId), source: 'order', type: 'refund',
      priority: 'urgent', subject: `订单争议：${order.order_no}`, description: `争议原因：${ctx.body.reason}`,
      related_order_id: Number(order.id), related_user_id: Number(order.buyer_id), reporter_id: Number(ctx.user.id),
      assignee_id: null, status: 'pending', first_response_at: null,
      first_response_due_at: isoAfter(4 * 3600000), resolve_due_at: isoAfter(24 * 3600000),
      escalated: 0, escalated_at: null, resolution: null, created_at: nowIso(), updated_at: nowIso(), closed_at: null,
    });
    insert('ticket_logs', {
      ticket_id: Number(ticket.id), school_id: Number(ctx.schoolId), action: 'create', operator_id: Number(ctx.user.id),
      operator_type: 'student', from_status: null, to_status: 'pending', note: '订单争议自动创建加急工单', created_at: nowIso(),
    });
    notifyMany([order.buyer_id, order.seller_id], {
      schoolId: Number(ctx.schoolId), type: 'order', title: '订单已进入争议状态',
      content: `订单 ${order.order_no} 已进入争议，资金已冻结并暂停自动确认倒计时，客服将在 4 小时内响应`,
      relatedType: 'order', relatedId: order.id,
    });
    return { orderId: Number(order.id), status: 'disputed', ticketId: Number(ticket.id) };
  }, { message: '已进入争议，资金冻结并由客服仲裁' });

  route('POST', '/orders/:id/arbitrate', (ctx) => {
    const order = orderOf(ctx, ctx.params.id);
    if (!['release', 'refund'].includes(ctx.body.action)) throw new AppError(ERR.VALIDATION_ERROR, '仲裁动作不支持');
    if (order.status !== 'disputed') throw new AppError(ERR.ORDER_STATE_INVALID, '只有争议中的订单可以仲裁');
    const action = ctx.body.action;
    const from = order.status;
    const target = action === 'release' ? 'arbitrated_release' : 'arbitrated_refund';
    let income = 0;
    let refunded = 0;
    if (action === 'release') {
      const released = escrowRelease({ order });
      income = released.income;
      transition(order, {
        from, to: target,
        extra: { escrow_status: 'released', arbitrated_at: nowIso(), arbitration_result: ctx.body.reason, arbitrator_id: Number(ctx.user.id) },
      });
      setBookStatus(order.book_id, ctx.schoolId, null, 'sold');
    } else {
      const refundedResult = escrowRefund({ order, reason: '平台仲裁退款' });
      refunded = refundedResult.refunded;
      transition(order, {
        from, to: target,
        extra: {
          escrow_status: 'refunded', arbitrated_at: nowIso(), arbitration_result: ctx.body.reason,
          arbitrator_id: Number(ctx.user.id), refunded_at: nowIso(), refund_amount_cents: refunded,
        },
      });
      setBookStatus(order.book_id, ctx.schoolId, null, 'on_sale');
    }
    logTransition({
      order, fromStatus: from, toStatus: target, action: 'arbitrate', operatorId: ctx.user.id, operatorRole: 'support',
      reason: `平台仲裁：${action === 'release' ? '放款给卖家' : '退款给买家'}。${ctx.body.reason}`,
    });
    notifyMany([order.buyer_id, order.seller_id], {
      schoolId: Number(ctx.schoolId), type: 'order', title: '仲裁结果已出',
      content: `订单 ${order.order_no} 仲裁结果：${action === 'release'
        ? `放款给卖家（卖家实收 ${(income / 100).toFixed(2)} 元）`
        : `退款给买家（${(refunded / 100).toFixed(2)} 元）`}`,
      relatedType: 'order', relatedId: order.id,
    });
    audit({
      schoolId: Number(ctx.schoolId), actorId: ctx.user.id, actorRole: ctx.user.role, action: 'order.arbitrate',
      targetType: 'order', targetId: order.id, detail: { action, reason: ctx.body.reason },
    });
    return { orderId: Number(order.id), status: target, income, refunded };
  }, { roles: ['support', 'platform_admin'], message: '仲裁已完成，资金已按裁定处理' });

  // ---------------- 钱包 ----------------
  route('GET', '/wallet', (ctx) => {
    const account = walletAccount(ctx.user.id);
    const permissions = creditPermissions(ctx.user.school_id, ctx.user.id);
    const frozen = escrowFrozenCents(ctx.user.id);
    return {
      balanceCents: Number(account.balance_cents),
      frozenCents: frozen,
      availableCents: Number(account.balance_cents),
      creditTier: permissions.tier,
      withdrawDelayHours: permissions.withdrawDelayHours,
      withdrawInstant: permissions.withdrawDelayHours === 0,
    };
  }, { schoolScope: false });

  route('GET', '/wallet/transactions', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    let rows = filter('wallet_transactions', (t) => Number(t.user_id) === Number(ctx.user.id));
    if (ctx.query.orderId) rows = rows.filter((t) => Number(t.order_id) === Number(ctx.query.orderId));
    if (ctx.query.bizType) rows = rows.filter((t) => t.biz_type === ctx.query.bizType);
    rows = [...rows].sort((a, b) => Number(b.id) - Number(a.id));
    return paged(slicePage(rows, page, pageSize), rows.length, page, pageSize);
  }, { schoolScope: false });

  route('POST', '/wallet/recharge', (ctx) => {
    const amount = Number(ctx.body.amountCents);
    if (!Number.isInteger(amount) || amount < 100 || amount > 500000) {
      throw new AppError(ERR.VALIDATION_ERROR, '充值金额需在 1 元到 5000 元之间');
    }
    const tx = walletRecord({
      schoolId: ctx.user.school_id, userId: ctx.user.id, account: 'balance', direction: 'in',
      amountCents: amount, bizType: 'recharge', remark: '模拟充值',
      idempotencyKey: ctx.body.idempotencyKey || `recharge:${ctx.user.id}:${Date.now()}`,
    });
    return {
      txNo: tx.tx_no, amountCents: amount, balanceCents: Number(tx.balance_after_cents),
      idempotent: Boolean(tx.idempotent),
    };
  }, { schoolScope: false, message: '充值成功（模拟）' });

  route('POST', '/wallet/withdraw', (ctx) => {
    const amount = Number(ctx.body.amountCents);
    if (!Number.isInteger(amount) || amount < 100) throw new AppError(ERR.VALIDATION_ERROR, '提现金额至少 1 元');
    const account = table('payment_accounts').find((a) => Number(a.id) === Number(ctx.body.paymentAccountId)
      && Number(a.user_id) === Number(ctx.user.id) && Number(a.school_id) === Number(ctx.user.school_id) && a.status === 'active');
    if (!account) throw new AppError(ERR.VALIDATION_ERROR, '请先绑定有效的收款方式后再提现');
    if (ctx.user.verification_status !== 'approved') throw new AppError(ERR.VERIFICATION_REQUIRED, '完成实名/学生认证后才能提现');

    const permissions = creditPermissions(ctx.user.school_id, ctx.user.id);
    const delayHours = Number(permissions.withdrawDelayHours || 0);
    const arrivalType = delayHours > 0 ? 'delayed' : 'instant';
    const expectAt = delayHours > 0 ? isoAfter(delayHours * 3600000) : nowIso();
    const wallet = walletAccount(ctx.user.id);
    if (Number(wallet.balance_cents) < amount) throw new AppError(ERR.INSUFFICIENT_BALANCE, '可提现余额不足');

    const withdraw = insert('withdraw_requests', {
      withdraw_no: generateNo('WD'), school_id: Number(ctx.user.school_id), user_id: Number(ctx.user.id),
      payment_account_id: Number(account.id), amount_cents: amount, fee_cents: 0, status: 'pending',
      arrival_type: arrivalType, expect_at: expectAt, reviewed_by: null, reviewed_at: null,
      reject_reason: null, idempotency_key: null, created_at: nowIso(),
    });
    walletRecord({
      schoolId: ctx.user.school_id, userId: ctx.user.id, withdrawId: Number(withdraw.id), account: 'balance',
      direction: 'out', amountCents: amount, bizType: 'withdraw_freeze',
      remark: `提现冻结（${arrivalType === 'instant' ? '即时到账' : `${delayHours} 小时后到账`}）`,
    });
    walletRecord({
      schoolId: ctx.user.school_id, userId: ctx.user.id, withdrawId: Number(withdraw.id), account: 'frozen',
      direction: 'in', amountCents: amount, bizType: 'withdraw_freeze', remark: '提现冻结',
    });
    notify(ctx.user.id, {
      schoolId: ctx.user.school_id, type: 'withdraw', title: '提现申请已提交',
      content: `提现 ${(amount / 100).toFixed(2)} 元，${arrivalType === 'instant' ? '预计即时到账' : `预计 ${new Date(expectAt).toLocaleString('zh-CN')} 到账`}`,
    });
    return { withdrawId: Number(withdraw.id), amountCents: amount, arrivalType, expectAt };
  }, { schoolScope: false, message: '提现申请已提交' });

  route('GET', '/wallet/withdrawals', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const rows = filter('withdraw_requests', (w) => Number(w.user_id) === Number(ctx.user.id))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .map((w) => ({
        id: Number(w.id), withdraw_no: w.withdraw_no, amount_cents: Number(w.amount_cents),
        fee_cents: Number(w.fee_cents), status: w.status, arrival_type: w.arrival_type,
        expect_at: w.expect_at, reject_reason: w.reject_reason, created_at: w.created_at,
      }));
    return paged(slicePage(rows, page, pageSize), rows.length, page, pageSize);
  }, { schoolScope: false });
}

export { ACTIVE_STATUSES, machineOf, feeBpsOf, orderOf, assertParty, logTransition, transition };
