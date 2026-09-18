// 演示版风控与客服处理器：违禁词、举报与申诉、工单队列、知识库、AI 客服
// 契约与真实后端一致（同一批错误码 / 同样的字段与处置结果），阈值全部来自 configs，不写死
import { table, insert, nowIso, isoAfter, generateNo, configValue } from '../store.js';
import { AppError, ERR } from '../vendor.js';
import {
  applyPenalty, applyCreditRule, rollbackCredit, notify, notifyMany, audit, creditPermissions,
} from '../rules.js';
import {
  check as wordCheck, listWords, createWord, updateWord, deleteWord, listHits, buildBlockMessage,
} from '../words.js';
import { paged, pageOf, requireFields } from './util.js';

const DAY = 86400000;
const HOUR = 3600000;
const URGENT_TYPES = ['refund', 'order'];
const MODERATOR_ROLES = ['school_admin', 'support', 'platform_admin'];

const ORDER_STATUS_TEXT = {
  pending_payment: '待付款',
  paid: '已付款（资金托管中，等待卖家发货）',
  shipped: '卖家已发货（待确认收货，超时将自动确认）',
  completed: '已完成（货款已放给卖家）',
  cancelled: '已取消（未付款）',
  refund_requested: '买家申请退款中（等待卖家处理）',
  return_requested: '买家申请退货退款中',
  refunded: '已退款（资金已退回买家）',
  disputed: '争议中（资金冻结，客服仲裁中）',
  arbitrated_release: '仲裁完成：已放款给卖家',
  arbitrated_refund: '仲裁完成：已退款给买家',
};

const ORDER_NO_RE = /\b(OD\d{12,})\b/i;

function configOr(key, schoolId, fallback) {
  try { return configValue(key, schoolId); } catch { return fallback; }
}

function byIdDesc(a, b) {
  return Number(b.id) - Number(a.id);
}

function byDateAsc(a, b) {
  return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
}

function monthsBetween(from, to = new Date()) {
  const a = new Date(from);
  const b = new Date(to);
  return (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth()) - (b.getDate() < a.getDate() ? 1 : 0);
}

function schoolIdOfUser(user) {
  return user && user.school_id !== null && user.school_id !== undefined ? Number(user.school_id) : null;
}

// ---------------- 举报：被投诉人解析（全部按 school_id 过滤，防止跨校反查） ----------------
const REPORT_TARGETS = {
  book: ['books', 'seller_id'],
  thread: ['threads', 'author_id'],
  reply: ['replies', 'author_id'],
  message: ['messages', 'sender_id'],
  user: ['users', 'id'],
};

function resolveTargetUser(schoolId, targetType, targetId) {
  if (targetType === 'order') {
    const order = table('orders').find((o) => Number(o.id) === Number(targetId) && Number(o.school_id) === Number(schoolId));
    if (!order) throw new AppError(ERR.TARGET_NOT_FOUND, '举报的订单不存在或不属于本校');
    return { targetUserId: Number(order.seller_id), related: order };
  }
  const conf = REPORT_TARGETS[targetType];
  if (!conf) throw new AppError(ERR.VALIDATION_ERROR, '不支持的举报类型：' + targetType);
  const row = table(conf[0]).find((r) => Number(r.id) === Number(targetId) && Number(r.school_id) === Number(schoolId));
  if (!row) throw new AppError(ERR.TARGET_NOT_FOUND, '举报的内容不存在或不属于本校');
  return { targetUserId: Number(row[conf[1]]), related: row };
}

function reportStats(schoolId) {
  const rows = table('reports').filter((r) => Number(r.school_id) === Number(schoolId));
  const grouped = new Map();
  for (const r of rows) {
    const severity = r.severity || 'light';
    const key = r.status + '|' + severity;
    if (!grouped.has(key)) grouped.set(key, { status: r.status, severity, total: 0 });
    grouped.get(key).total += 1;
  }
  const activePenalties = table('penalties')
    .filter((p) => Number(p.school_id) === Number(schoolId) && p.status !== 'revoked').length;
  const validReports = rows.filter((r) => r.decision === 'valid').length;
  return { byStatus: [...grouped.values()], activePenalties, validReports };
}

// 违规次数口径：仅统计未撤销处罚；轻度 12 个月滚动过期；连续 6 个月无违规可消除 1 次；严重永久保留
function effectiveViolationCounter(schoolId, userId) {
  const expireMonths = Number(configValue('credit.light_violation_expire_months', schoolId));
  const cleanMonthsClear = Number(configValue('credit.clean_months_clear_count', schoolId));
  const rows = table('penalties')
    .filter((p) => Number(p.user_id) === Number(userId) && Number(p.school_id) === Number(schoolId) && p.status !== 'revoked')
    .sort(byDateAsc);
  if (rows.length === 0) {
    return { effectiveCount: 0, total: 0, activeCount: 0, expiredCount: 0, severeCount: 0, reduction: 0, cleanMonths: 0 };
  }
  const active = rows.filter((r) => r.severity === 'severe' || monthsBetween(r.start_at) < expireMonths);
  const expiredCount = rows.length - active.length;
  const severeCount = active.filter((r) => r.severity === 'severe').length;
  const lastAt = active.length > 0 ? active[active.length - 1].start_at : rows[rows.length - 1].start_at;
  const cleanMonths = monthsBetween(lastAt);
  const reduction = cleanMonthsClear > 0 ? Math.floor(cleanMonths / cleanMonthsClear) : 0;
  const reducible = active.length - severeCount;
  const effectiveCount = severeCount + Math.max(0, reducible - reduction);
  return { effectiveCount, total: rows.length, activeCount: active.length, expiredCount, severeCount, reduction, cleanMonths };
}

function decideEscalationStep(schoolId, effectiveCount, severity) {
  const cfg = configValue('penalty.escalation', schoolId);
  const steps = [...cfg.steps].sort((a, b) => Number(a.times) - Number(b.times));
  if (severity === 'severe' && cfg.severeInstantBan) {
    return { ...steps[steps.length - 1], type: 'permanent_ban', days: null, reason: '严重违规一票永久封禁' };
  }
  return steps.find((s) => Number(s.times) >= Number(effectiveCount)) || steps[steps.length - 1];
}

// 撤销处罚：清空对应封禁开关 + 回滚信誉分（申诉复审通过时调用）
function revokePenalty(penalty, reviewerId, reason) {
  if (!penalty) throw new AppError(ERR.NOT_FOUND, '处罚记录不存在');
  if (penalty.status === 'revoked') return { alreadyRevoked: true, penaltyId: penalty.id };
  penalty.status = 'revoked';
  const user = table('users').find((u) => Number(u.id) === Number(penalty.user_id));
  if (user) {
    if (penalty.type === 'permanent_ban') {
      user.banned_permanently = 0;
      user.status = 'active';
    } else if (penalty.type === 'mute') {
      user.mute_until = null;
    } else if (penalty.type === 'trade_ban') {
      user.trade_ban_until = null;
    } else if (penalty.type === 'login_ban') {
      user.login_ban_until = null;
      if (user.status === 'banned') user.status = 'active';
    }
  }
  const rolled = rollbackCredit({
    schoolId: penalty.school_id, userId: penalty.user_id, relatedType: 'penalty',
    relatedId: penalty.id, reason, operatorId: reviewerId,
  });
  return { penaltyId: penalty.id, userId: penalty.user_id, schoolId: penalty.school_id, revoked: true, creditRolledBack: rolled.rolledBack };
}

// ---------------- 工单 ----------------
function slaOf(schoolId, type) {
  const sla = configValue('ticket.sla', schoolId);
  return URGENT_TYPES.includes(type) ? sla.urgent : sla.normal;
}

function ticketLog({ ticketId, schoolId, action, operatorId = null, operatorType = 'system', fromStatus = null, toStatus = null, note = null }) {
  return insert('ticket_logs', {
    ticket_id: Number(ticketId), school_id: Number(schoolId), action, operator_id: operatorId,
    operator_type: operatorType, from_status: fromStatus, to_status: toStatus, note, created_at: nowIso(),
  });
}

function openTicket({ schoolId, source = 'user', type = 'other', subject, description = null, relatedOrderId = null, relatedUserId = null, reporterId = null, priority = null }) {
  const sla = slaOf(schoolId, type);
  const finalPriority = priority || (URGENT_TYPES.includes(type) ? 'urgent' : 'normal');
  const ticket = insert('tickets', {
    ticket_no: generateNo('TK'), school_id: Number(schoolId), source, type, priority: finalPriority,
    subject, description, related_order_id: relatedOrderId, related_user_id: relatedUserId,
    reporter_id: reporterId, assignee_id: null, status: 'pending', first_response_at: null,
    first_response_due_at: isoAfter(Number(sla.firstResponseHours) * HOUR),
    resolve_due_at: isoAfter(Number(sla.resolveHours) * HOUR),
    escalated: 0, escalated_at: null, resolution: null,
    created_at: nowIso(), updated_at: nowIso(), closed_at: null,
  });
  ticketLog({ ticketId: ticket.id, schoolId, action: 'create', operatorId: reporterId, operatorType: source === 'ai' ? 'ai' : 'user', toStatus: 'pending', note: subject });
  if (configOr('ticket.auto_escalate', schoolId, true) && finalPriority === 'urgent') {
    ticket.escalated = 1;
    ticket.escalated_at = nowIso();
    ticketLog({ ticketId: ticket.id, schoolId, action: 'escalate', operatorType: 'system', fromStatus: 'pending', toStatus: 'pending', note: '资金类工单，自动标记加急' });
  }
  if (reporterId) {
    notify(reporterId, {
      schoolId, type: 'ticket', title: '工单已创建',
      content: finalPriority === 'urgent'
        ? '工单 #' + ticket.id + ' 已创建，资金类问题将在 4 小时内响应'
        : '工单 #' + ticket.id + ' 已创建，我们将在 24 小时内响应',
      relatedType: 'ticket', relatedId: ticket.id,
    });
  }
  return { ticketId: ticket.id, ticket, priority: finalPriority, sla };
}

// SLA 超时扫描：与后端定时任务同规则，演示环境在读取工单时顺带执行
function sweepSlaTickets(schoolId) {
  if (!configOr('ticket.auto_escalate', schoolId, true)) return 0;
  const now = Date.now();
  const rows = table('tickets').filter((t) => Number(t.school_id) === Number(schoolId)
    && !t.escalated && ['pending', 'processing'].includes(t.status)
    && ((!t.first_response_at && t.first_response_due_at && new Date(t.first_response_due_at).getTime() <= now)
      || (t.resolve_due_at && new Date(t.resolve_due_at).getTime() <= now)));
  for (const t of rows) {
    t.escalated = 1;
    t.escalated_at = nowIso();
    t.priority = 'urgent';
    ticketLog({ ticketId: t.id, schoolId, action: 'escalate', operatorType: 'system', fromStatus: t.status, toStatus: t.status, note: 'SLA 超时，系统自动升级' });
    if (t.reporter_id) {
      notify(t.reporter_id, {
        schoolId, type: 'ticket', title: '你的工单已加急',
        content: '工单 #' + t.id + ' 已升级为加急处理，我们会优先响应', relatedType: 'ticket', relatedId: t.id,
      });
    }
  }
  return rows.length;
}

function ticketStats(schoolId) {
  sweepSlaTickets(schoolId);
  const rows = table('tickets').filter((t) => Number(t.school_id) === Number(schoolId));
  const grouped = new Map();
  for (const t of rows) {
    const key = t.status + '|' + t.priority;
    if (!grouped.has(key)) grouped.set(key, { status: t.status, priority: t.priority, total: 0, on_time: 0, escalated: 0 });
    const g = grouped.get(key);
    g.total += 1;
    if (t.first_response_at && t.first_response_due_at
      && new Date(t.first_response_at) <= new Date(t.first_response_due_at)) g.on_time += 1;
    if (Number(t.escalated)) g.escalated += 1;
  }
  const now = Date.now();
  const overdue = rows.filter((t) => ['pending', 'processing'].includes(t.status)
    && t.resolve_due_at && new Date(t.resolve_due_at).getTime() <= now).length;
  return { groups: [...grouped.values()], overdue };
}

function ticketDetail({ schoolId, ticketId }) {
  const ticket = table('tickets').find((t) => Number(t.id) === Number(ticketId) && Number(t.school_id) === Number(schoolId));
  if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
  const logs = table('ticket_logs')
    .filter((l) => Number(l.ticket_id) === Number(ticketId) && Number(l.school_id) === Number(schoolId))
    .sort((a, b) => Number(a.id) - Number(b.id));

  let orderSnapshot = null;
  if (ticket.related_order_id) {
    const order = table('orders').find((o) => Number(o.id) === Number(ticket.related_order_id) && Number(o.school_id) === Number(schoolId));
    if (order) {
      orderSnapshot = {
        order,
        statusLogs: table('order_status_log')
          .filter((l) => Number(l.order_id) === Number(order.id))
          .map((l) => ({ from_status: l.from_status, to_status: l.to_status, action: l.action, reason: l.reason, created_at: l.created_at })),
        transactions: table('wallet_transactions')
          .filter((t) => Number(t.order_id) === Number(order.id))
          .map((t) => ({ tx_no: t.tx_no, user_id: t.user_id, account: t.account, direction: t.direction, amount_cents: t.amount_cents, biz_type: t.biz_type, remark: t.remark })),
      };
    }
  }

  let userRisk = null;
  const uid = ticket.related_user_id || ticket.reporter_id;
  if (uid) {
    const user = table('users').find((u) => Number(u.id) === Number(uid));
    const userView = user ? {
      id: user.id, nickname: user.nickname, role: user.role, status: user.status,
      verification_status: user.verification_status, credit_score: user.credit_score,
      mute_until: user.mute_until, trade_ban_until: user.trade_ban_until,
      login_ban_until: user.login_ban_until, banned_permanently: user.banned_permanently,
      student_no_mask: user.student_no_mask,
    } : null;
    userRisk = {
      user: userView,
      credit: user ? creditPermissions(Number(user.school_id || schoolId), user.id) : null,
      violationCounter: effectiveViolationCounter(schoolId, uid),
      penalties: table('penalties')
        .filter((p) => Number(p.user_id) === Number(uid))
        .map((p) => ({ id: p.id, type: p.type, severity: p.severity, effective_count: p.effective_count, reason: p.reason, status: p.status, appeal_status: p.appeal_status, start_at: p.start_at, end_at: p.end_at }))
        .slice(0, 10),
      reports: table('reports')
        .filter((r) => Number(r.target_user_id) === Number(uid) && Number(r.school_id) === Number(schoolId))
        .map((r) => ({ id: r.id, report_no: r.report_no, decision: r.decision, reason: r.reason, decided_at: r.decided_at }))
        .slice(0, 10),
    };
  }
  return { ticket, logs, orderSnapshot, userRisk };
}

// ---------------- 知识库检索（与学生端 FAQ 一致的简易分词） ----------------
const FAQ_KEYWORDS = ['服务费', '托管', '自动确认', '退款', '认证', '解绑', '申诉', '违规', '发布', '信誉分', '工单'];

function tokenizeQuestion(text) {
  const raw = String(text || '').trim();
  const hit = FAQ_KEYWORDS.find((k) => raw.includes(k));
  if (hit) return hit;
  // 2 字滑窗：用于中文短句的模糊检索
  const grams = [];
  for (let i = 0; i + 2 <= raw.length; i += 1) grams.push(raw.slice(i, i + 2));
  return grams[0] || raw;
}

function matchKb(schoolId, text) {
  const token = tokenizeQuestion(text);
  if (!token) return null;
  const rows = table('kb_articles')
    .filter((a) => a.status === 'published' && (a.school_id === null || a.school_id === undefined || Number(a.school_id) === Number(schoolId)))
    .filter((a) => [a.question, a.keywords, a.answer].filter(Boolean).some((v) => String(v).includes(token)));
  if (rows.length === 0) return null;
  rows.sort((a, b) => Number(b.view_count || 0) - Number(a.view_count || 0));
  return rows[0];
}

// ---------------- AI 客服意图（与后端 INTENT_RULES 同源） ----------------
const INTENT_RULES = [
  { intent: 'transfer', keywords: ['转人工', '人工客服', '找客服', '真人'] },
  { intent: 'refund_request', keywords: ['退款', '退钱', '退货', '申请退'] },
  { intent: 'order_query', keywords: ['订单', '发货', '物流', '快递', '到哪', '收货', '单号'] },
  { intent: 'credit_query', keywords: ['信誉分', '信用分', '扣分', '禁言'] },
  { intent: 'faq', keywords: ['服务费', '手续费', '怎么', '为什么', '多久', '规则', '认证', '申诉', '解绑'] },
];

function detectIntent(text, rules) {
  const raw = String(text || '');
  for (const rule of INTENT_RULES) {
    const hit = rule.keywords.filter((k) => raw.includes(k));
    if (hit.length > 0) return { intent: rule.intent, confidence: Math.min(0.95, 0.5 + hit.length * 0.15), matched: hit };
  }
  const fundHit = (rules.fundKeywords || []).filter((k) => raw.includes(k));
  if (fundHit.length > 0) return { intent: 'refund_request', confidence: 0.6, matched: fundHit };
  return { intent: 'other', confidence: 0.3, matched: [] };
}

function toolOrderQuery(schoolId, userId, content) {
  const match = ORDER_NO_RE.exec(String(content || ''));
  let order = null;
  if (match) {
    order = table('orders').find((o) => o.order_no === match[1] && Number(o.school_id) === Number(schoolId)
      && (Number(o.buyer_id) === Number(userId) || Number(o.seller_id) === Number(userId)));
  } else {
    order = table('orders')
      .filter((o) => Number(o.school_id) === Number(schoolId)
        && (Number(o.buyer_id) === Number(userId) || Number(o.seller_id) === Number(userId)))
      .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  }
  if (!order) return { ok: false, reply: '没有查询到相关订单，请确认订单号是否正确，或到「我的订单」查看。' };
  const role = Number(order.buyer_id) === Number(userId) ? '买家' : '卖家';
  const parts = [
    '订单 ' + order.order_no + '（你是' + role + '）当前状态：' + (ORDER_STATUS_TEXT[order.status] || order.status) + '。',
    '金额 ' + (Number(order.amount_cents) / 100).toFixed(2) + ' 元，平台服务费 ' + (Number(order.service_fee_cents) / 100).toFixed(2) + ' 元。',
  ];
  if (order.escrow_status === 'held') parts.push('资金目前在平台托管中，确认收货后才会放款给卖家。');
  if (order.status === 'shipped' && order.auto_confirm_at) {
    parts.push('预计自动确认收货时间：' + new Date(order.auto_confirm_at).toLocaleString('zh-CN') + '。');
  }
  if (order.express_no) parts.push('物流：' + (order.express_company || '') + ' ' + order.express_no + '。');
  return { ok: true, reply: parts.join(''), order };
}

function toolCreditQuery(schoolId, userId) {
  const user = table('users').find((u) => Number(u.id) === Number(userId));
  if (!user) return { ok: false, reply: '未找到你的账号信息。' };
  const parts = ['你当前信誉分 ' + user.credit_score + ' 分。'];
  if (user.mute_until) parts.push('禁言至 ' + new Date(user.mute_until).toLocaleString('zh-CN') + '。');
  if (user.trade_ban_until) parts.push('限制交易至 ' + new Date(user.trade_ban_until).toLocaleString('zh-CN') + '。');
  const permissions = creditPermissions(schoolId, userId);
  parts.push('当前档位「' + permissions.tierLabel + '」。信誉分低于 50 分将限制挂书数量与提现时效，低于 30 分仅可浏览。');
  return { ok: true, reply: parts.join('') };
}

// AI 只能发起申请：真正的退款由人工或卖家执行
function toolCreateRefundRequest({ schoolId, userId, content }) {
  const order = table('orders')
    .filter((o) => Number(o.school_id) === Number(schoolId) && Number(o.buyer_id) === Number(userId)
      && ['paid', 'shipped', 'refund_requested'].includes(o.status))
    .sort((a, b) => Number(b.id) - Number(a.id))[0] || null;
  const created = openTicket({
    schoolId, source: 'ai', type: 'refund', priority: 'urgent',
    subject: 'AI 客服转退款申请：' + (order ? order.order_no : '未关联订单'),
    description: '用户诉求：' + String(content).slice(0, 500),
    relatedOrderId: order ? order.id : null, relatedUserId: userId, reporterId: userId,
  });
  return { ticketId: created.ticketId, orderId: order ? order.id : null };
}

function transferToHuman({ schoolId, userId, sessionId, reason }) {
  const session = table('chat_sessions').find((s) => Number(s.id) === Number(sessionId) && Number(s.school_id) === Number(schoolId));
  if (!session) throw new AppError(ERR.NOT_FOUND, '会话不存在');
  let ticketId = session.ticket_id;
  if (!ticketId) {
    const created = openTicket({
      schoolId, source: 'ai', type: 'other', priority: 'normal',
      subject: 'AI 客服转人工', description: '转人工原因：' + reason,
      reporterId: userId, relatedUserId: userId,
    });
    ticketId = created.ticketId;
  }
  session.channel = 'human';
  session.status = 'transferred';
  session.ticket_id = ticketId;
  session.updated_at = nowIso();
  insert('chat_messages', {
    session_id: Number(sessionId), school_id: Number(schoolId), role: 'system',
    content: '已转人工：' + reason, intent: 'transfer',
    tool_calls: JSON.stringify([{ tool: 'create_ticket', ticketId }]),
    confidence: null, created_at: nowIso(),
  });
  notify(userId, {
    schoolId, type: 'ticket', title: '已为你转接人工客服',
    content: '人工客服工作时间 9:00-21:00，你的问题已生成工单 ' + ticketId,
    relatedType: 'ticket', relatedId: ticketId,
  });
  return { ticketId, transferred: true };
}

export function registerRiskRoutes(route) {
  // ---------------- 违禁词：发布前预检 ----------------
  route('POST', '/words/check', (ctx) => {
    requireFields(ctx.body, ['text']);
    const decision = wordCheck({ schoolId: ctx.schoolId, text: ctx.body.text });
    return {
      level: decision.level,
      action: decision.action,
      blocked: decision.blocked,
      maskedText: decision.text,
      hits: decision.hits.map((h) => ({ word: h.word, level: h.level, position: h.position, matchedText: h.matchedText })),
      scoreDelta: decision.scoreDelta,
      message: decision.hits.length ? buildBlockMessage(decision) : '未发现违规内容',
    };
  });

  // ---------------- 词库维护 ----------------
  route('GET', '/admin/banned-words', (ctx) => listWords({
    schoolId: ctx.schoolId, level: ctx.query.level || null, status: ctx.query.status || null,
  }), { moderator: true });

  route('GET', '/admin/banned-words/hits', (ctx) => {
    const { page, pageSize } = pageOf(ctx.query);
    const data = listHits({
      schoolId: ctx.schoolId,
      userId: ctx.query.userId ? Number(ctx.query.userId) : null,
      level: ctx.query.level || null, page, pageSize,
    });
    return paged(data.list, data.total, page, pageSize);
  }, { moderator: true });

  route('POST', '/admin/banned-words', (ctx) => {
    requireFields(ctx.body, ['word', 'level']);
    const scope = ctx.body.scope || 'school';
    if (scope === 'global' && ctx.user.role !== 'platform_admin') {
      throw new AppError(ERR.FORBIDDEN, '只有平台管理员可以维护全局词库');
    }
    const created = createWord({ ...ctx.body, scope, schoolId: scope === 'school' ? ctx.schoolId : null }, { actorId: ctx.user.id, schoolId: ctx.schoolId });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'banned_word.create', targetType: 'banned_word', targetId: created.id, detail: { word: created.word, level: created.level } });
    return created;
  }, { moderator: true, message: '词条已创建' });

  route('PATCH', '/admin/banned-words/:id', (ctx) => {
    const updated = updateWord(Number(ctx.params.id), ctx.body, { schoolId: ctx.schoolId });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'banned_word.update', targetType: 'banned_word', targetId: updated.id, detail: ctx.body });
    return updated;
  }, { moderator: true, message: '词条已更新' });

  route('DELETE', '/admin/banned-words/:id', (ctx) => {
    const removed = deleteWord(Number(ctx.params.id));
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'banned_word.delete', targetType: 'banned_word', targetId: Number(ctx.params.id) });
    return removed;
  }, { moderator: true, message: '词条已删除' });

  // ---------------- 举报 ----------------
  route('POST', '/reports', (ctx) => {
    const { targetType, targetId, reason, description, evidence } = ctx.body;
    requireFields(ctx.body, ['targetType', 'targetId', 'reason']);
    if (!REPORT_TARGETS[targetType] && targetType !== 'order') throw new AppError(ERR.VALIDATION_ERROR, '不支持的举报类型：' + targetType);
    if (String(reason).length < 2 || String(reason).length > 60) throw new AppError(ERR.VALIDATION_ERROR, '举报原因长度需在 2-60 字之间');
    const resolved = resolveTargetUser(ctx.schoolId, targetType, Number(targetId));
    if (Number(resolved.targetUserId) === Number(ctx.user.id)) {
      throw new AppError(ERR.VALIDATION_ERROR, '不能举报自己发布的内容');
    }
    const duplicated = table('reports').some((r) => Number(r.school_id) === Number(ctx.schoolId)
      && Number(r.reporter_id) === Number(ctx.user.id) && r.target_type === targetType
      && Number(r.target_id) === Number(targetId) && ['pending', 'accepted', 'proving'].includes(r.status));
    if (duplicated) throw new AppError(ERR.DUPLICATE_REPORT, '你已举报过该内容，请等待平台处理');
    const reportNo = generateNo('RP');
    const report = insert('reports', {
      report_no: reportNo, school_id: Number(ctx.schoolId), reporter_id: Number(ctx.user.id),
      target_type: targetType, target_id: Number(targetId), target_user_id: Number(resolved.targetUserId),
      reason: String(reason), description: description || null,
      evidence: Array.isArray(evidence) && evidence.length ? evidence.slice(0, 9) : null,
      status: 'pending', severity: 'light', handler_id: null, accepted_at: null,
      proof_deadline_at: null, proof_content: null, decision: null, decision_note: null,
      decided_at: null, appeal_deadline_at: null, created_at: nowIso(), updated_at: nowIso(),
    });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'report.create', targetType: 'report', targetId: report.id, detail: { targetType, targetId, reason } });
    return { reportId: report.id, reportNo, status: 'pending' };
  }, { message: '举报已提交，我们会尽快受理' });

  route('GET', '/reports', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const rows = table('reports')
      .filter((r) => Number(r.school_id) === Number(ctx.schoolId))
      .filter((r) => !ctx.query.status || r.status === ctx.query.status)
      .sort(byIdDesc);
    const list = rows.slice(offset, offset + pageSize).map((r) => ({
      id: r.id, report_no: r.report_no, reporter_id: r.reporter_id, target_type: r.target_type,
      target_id: r.target_id, target_user_id: r.target_user_id, reason: r.reason, status: r.status,
      severity: r.severity, decision: r.decision, handler_id: r.handler_id,
      proof_deadline_at: r.proof_deadline_at, decided_at: r.decided_at,
      appeal_deadline_at: r.appeal_deadline_at, created_at: r.created_at,
    }));
    return paged(list, rows.length, page, pageSize);
  }, { moderator: true });

  route('GET', '/reports/stats', (ctx) => reportStats(ctx.schoolId), { moderator: true });

  route('GET', '/reports/:id', (ctx) => {
    const report = table('reports').find((r) => Number(r.id) === Number(ctx.params.id) && Number(r.school_id) === Number(ctx.schoolId));
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (MODERATOR_ROLES.includes(ctx.user.role)) {
      audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'report.read_evidence', targetType: 'report', targetId: report.id });
    }
    return { ...report, evidence_enc: undefined };
  }, { moderator: true });

  route('POST', '/reports/:id/accept', (ctx) => {
    const proofHours = Number(configValue('order.report_proof_hours', ctx.schoolId));
    const report = table('reports').find((r) => Number(r.id) === Number(ctx.params.id) && Number(r.school_id) === Number(ctx.schoolId));
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (report.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, '当前状态（' + report.status + '）不可受理');
    report.status = 'proving';
    report.handler_id = Number(ctx.user.id);
    report.accepted_at = nowIso();
    report.proof_deadline_at = isoAfter(proofHours * HOUR);
    report.updated_at = nowIso();
    notify(report.target_user_id, {
      schoolId: ctx.schoolId, type: 'report', title: '你收到一条投诉',
      content: '有人举报你的内容（原因：' + report.reason + '），请在 ' + proofHours + ' 小时内提交举证材料，逾期将按平台规则处理',
      relatedType: 'report', relatedId: report.id,
    });
    notify(report.reporter_id, {
      schoolId: ctx.schoolId, type: 'report', title: '举报已受理',
      content: '你的举报已受理，平台将在举证期结束后作出裁定', relatedType: 'report', relatedId: report.id,
    });
    return { reportId: report.id, status: 'proving', proofDeadlineHours: proofHours };
  }, { moderator: true, message: '已受理，已通知被投诉人 48 小时内举证' });

  route('POST', '/reports/:id/proof', (ctx) => {
    requireFields(ctx.body, ['content']);
    const report = table('reports').find((r) => Number(r.id) === Number(ctx.params.id) && Number(r.school_id) === Number(ctx.schoolId));
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (Number(report.target_user_id) !== Number(ctx.user.id)) throw new AppError(ERR.FORBIDDEN, '只有被投诉人可以提交举证');
    if (report.status !== 'proving') throw new AppError(ERR.ORDER_STATE_INVALID, '当前不在举证阶段');
    if (report.proof_deadline_at && new Date(report.proof_deadline_at) < new Date()) {
      throw new AppError(ERR.CONFLICT, '举证期限已过，如需补充材料请联系客服');
    }
    report.proof_content = String(ctx.body.content);
    report.updated_at = nowIso();
    notify(report.reporter_id, {
      schoolId: ctx.schoolId, type: 'report', title: '被投诉人已提交举证',
      content: '平台将在举证期结束后作出裁定', relatedType: 'report', relatedId: report.id,
    });
    return { reportId: report.id, status: 'proving' };
  }, { message: '举证已提交' });

  route('POST', '/reports/:id/decide', (ctx) => {
    const { decision, note, severity, type, days } = ctx.body;
    requireFields(ctx.body, ['decision', 'note']);
    if (!['valid', 'invalid'].includes(decision)) throw new AppError(ERR.VALIDATION_ERROR, '裁定结果只能是 valid 或 invalid');
    const appealDays = Number(configValue('report.appeal_days', ctx.schoolId));
    const report = table('reports').find((r) => Number(r.id) === Number(ctx.params.id) && Number(r.school_id) === Number(ctx.schoolId));
    if (!report) throw new AppError(ERR.NOT_FOUND, '举报记录不存在');
    if (!['accepted', 'proving'].includes(report.status)) {
      throw new AppError(ERR.ORDER_STATE_INVALID, '当前状态（' + report.status + '）不可裁定');
    }
    const finalSeverity = severity || 'light';
    let penalty = null;
    if (decision === 'valid') {
      const counter = effectiveViolationCounter(ctx.schoolId, report.target_user_id);
      const effectiveCount = counter.effectiveCount + 1;
      const step = type
        ? { type, days: days ?? 0, scoreDelta: 0, label: '人工处罚' }
        : decideEscalationStep(ctx.schoolId, effectiveCount, finalSeverity);
      const reason = '举报成立（' + report.reason + '）：' + (note || '经核实违规');
      const record = applyPenalty({
        schoolId: ctx.schoolId, userId: report.target_user_id, reportId: report.id,
        type: step.type, days: step.days, severity: finalSeverity, source: 'report',
        reason, operatorId: ctx.user.id, effectiveCount, permanent: step.type === 'permanent_ban',
      });
      const delta = Number(step.scoreDelta || 0);
      if (delta !== 0) {
        applyCreditRule({
          schoolId: ctx.schoolId, userId: report.target_user_id,
          ruleKey: delta < 0 ? 'report_light' : 'adjust',
          reason: reason + '（' + (step.label || step.type) + '）',
          relatedType: 'penalty', relatedId: record.id, operatorId: ctx.user.id,
          expiresAt: finalSeverity === 'severe' ? null : isoAfter(365 * DAY),
          deltaOverride: delta,
        });
      }
      penalty = { penaltyId: record.id, step, effectiveCount, endAt: record.end_at, creditDelta: delta, counter };
    }
    report.status = 'decided';
    report.decision = decision;
    report.decision_note = note;
    report.severity = finalSeverity;
    report.decided_at = nowIso();
    report.appeal_deadline_at = isoAfter(appealDays * DAY);
    report.handler_id = Number(ctx.user.id);
    report.updated_at = nowIso();

    notifyMany([report.reporter_id, report.target_user_id], {
      schoolId: ctx.schoolId, type: 'report',
      title: decision === 'valid' ? '举报裁定：成立' : '举报裁定：不成立',
      content: decision === 'valid'
        ? '裁定成立，已对被投诉人执行处罚（' + (penalty ? (penalty.step.label || penalty.step.type) : '') + '）。如有异议可在 ' + appealDays + ' 天内申诉'
        : '经核实证据不足，本次举报不成立，不记为违规',
      relatedType: 'report', relatedId: report.id,
    });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'report.decide', targetType: 'report', targetId: report.id, detail: { decision, severity: finalSeverity, penaltyId: penalty ? penalty.penaltyId : null } });
    return { reportId: report.id, decision, penalty, appealDays };
  }, { moderator: true, message: '裁定已提交' });

  // ---------------- 申诉 ----------------
  route('POST', '/appeals', (ctx) => {
    const { penaltyId, reason, evidence } = ctx.body;
    requireFields(ctx.body, ['penaltyId', 'reason']);
    if (String(reason).length < 5) throw new AppError(ERR.VALIDATION_ERROR, '申诉理由不少于 5 个字');
    const appealDays = Number(configValue('report.appeal_days', ctx.schoolId));
    const penalty = table('penalties').find((p) => Number(p.id) === Number(penaltyId)
      && Number(p.school_id) === Number(ctx.schoolId) && Number(p.user_id) === Number(ctx.user.id));
    if (!penalty) throw new AppError(ERR.NOT_FOUND, '处罚记录不存在');
    if (penalty.status === 'revoked') throw new AppError(ERR.CONFLICT, '该处罚已被撤销');
    if (penalty.appeal_status === 'pending') throw new AppError(ERR.CONFLICT, '你已提交过申诉，请等待复审');
    if (new Date(penalty.start_at).getTime() + appealDays * DAY < Date.now()) {
      throw new AppError(ERR.CONFLICT, '申诉期已过（处罚后 ' + appealDays + ' 天内可申诉）');
    }
    const appeal = insert('appeals', {
      appeal_no: generateNo('AP'), school_id: Number(ctx.schoolId), user_id: Number(ctx.user.id),
      penalty_id: Number(penalty.id), reason: String(reason),
      evidence: Array.isArray(evidence) && evidence.length ? evidence.slice(0, 9) : null,
      status: 'pending', reviewer_id: null, review_note: null, reviewed_at: null,
      created_at: nowIso(), updated_at: nowIso(),
    });
    penalty.appeal_status = 'pending';
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'appeal.create', targetType: 'appeal', targetId: appeal.id, detail: { penaltyId: penalty.id } });
    return { appealId: appeal.id, appealNo: appeal.appeal_no, status: 'pending' };
  }, { message: '申诉已提交' });

  route('GET', '/appeals', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const isModerator = MODERATOR_ROLES.includes(ctx.user.role);
    const rows = table('appeals')
      .filter((a) => Number(a.school_id) === Number(ctx.schoolId))
      .filter((a) => isModerator || Number(a.user_id) === Number(ctx.user.id))
      .sort(byIdDesc);
    const list = rows.slice(offset, offset + pageSize).map((a) => ({
      id: a.id, appeal_no: a.appeal_no, user_id: a.user_id, penalty_id: a.penalty_id,
      reason: a.reason, status: a.status, review_note: a.review_note,
      reviewed_at: a.reviewed_at, created_at: a.created_at,
    }));
    return paged(list, rows.length, page, pageSize);
  });

  route('POST', '/appeals/:id/review', (ctx) => {
    requireFields(ctx.body, ['note']);
    const appeal = table('appeals').find((a) => Number(a.id) === Number(ctx.params.id) && Number(a.school_id) === Number(ctx.schoolId));
    if (!appeal) throw new AppError(ERR.NOT_FOUND, '申诉不存在');
    if (appeal.status !== 'pending') throw new AppError(ERR.ORDER_STATE_INVALID, '该申诉已复审');
    const approve = Boolean(ctx.body.approve);
    appeal.status = approve ? 'approved' : 'rejected';
    appeal.reviewer_id = Number(ctx.user.id);
    appeal.review_note = String(ctx.body.note);
    appeal.reviewed_at = nowIso();
    appeal.updated_at = nowIso();
    let revoked = null;
    const penalty = table('penalties').find((p) => Number(p.id) === Number(appeal.penalty_id));
    if (approve && penalty) {
      revoked = revokePenalty(penalty, ctx.user.id, '申诉通过：' + ctx.body.note);
      penalty.appeal_status = 'approved';
      audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'penalty.revoke', targetType: 'penalty', targetId: penalty.id, detail: { creditRolledBack: revoked.creditRolledBack } });
    } else if (penalty) {
      penalty.appeal_status = 'rejected';
    }
    notify(appeal.user_id, {
      schoolId: ctx.schoolId, type: 'penalty',
      title: approve ? '申诉结果：通过' : '申诉结果：未通过',
      content: approve
        ? '你的申诉已通过，处罚已撤销，信誉分已回滚。说明：' + ctx.body.note
        : '你的申诉未通过。说明：' + ctx.body.note,
      relatedType: 'appeal', relatedId: appeal.id,
    });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'appeal.review', targetType: 'appeal', targetId: appeal.id, detail: { approve } });
    return { appealId: appeal.id, approved: approve, revoked };
  }, { moderator: true, message: '复审已提交' });

  // ---------------- 工单 ----------------
  route('POST', '/tickets', (ctx) => {
    requireFields(ctx.body, ['subject']);
    if (String(ctx.body.subject).length < 4) throw new AppError(ERR.VALIDATION_ERROR, '工单标题至少 4 个字');
    const type = ctx.body.type || 'other';
    if (!['order', 'refund', 'account', 'content', 'other'].includes(type)) throw new AppError(ERR.VALIDATION_ERROR, '不支持的工单类型');
    let relatedOrderId = ctx.body.relatedOrderId ? Number(ctx.body.relatedOrderId) : null;
    if (relatedOrderId) {
      const order = table('orders').find((o) => Number(o.id) === relatedOrderId && Number(o.school_id) === Number(ctx.schoolId));
      if (!order) throw new AppError(ERR.ORDER_NOT_FOUND, '关联订单不存在或不属于本校');
    }
    const created = openTicket({
      schoolId: ctx.schoolId, source: 'user', type, subject: String(ctx.body.subject),
      description: ctx.body.description || null, relatedOrderId, reporterId: Number(ctx.user.id),
    });
    return { ticketId: created.ticketId, priority: created.priority, sla: created.sla };
  }, { message: '工单已创建' });

  route('GET', '/tickets', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    sweepSlaTickets(ctx.schoolId);
    const rows = table('tickets')
      .filter((t) => Number(t.school_id) === Number(ctx.schoolId))
      .filter((t) => !ctx.query.status || t.status === ctx.query.status)
      .filter((t) => !ctx.query.priority || t.priority === ctx.query.priority)
      .filter((t) => !ctx.query.assigneeId || Number(t.assignee_id) === Number(ctx.query.assigneeId))
      .sort((a, b) => {
        if ((a.priority === 'urgent') !== (b.priority === 'urgent')) return a.priority === 'urgent' ? -1 : 1;
        const left = a.first_response_at || a.first_response_due_at || a.created_at;
        const right = b.first_response_at || b.first_response_due_at || b.created_at;
        if (left !== right) return new Date(left) - new Date(right);
        return Number(b.id) - Number(a.id);
      });
    const now = Date.now();
    const list = rows.slice(offset, offset + pageSize).map((t) => ({
      id: t.id, ticket_no: t.ticket_no, source: t.source, type: t.type, priority: t.priority,
      subject: t.subject, status: t.status, assignee_id: t.assignee_id, escalated: t.escalated,
      first_response_at: t.first_response_at, first_response_due_at: t.first_response_due_at,
      resolve_due_at: t.resolve_due_at,
      first_response_left_minutes: t.first_response_due_at
        ? Math.round((new Date(t.first_response_due_at).getTime() - now) / 60000) : null,
      created_at: t.created_at,
    }));
    return paged(list, rows.length, page, pageSize);
  }, { moderator: true });

  route('GET', '/tickets/stats', (ctx) => ticketStats(ctx.schoolId), { moderator: true });

  route('GET', '/tickets/:id', (ctx) => {
    sweepSlaTickets(ctx.schoolId);
    const data = ticketDetail({ schoolId: ctx.schoolId, ticketId: Number(ctx.params.id) });
    const isModerator = MODERATOR_ROLES.includes(ctx.user.role);
    const isOwner = Number(data.ticket.reporter_id) === Number(ctx.user.id);
    if (!isModerator && !isOwner) throw new AppError(ERR.FORBIDDEN, '无权查看该工单');
    if (!isModerator) return { ticket: data.ticket, logs: data.logs };
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'ticket.view_snapshot', targetType: 'ticket', targetId: data.ticket.id });
    return data;
  });

  route('POST', '/tickets/:id/claim', (ctx) => {
    const ticket = table('tickets').find((t) => Number(t.id) === Number(ctx.params.id) && Number(t.school_id) === Number(ctx.schoolId));
    if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
    if (ticket.assignee_id && Number(ticket.assignee_id) !== Number(ctx.user.id)) {
      throw new AppError(ERR.ALREADY_CLAIMED, '该工单已被其他客服接单');
    }
    const fromStatus = ticket.status;
    ticket.assignee_id = Number(ctx.user.id);
    if (['pending', 'escalated'].includes(ticket.status)) ticket.status = 'processing';
    ticket.updated_at = nowIso();
    ticketLog({ ticketId: ticket.id, schoolId: ctx.schoolId, action: 'claim', operatorId: ctx.user.id, operatorType: 'staff', fromStatus, toStatus: ticket.status, note: '客服接单' });
    return { ticketId: ticket.id, assigneeId: Number(ctx.user.id), status: ticket.status };
  }, { moderator: true, message: '接单成功' });

  route('POST', '/tickets/:id/reply', (ctx) => {
    requireFields(ctx.body, ['content']);
    const ticket = table('tickets').find((t) => Number(t.id) === Number(ctx.params.id) && Number(t.school_id) === Number(ctx.schoolId));
    if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
    if (!ticket.first_response_at) ticket.first_response_at = nowIso();
    if (ticket.status === 'pending') ticket.status = 'processing';
    if (!ticket.assignee_id) ticket.assignee_id = Number(ctx.user.id);
    ticket.updated_at = nowIso();
    ticketLog({ ticketId: ticket.id, schoolId: ctx.schoolId, action: 'reply', operatorId: ctx.user.id, operatorType: 'staff', fromStatus: ticket.status, toStatus: ticket.status, note: (ctx.body.quickReplyKey ? '[' + ctx.body.quickReplyKey + '] ' : '') + String(ctx.body.content).slice(0, 200) });
    if (ticket.reporter_id) {
      notify(ticket.reporter_id, {
        schoolId: ctx.schoolId, type: 'ticket', title: '工单 #' + ticket.id + ' 有新回复',
        content: String(ctx.body.content), relatedType: 'ticket', relatedId: ticket.id,
      });
    }
    return { ticketId: ticket.id, status: ticket.status, firstResponseAt: ticket.first_response_at };
  }, { moderator: true, message: '已回复用户' });

  route('POST', '/tickets/:id/resolve', (ctx) => {
    requireFields(ctx.body, ['resolution']);
    const ticket = table('tickets').find((t) => Number(t.id) === Number(ctx.params.id) && Number(t.school_id) === Number(ctx.schoolId));
    if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
    const fromStatus = ticket.status;
    ticket.status = 'resolved';
    ticket.resolution = String(ctx.body.resolution);
    ticket.resolved_at = nowIso();
    ticket.closed_at = nowIso();
    ticket.updated_at = nowIso();
    if (!ticket.assignee_id) ticket.assignee_id = Number(ctx.user.id);
    ticketLog({ ticketId: ticket.id, schoolId: ctx.schoolId, action: 'resolve', operatorId: ctx.user.id, operatorType: 'staff', fromStatus, toStatus: 'resolved', note: String(ctx.body.resolution) });
    if (ticket.reporter_id) {
      notify(ticket.reporter_id, {
        schoolId: ctx.schoolId, type: 'ticket', title: '工单 #' + ticket.id + ' 已处理完成',
        content: '工单 ' + ticket.id + ' 处理结果：' + ctx.body.resolution,
        relatedType: 'ticket', relatedId: ticket.id,
      });
    }
    return { ticketId: ticket.id, status: 'resolved' };
  }, { moderator: true, message: '工单已处理完成' });

  route('POST', '/tickets/:id/escalate', (ctx) => {
    const ticket = table('tickets').find((t) => Number(t.id) === Number(ctx.params.id) && Number(t.school_id) === Number(ctx.schoolId));
    if (!ticket) throw new AppError(ERR.NOT_FOUND, '工单不存在');
    ticket.escalated = 1;
    ticket.escalated_at = nowIso();
    ticket.priority = 'urgent';
    ticket.updated_at = nowIso();
    ticketLog({ ticketId: ticket.id, schoolId: ctx.schoolId, action: 'escalate', operatorId: ctx.user.id, operatorType: 'staff', fromStatus: ticket.status, toStatus: ticket.status, note: ctx.body.note || '人工升级' });
    if (ticket.reporter_id) {
      notify(ticket.reporter_id, {
        schoolId: ctx.schoolId, type: 'ticket', title: '你的工单已加急',
        content: '工单 ' + ticket.id + ' 已升级为加急处理，我们会优先响应', relatedType: 'ticket', relatedId: ticket.id,
      });
    }
    return { ticketId: ticket.id, escalated: true };
  }, { moderator: true, message: '工单已升级' });

  // ---------------- 知识库 ----------------
  route('GET', '/kb/articles', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const schoolId = schoolIdOfUser(ctx.user);
    const keyword = ctx.query.keyword || '';
    const rows = table('kb_articles')
      .filter((a) => a.status === 'published' && (a.school_id === null || a.school_id === undefined || Number(a.school_id) === Number(schoolId)))
      .filter((a) => !keyword || [a.question, a.answer, a.keywords].filter(Boolean).some((v) => String(v).includes(keyword)))
      .sort((a, b) => Number(a.id) - Number(b.id));
    const list = rows.slice(offset, offset + pageSize).map((a) => ({
      id: a.id, category: a.category, question: a.question, answer: a.answer, keywords: a.keywords,
    }));
    return paged(list, rows.length, page, pageSize);
  }, { schoolScope: false });

  route('GET', '/kb/articles/:id', (ctx) => {
    const article = table('kb_articles').find((a) => Number(a.id) === Number(ctx.params.id));
    if (!article) throw new AppError(ERR.NOT_FOUND, '知识条目不存在');
    article.view_count = Number(article.view_count || 0) + 1;
    return article;
  }, { schoolScope: false });

  route('POST', '/kb/articles', (ctx) => {
    requireFields(ctx.body, ['question', 'answer']);
    const article = insert('kb_articles', {
      school_id: ctx.body.schoolId ? Number(ctx.body.schoolId) : null,
      category: ctx.body.category || '通用', question: String(ctx.body.question), answer: String(ctx.body.answer),
      keywords: ctx.body.keywords || null, status: 'published', view_count: 0,
      updated_by: Number(ctx.user.id), created_at: nowIso(), updated_at: nowIso(),
    });
    audit({ schoolId: ctx.body.schoolId || null, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'kb.create', targetType: 'kb_article', targetId: article.id });
    return { articleId: article.id };
  }, { roles: ['platform_admin'], schoolScope: false, message: '知识条目已创建' });

  route('PATCH', '/kb/articles/:id', (ctx) => {
    const article = table('kb_articles').find((a) => Number(a.id) === Number(ctx.params.id));
    if (!article) throw new AppError(ERR.NOT_FOUND, '知识条目不存在');
    for (const key of ['category', 'question', 'answer', 'keywords', 'status']) {
      if (ctx.body[key] !== undefined) article[key] = ctx.body[key];
    }
    article.updated_by = Number(ctx.user.id);
    article.updated_at = nowIso();
    audit({ schoolId: article.school_id, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'kb.update', targetType: 'kb_article', targetId: article.id });
    return { articleId: article.id };
  }, { roles: ['platform_admin'], schoolScope: false, message: '知识条目已更新' });

  route('DELETE', '/kb/articles/:id', (ctx) => {
    const article = table('kb_articles').find((a) => Number(a.id) === Number(ctx.params.id));
    if (!article) throw new AppError(ERR.NOT_FOUND, '知识条目不存在');
    article.status = 'offline';
    article.updated_at = nowIso();
    return { articleId: article.id, status: 'offline' };
  }, { roles: ['platform_admin'], schoolScope: false, message: '知识条目已下线' });

  // ---------------- AI 客服 ----------------
  route('POST', '/chat/sessions', (ctx) => {
    const session = insert('chat_sessions', {
      session_no: generateNo('CS'), school_id: Number(ctx.schoolId), user_id: Number(ctx.user.id),
      channel: 'ai', status: 'active', ticket_id: null, unresolved_rounds: 0,
      context: null, created_at: nowIso(), updated_at: nowIso(),
    });
    insert('chat_messages', {
      session_id: session.id, school_id: Number(ctx.schoolId), role: 'ai', confidence: null,
      content: '你好，我是平台智能客服小助手。我可以帮你查询订单状态、物流信息、信誉分，也可以协助发起退款申请或转人工客服。',
      intent: 'greeting', tool_calls: null, created_at: nowIso(),
    });
    return { sessionId: session.id, channel: 'ai' };
  }, { message: '会话已创建' });

  route('GET', '/chat/sessions/:id', (ctx) => {
    const session = table('chat_sessions').find((s) => Number(s.id) === Number(ctx.params.id)
      && Number(s.school_id) === Number(ctx.schoolId) && Number(s.user_id) === Number(ctx.user.id));
    if (!session) throw new AppError(ERR.NOT_FOUND, '会话不存在');
    const messages = table('chat_messages')
      .filter((m) => Number(m.session_id) === Number(session.id))
      .sort((a, b) => Number(a.id) - Number(b.id))
      .map((m) => ({ id: m.id, role: m.role, content: m.content, intent: m.intent, confidence: m.confidence, tool_calls: m.tool_calls, created_at: m.created_at }));
    return { session, messages };
  });

  route('POST', '/chat/sessions/:id/messages', (ctx) => {
    requireFields(ctx.body, ['content']);
    const session = table('chat_sessions').find((s) => Number(s.id) === Number(ctx.params.id)
      && Number(s.school_id) === Number(ctx.schoolId) && Number(s.user_id) === Number(ctx.user.id));
    if (!session) throw new AppError(ERR.NOT_FOUND, '会话不存在');
    if (session.status === 'closed') throw new AppError(ERR.ORDER_STATE_INVALID, '会话已结束，请开启新会话');

    const rules = configValue('ai.escalate_rules', ctx.schoolId);
    const threshold = Number(rules.confidenceThreshold ?? 0.55);
    const content = String(ctx.body.content);
    const detected = detectIntent(content, rules);
    let confidence = detected.confidence;
    let intent = detected.intent;
    const toolCalls = [];
    let reply = '';

    // 用户消息入库前先过违禁词（私信/客服对话同样覆盖）
    const decision = wordCheck({ schoolId: ctx.schoolId, text: content });
    insert('chat_messages', {
      session_id: session.id, school_id: Number(ctx.schoolId), role: 'user',
      content: decision.text, intent: null, confidence: null, tool_calls: null, created_at: nowIso(),
    });
    if (decision.blocked) {
      const message = buildBlockMessage(decision);
      insert('chat_messages', {
        session_id: session.id, school_id: Number(ctx.schoolId), role: 'system',
        content: message, intent: 'word_blocked', confidence: null, tool_calls: null, created_at: nowIso(),
      });
      return { sessionId: session.id, intent: 'word_blocked', confidence: 0.9, reply: message, toolCalls, transferred: false };
    }

    if (intent === 'transfer') {
      const result = transferToHuman({ schoolId: ctx.schoolId, userId: ctx.user.id, sessionId: session.id, reason: '用户主动要求转人工' });
      return { sessionId: session.id, intent, confidence, reply: '已为你转接人工客服，工作时间 9:00-21:00，请稍候。', ticketId: result.ticketId, transferred: true, toolCalls };
    }

    if (intent === 'order_query') {
      const result = toolOrderQuery(ctx.schoolId, ctx.user.id, content);
      toolCalls.push({ tool: 'order_query', ok: result.ok });
      reply = result.reply;
      confidence = result.ok ? 0.9 : 0.5;
      if (!result.ok) intent = 'other';
    } else if (intent === 'credit_query') {
      const result = toolCreditQuery(ctx.schoolId, ctx.user.id);
      toolCalls.push({ tool: 'credit_query', ok: true });
      reply = result.reply;
      confidence = 0.9;
    } else if (intent === 'refund_request') {
      // AI 无权直接退款：只能创建申请（工单）并转人工
      const result = toolCreateRefundRequest({ schoolId: ctx.schoolId, userId: ctx.user.id, content });
      toolCalls.push({ tool: 'create_refund_request', ok: true, ticketId: result.ticketId });
      reply = '已为你创建退款申请工单（编号 ' + result.ticketId + '），人工客服会在 4 小时内核实处理。请注意：AI 无法直接操作资金，退款需人工审核。';
      confidence = 0.85;
    } else {
      const article = matchKb(ctx.schoolId, content);
      toolCalls.push({ tool: 'faq_search', ok: Boolean(article) });
      if (article) {
        article.view_count = Number(article.view_count || 0) + 1;
        reply = article.answer + '\n\n如果还需要帮助，可以回复「转人工」。';
        confidence = 0.8;
        intent = 'faq';
      } else {
        reply = '抱歉，我暂时没有找到对应的答案。你可以换个说法，或回复「转人工」由人工客服协助。';
        confidence = 0.2;
      }
    }

    insert('chat_messages', {
      session_id: session.id, school_id: Number(ctx.schoolId), role: 'ai',
      content: reply, intent, confidence, tool_calls: JSON.stringify(toolCalls), created_at: nowIso(),
    });

    session.unresolved_rounds = confidence < threshold ? Number(session.unresolved_rounds || 0) + 1 : 0;
    session.context = JSON.stringify({ lastIntent: intent, lastConfidence: confidence });
    session.updated_at = nowIso();

    if (session.unresolved_rounds >= Number(rules.unresolvedRounds ?? 2)) {
      const result = transferToHuman({ schoolId: ctx.schoolId, userId: ctx.user.id, sessionId: session.id, reason: '连续 ' + session.unresolved_rounds + ' 轮未解决' });
      return { sessionId: session.id, intent, confidence, reply, toolCalls, transferred: true, ticketId: result.ticketId };
    }
    return { sessionId: session.id, intent, confidence, reply, toolCalls, transferred: false };
  });

  route('POST', '/chat/sessions/:id/transfer', (ctx) => {
    const result = transferToHuman({
      schoolId: ctx.schoolId, userId: ctx.user.id, sessionId: Number(ctx.params.id),
      reason: ctx.body?.reason || '用户主动要求转人工',
    });
    return result;
  }, { message: '已转人工客服' });
}

// 内部工具函数导出：管理后台复用同一套统计口径与处罚规则
export {
  reportStats, ticketStats, openTicket, sweepSlaTickets,
  effectiveViolationCounter, decideEscalationStep, revokePenalty, configOr,
};
