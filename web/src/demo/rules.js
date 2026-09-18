// 演示版业务规则：信誉分档位 / 处罚梯度 / 钱包流水 / 托管资金，全部由 configs 驱动（不写死阈值）
import { configValue, table, insert, filter, nowIso, isoAfter, generateNo, db } from './store.js';
import { AppError, ERR } from './vendor.js';

const DAY = 86400000;

// ---------------- 信誉分 ----------------
export function creditTier(schoolId, score) {
  const cfg = configValue('credit.tiers', schoolId);
  const tiers = [...cfg.tiers].sort((a, b) => b.min - a.min);
  const found = tiers.find((t) => Number(score) >= Number(t.min)) || tiers[tiers.length - 1];
  return { key: found.key, label: found.label, min: found.min };
}

export function creditPermissions(schoolId, userId) {
  const user = table('users').find((u) => Number(u.id) === Number(userId));
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');
  const score = Number(user.credit_score);
  const tier = creditTier(schoolId, score);
  const map = configValue('credit.tier_permissions', schoolId);
  const p = map[tier.key] || {};
  return {
    score,
    tier: tier.key,
    tierLabel: tier.label,
    canPublish: p.canPublish !== false,
    canTrade: p.canTrade !== false,
    maxBooks: Number(p.maxBooks ?? 0),
    withdrawDelayHours: Number(p.withdrawDelayHours ?? 0),
  };
}

export function applyCreditDelta({ schoolId, userId, delta, ruleKey, reason, relatedType = null, relatedId = null, operatorId = null, expiresAt = null }) {
  const user = table('users').find((u) => Number(u.id) === Number(userId));
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');
  const bounds = configValue('credit.bounds', schoolId);
  const before = Number(user.credit_score);
  const next = Math.max(Number(bounds.min), Math.min(Number(bounds.max), before + Number(delta)));
  const actual = next - before;
  insert('credit_logs', {
    user_id: Number(userId), school_id: Number(schoolId), delta: actual, score_after: next,
    rule_key: ruleKey, reason, related_type: relatedType, related_id: relatedId,
    expires_at: expiresAt, rolled_back: 0, operator_id: operatorId, created_at: nowIso(),
  });
  user.credit_score = next;
  return { scoreBefore: before, scoreAfter: next, delta: actual };
}

export function applyCreditRule({ schoolId, userId, ruleKey, reason, relatedType = null, relatedId = null, operatorId = null, expiresAt = null, deltaOverride = null }) {
  const rules = configValue('credit.rules', schoolId);
  const delta = deltaOverride !== null ? Number(deltaOverride) : Number(rules[ruleKey]);
  if (!Number.isFinite(delta)) throw new AppError(ERR.CONFIG_MISSING, `信誉分规则未配置：${ruleKey}`, { ruleKey });
  return applyCreditDelta({ schoolId, userId, delta, ruleKey, reason, relatedType, relatedId, operatorId, expiresAt });
}

// 申诉成功：写反向流水回滚扣分（不修改历史记录）
export function rollbackCredit({ schoolId, userId, relatedType, relatedId, ruleKey = null, reason = '申诉通过，撤销处罚', operatorId = null }) {
  const rows = filter('credit_logs', (r) => Number(r.user_id) === Number(userId)
    && Number(r.school_id) === Number(schoolId)
    && r.related_type === relatedType && Number(r.related_id) === Number(relatedId)
    && Number(r.delta) < 0 && !r.rolled_back && r.rule_key !== 'rollback'
    && (!ruleKey || r.rule_key === ruleKey));
  let total = 0;
  for (const row of rows) {
    applyCreditDelta({
      schoolId, userId, delta: Math.abs(Number(row.delta)), ruleKey: 'rollback',
      reason, relatedType, relatedId, operatorId,
    });
    row.rolled_back = 1;
    total += Math.abs(Number(row.delta));
  }
  return { rolledBack: total, count: rows.length };
}

// ---------------- 处罚梯度（按累计成立次数） ----------------
export function validPenaltyCount(schoolId, userId) {
  return filter('reports', (r) => Number(r.target_user_id) === Number(userId)
    && Number(r.school_id) === Number(schoolId) && r.status === 'decided' && r.decision === 'valid').length;
}

export function applyPenalty({
  schoolId, userId, type, days = 0, reason, severity = 'light', source = 'report',
  reportId = null, operatorId = null, effectiveCount = null, permanent = false,
}) {
  const user = table('users').find((u) => Number(u.id) === Number(userId));
  if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在');
  const count = effectiveCount ?? (validPenaltyCount(schoolId, userId) || 1);
  const record = insert('penalties', {
    user_id: Number(userId), school_id: Number(schoolId), report_id: reportId,
    type, severity, effective_count: count, reason,
    start_at: nowIso(), end_at: permanent || !days ? (permanent ? null : nowIso()) : isoAfter(Number(days) * DAY),
    status: 'active', appeal_status: 'none', operator_id: operatorId, source, created_at: nowIso(),
  });

  // 封禁粒度：禁言 / 禁止交易 / 禁止登录 三个独立开关，逐级加重
  if (type === 'mute') user.mute_until = isoAfter(Number(days) * DAY);
  if (type === 'trade_ban') user.trade_ban_until = isoAfter(Number(days) * DAY);
  if (type === 'login_ban') user.login_ban_until = isoAfter(Number(days) * DAY);
  if (type === 'permanent_ban' || permanent) {
    user.banned_permanently = 1;
    user.login_ban_until = null;
    user.status = 'banned';
  }
  if (type === 'login_ban') user.status = 'banned';
  if (type === 'warning' || type === 'mute' || type === 'trade_ban') user.status = 'active';

  notify(userId, {
    schoolId,
    type: 'penalty',
    title: type === 'warning' ? '你收到一条站内警告' : '账号处罚通知',
    content: `${reason}${days ? `（${days} 天）` : ''}。可在「处罚申诉」页提交申诉，3 天内有效。`,
    relatedType: 'penalty',
    relatedId: record.id,
  });
  return record;
}

export function nextEscalationStep(schoolId, userId) {
  const cfg = configValue('penalty.escalation', schoolId);
  const nextCount = validPenaltyCount(schoolId, userId) + 1;
  const steps = cfg.steps || [];
  const step = steps.find((s) => Number(s.times) === nextCount) || steps[steps.length - 1];
  return { ...step, effectiveCount: nextCount };
}

// ---------------- 通知与审计 ----------------
export function notify(userId, { schoolId = null, type = 'system', title, content, relatedType = null, relatedId = null, channel = 'site' }) {
  return insert('notifications', {
    school_id: schoolId, user_id: Number(userId), type, title, content, channel,
    related_type: relatedType, related_id: relatedId, is_read: 0, read_at: null,
    sent_at: nowIso(), status: 'sent', created_at: nowIso(),
  });
}

export function notifyMany(userIds, payload) {
  return [...new Set(userIds.filter(Boolean).map(Number))].map((id) => notify(id, payload));
}

export function audit({ schoolId = null, actorId = null, actorRole = null, action, targetType = null, targetId = null, detail = null, ip = null }) {
  insert('audit_logs', {
    school_id: schoolId, actor_id: actorId, actor_role: actorRole, action,
    target_type: targetType, target_id: targetId,
    detail: detail ? JSON.stringify(detail) : null, ip, user_agent: null, created_at: nowIso(),
  });
}

// ---------------- 钱包：wallet_transactions 为唯一事实来源 ----------------
export function walletAccount(userId) {
  let account = table('wallet_accounts').find((a) => Number(a.user_id) === Number(userId));
  if (!account) {
    account = insert('wallet_accounts', {
      user_id: Number(userId), school_id: null, balance_cents: 0, frozen_cents: 0,
      version: 0, created_at: nowIso(), updated_at: nowIso(),
    });
  }
  return account;
}

/**
 * 记一笔资金流水并同步账户缓存
 * 幂等：相同 idempotencyKey 重复提交直接返回既有流水
 */
export function walletRecord({
  schoolId, userId, orderId = null, withdrawId = null, account = 'balance', direction,
  amountCents, bizType, idempotencyKey = null, remark = null,
}) {
  if (idempotencyKey) {
    const existed = table('wallet_transactions').find((t) => t.idempotency_key === idempotencyKey);
    if (existed) return { ...existed, idempotent: true };
  }
  const wallet = walletAccount(userId);
  const amount = Number(amountCents);
  const signed = direction === 'in' ? amount : -amount;
  const balanceAfter = Number(wallet.balance_cents) + (account === 'balance' ? signed : 0);
  const frozenAfter = Number(wallet.frozen_cents) + (account === 'frozen' ? signed : 0);
  if (account === 'balance' && balanceAfter < 0) {
    throw new AppError(ERR.INSUFFICIENT_BALANCE, '可用余额不足，请先充值');
  }
  const tx = insert('wallet_transactions', {
    tx_no: generateNo('TX'), school_id: Number(schoolId), user_id: Number(userId),
    order_id: orderId, withdraw_id: withdrawId, account, direction, amount_cents: amount,
    biz_type: bizType, status: 'success', balance_after_cents: balanceAfter,
    frozen_after_cents: frozenAfter, idempotency_key: idempotencyKey, remark, created_at: nowIso(),
  });
  wallet.balance_cents = balanceAfter;
  wallet.frozen_cents = frozenAfter;
  if (!wallet.school_id) wallet.school_id = Number(schoolId);
  wallet.version = Number(wallet.version || 0) + 1;
  wallet.updated_at = nowIso();
  return tx;
}

export function escrowFrozenCents(userId) {
  return table('wallet_transactions')
    .filter((t) => Number(t.user_id) === Number(userId) && t.status === 'success' && t.account === 'frozen')
    .reduce((sum, t) => sum + (t.direction === 'in' ? Number(t.amount_cents) : -Number(t.amount_cents)), 0);
}

// 买家付款 -> 可用余额转入托管冻结
export function escrowHold({ order }) {
  const base = `order:${order.id}:pay`;
  walletRecord({
    schoolId: order.school_id, userId: order.buyer_id, orderId: order.id, account: 'balance', direction: 'out',
    amountCents: order.amount_cents, bizType: 'pay', idempotencyKey: `${base}:balance`,
    remark: `订单 ${order.order_no} 支付（转入托管）`,
  });
  walletRecord({
    schoolId: order.school_id, userId: order.buyer_id, orderId: order.id, account: 'frozen', direction: 'in',
    amountCents: order.amount_cents, bizType: 'escrow_hold', idempotencyKey: `${base}:frozen`,
    remark: `订单 ${order.order_no} 资金托管冻结`,
  });
}

// 确认收货 -> 释放托管：卖家到账（已扣服务费）+ 平台服务费入账
export function escrowRelease({ order }) {
  const base = `order:${order.id}:release`;
  const amount = Number(order.amount_cents);
  const fee = Number(order.service_fee_cents);
  const income = Number(order.seller_income_cents);
  walletRecord({
    schoolId: order.school_id, userId: order.buyer_id, orderId: order.id, account: 'frozen', direction: 'out',
    amountCents: amount, bizType: 'escrow_release', idempotencyKey: `${base}:buyer-frozen`,
    remark: `订单 ${order.order_no} 确认收货，释放托管`,
  });
  walletRecord({
    schoolId: order.school_id, userId: order.seller_id, orderId: order.id, account: 'balance', direction: 'in',
    amountCents: income, bizType: 'settle', idempotencyKey: `${base}:seller`,
    remark: `订单 ${order.order_no} 放款（已扣服务费 ${(fee / 100).toFixed(2)} 元）`,
  });
  if (fee > 0) {
    const platform = table('users').find((u) => u.role === 'platform_admin');
    if (platform) {
      walletRecord({
        schoolId: order.school_id, userId: platform.id, orderId: order.id, account: 'balance', direction: 'in',
        amountCents: fee, bizType: 'fee', idempotencyKey: `${base}:fee`,
        remark: `订单 ${order.order_no} 平台服务费`,
      });
    }
  }
  return { income, fee };
}

// 退款 -> 托管解冻并退回买家余额
export function escrowRefund({ order, amountCents = null, reason = '订单退款' }) {
  const base = `order:${order.id}:refund`;
  const amount = Number(amountCents ?? order.amount_cents);
  walletRecord({
    schoolId: order.school_id, userId: order.buyer_id, orderId: order.id, account: 'frozen', direction: 'out',
    amountCents: amount, bizType: 'refund', idempotencyKey: `${base}:frozen`, remark: `${reason}（释放托管）`,
  });
  walletRecord({
    schoolId: order.school_id, userId: order.buyer_id, orderId: order.id, account: 'balance', direction: 'in',
    amountCents: amount, bizType: 'refund', idempotencyKey: `${base}:balance`, remark: `${reason}（退回余额）`,
  });
  return { refunded: amount };
}

export { db, table, insert, filter, configValue, nowIso, isoAfter, generateNo, DAY };
