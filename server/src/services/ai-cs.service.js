// AI 客服：三层能力 = 知识库 FAQ + 订单/物流/信誉分查询 + 按意图触发动作（发起退款申请、创建工单）
// 权限边界（硬约束）：工具注册表里**没有**放款/退款/处罚工具，AI 只能查询与创建申请
import { AppError, ERR } from '../lib/errors.js';
import { configService } from './config.service.js';
import { ticketService } from './ticket.service.js';
import { notifyService } from './notify.service.js';
import { generateNo } from '../lib/crypto.js';
import { q, q1, run } from '../db/tx.js';
import { pool } from '../db/pool.js';

const ORDER_NO_RE = /\b(OD\d{12,})\b/i;

const STATUS_TEXT = {
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

// 意图关键词表（一期规则引擎；二期可替换为模型分类，工具集不变）
const INTENT_RULES = [
  { intent: 'transfer', keywords: ['转人工', '人工客服', '找客服', '真人'] },
  { intent: 'refund_request', keywords: ['退款', '退钱', '退货', '申请退'] },
  { intent: 'order_query', keywords: ['订单', '发货', '物流', '快递', '到哪', '收货', '单号'] },
  { intent: 'credit_query', keywords: ['信誉分', '信用分', '扣分', '禁言'] },
  { intent: 'faq', keywords: ['服务费', '手续费', '怎么', '为什么', '多久', '规则', '认证', '申诉', '解绑'] },
];

export const aiCsService = {
  // 工具注册表：只读工具 + 申请类工具（严禁注册资金处置类工具）
  TOOLS: {
    order_query: { type: 'read', description: '按订单号或最近订单查询订单状态' },
    logistics_query: { type: 'read', description: '查询订单物流信息' },
    credit_query: { type: 'read', description: '查询本人信誉分与档位权限' },
    faq_search: { type: 'read', description: '检索客服知识库' },
    create_refund_request: { type: 'apply', description: '创建退款申请工单（不直接退款）' },
    create_ticket: { type: 'apply', description: '创建客服工单' },
  },

  assertToolAllowed(tool) {
    const conf = this.TOOLS[tool];
    if (!conf) throw new AppError(ERR.FORBIDDEN, `AI 无权调用工具：${tool}`);
    return conf;
  },

  detectIntent(content, rules) {
    const text = String(content || '');
    for (const rule of INTENT_RULES) {
      const hit = rule.keywords.filter((k) => text.includes(k));
      if (hit.length > 0) {
        return { intent: rule.intent, confidence: Math.min(0.95, 0.5 + hit.length * 0.15), matched: hit };
      }
    }
    const fundHit = (rules.fundKeywords || []).filter((k) => text.includes(k));
    if (fundHit.length > 0) return { intent: 'refund_request', confidence: 0.6, matched: fundHit };
    return { intent: 'other', confidence: 0.3, matched: [] };
  },

  async startSession({ schoolId, userId, channel = 'ai' }) {
    const result = await run(
      pool,
      `INSERT INTO chat_sessions (session_no, school_id, user_id, channel, status) VALUES (?, ?, ?, ?, 'active')`,
      [generateNo('CS'), schoolId, userId, channel],
    );
    await run(
      pool,
      `INSERT INTO chat_messages (session_id, school_id, role, content, intent)
       VALUES (?, ?, 'ai', ?, 'greeting')`,
      [result.insertId, schoolId,
        '你好，我是平台智能客服小助手。我可以帮你查询订单状态、物流信息、信誉分，也可以协助发起退款申请或转人工客服。'],
    );
    return { sessionId: result.insertId, channel };
  },

  async handleUserMessage({ schoolId, userId, sessionId, content }) {
    const session = await q1(pool, 'SELECT * FROM chat_sessions WHERE id = ? AND school_id = ? AND user_id = ?', [sessionId, schoolId, userId]);
    if (!session) throw new AppError(ERR.NOT_FOUND, '会话不存在');
    if (session.status === 'closed') throw new AppError(ERR.ORDER_STATE_INVALID, '会话已结束，请开启新会话');

    const rules = await configService.get('ai.escalate_rules', schoolId);
    const threshold = Number(rules.confidenceThreshold ?? 0.55);

    await run(
      pool,
      `INSERT INTO chat_messages (session_id, school_id, role, content) VALUES (?, ?, 'user', ?)`,
      [sessionId, schoolId, content],
    );

    const detected = this.detectIntent(content, rules);
    let reply = '';
    let intent = detected.intent;
    let confidence = detected.confidence;
    const toolCalls = [];

    if (intent === 'transfer') {
      const result = await this.transferToHuman({ schoolId, userId, sessionId, reason: '用户主动要求转人工' });
      return { sessionId, intent, confidence, reply: '已为你转接人工客服，工作时间 9:00-21:00，请稍候。', ticketId: result.ticketId, transferred: true, toolCalls };
    }

    if (intent === 'order_query') {
      const result = await this.toolOrderQuery({ schoolId, userId, content });
      toolCalls.push({ tool: 'order_query', ok: result.ok });
      reply = result.reply;
      confidence = result.ok ? 0.9 : 0.5;
      if (!result.ok) intent = 'other';
    } else if (intent === 'credit_query') {
      const result = await this.toolCreditQuery({ schoolId, userId });
      toolCalls.push({ tool: 'credit_query', ok: true });
      reply = result.reply;
      confidence = 0.9;
    } else if (intent === 'refund_request') {
      // AI 无权直接退款：只能创建申请（工单）并转人工
      this.assertToolAllowed('create_refund_request');
      const result = await this.toolCreateRefundRequest({ schoolId, userId, content });
      toolCalls.push({ tool: 'create_refund_request', ok: true, ticketId: result.ticketId });
      reply = `已为你创建退款申请工单（编号 ${result.ticketId}），人工客服会在 4 小时内核实处理。请注意：AI 无法直接操作资金，退款需人工审核。`;
      confidence = 0.85;
    } else {
      const faq = await this.toolFaqSearch({ schoolId, content });
      toolCalls.push({ tool: 'faq_search', ok: faq.ok });
      if (faq.ok) {
        reply = `${faq.answer}\n\n如果还需要帮助，可以回复「转人工」。`;
        confidence = faq.confidence;
        intent = 'faq';
      } else {
        reply = '抱歉，我暂时没有找到对应的答案。你可以换个说法，或回复「转人工」由人工客服协助。';
        confidence = 0.2;
      }
    }

    await run(
      pool,
      `INSERT INTO chat_messages (session_id, school_id, role, content, intent, confidence, tool_calls)
       VALUES (?, ?, 'ai', ?, ?, ?, CAST(? AS JSON))`,
      [sessionId, schoolId, reply, intent, confidence, JSON.stringify(toolCalls)],
    );

    // 转人工条件：置信度低于阈值 / 连续 2 轮未解决 / 涉及资金争议关键词
    const unresolved = confidence < threshold ? Number(session.unresolved_rounds) + 1 : 0;
    await run(
      pool,
      `UPDATE chat_sessions SET unresolved_rounds = ?, context = CAST(? AS JSON), updated_at = NOW(3) WHERE id = ?`,
      [unresolved, JSON.stringify({ lastIntent: intent, lastConfidence: confidence }), sessionId],
    );

    if (unresolved >= Number(rules.unresolvedRounds ?? 2)) {
      const result = await this.transferToHuman({ schoolId, userId, sessionId, reason: `连续 ${unresolved} 轮未解决` });
      return { sessionId, intent, confidence, reply, toolCalls, transferred: true, ticketId: result.ticketId };
    }

    return { sessionId, intent, confidence, reply, toolCalls, transferred: false };
  },

  // ---------------- 工具实现 ----------------
  async toolOrderQuery({ schoolId, userId, content }) {
    const match = ORDER_NO_RE.exec(String(content || ''));
    let order = null;
    if (match) {
      order = await q1(
        pool,
        'SELECT * FROM orders WHERE order_no = ? AND school_id = ? AND (buyer_id = ? OR seller_id = ?)',
        [match[1], schoolId, userId, userId],
      );
    } else {
      order = await q1(
        pool,
        'SELECT * FROM orders WHERE school_id = ? AND (buyer_id = ? OR seller_id = ?) ORDER BY id DESC LIMIT 1',
        [schoolId, userId, userId],
      );
    }
    if (!order) {
      return { ok: false, reply: '没有查询到相关订单，请确认订单号是否正确，或到「我的订单」查看。' };
    }
    const role = Number(order.buyer_id) === Number(userId) ? '买家' : '卖家';
    const parts = [
      `订单 ${order.order_no}（你是${role}）当前状态：${STATUS_TEXT[order.status] || order.status}。`,
      `金额 ${(Number(order.amount_cents) / 100).toFixed(2)} 元，平台服务费 ${(Number(order.service_fee_cents) / 100).toFixed(2)} 元。`,
    ];
    if (order.escrow_status === 'held') parts.push('资金目前在平台托管中，确认收货后才会放款给卖家。');
    if (order.status === 'shipped' && order.auto_confirm_at) parts.push(`预计自动确认收货时间：${new Date(order.auto_confirm_at).toLocaleString('zh-CN')}。`);
    if (order.express_no) parts.push(`物流：${order.express_company || ''} ${order.express_no}。`);
    return { ok: true, reply: parts.join(''), order };
  },

  async toolCreditQuery({ schoolId, userId }) {
    const user = await q1(pool, 'SELECT credit_score, mute_until, trade_ban_until FROM users WHERE id = ? AND school_id = ?', [userId, schoolId]);
    if (!user) return { ok: false, reply: '未找到你的账号信息。' };
    const parts = [`你当前信誉分 ${user.credit_score} 分。`];
    if (user.mute_until) parts.push(`禁言至 ${new Date(user.mute_until).toLocaleString('zh-CN')}。`);
    if (user.trade_ban_until) parts.push(`限制交易至 ${new Date(user.trade_ban_until).toLocaleString('zh-CN')}。`);
    parts.push('信誉分低于 50 分将限制挂书数量与提现时效，低于 30 分仅可浏览。');
    return { ok: true, reply: parts.join('') };
  },

  async toolFaqSearch({ schoolId, content }) {
    const text = String(content || '').trim();
    const keywords = ['服务费', '托管', '自动确认', '退款', '认证', '解绑', '申诉', '违规', '发布'];
    const hit = keywords.find((k) => text.includes(k)) || null;
    const rows = await q(
      pool,
      `SELECT id, category, question, answer, keywords FROM kb_articles
       WHERE status = 'published' AND (school_id IS NULL OR school_id = ?)
         AND (question LIKE ? OR keywords LIKE ? OR answer LIKE ?)
       ORDER BY (question LIKE ?) DESC, view_count DESC LIMIT 1`,
      [schoolId, `%${hit || text}%`, `%${hit || text}%`, `%${hit || text}%`, `%${hit || text}%`],
    );
    if (rows.length === 0) return { ok: false };
    await run(pool, 'UPDATE kb_articles SET view_count = view_count + 1 WHERE id = ?', [rows[0].id]);
    return { ok: true, answer: rows[0].answer, question: rows[0].question, confidence: hit ? 0.8 : 0.6 };
  },

  // AI 只能"发起申请"，真正的退款由人工或卖家执行
  async toolCreateRefundRequest({ schoolId, userId, content }) {
    const order = await q1(
      pool,
      `SELECT * FROM orders WHERE school_id = ? AND buyer_id = ? AND status IN ('paid','shipped','refund_requested')
       ORDER BY id DESC LIMIT 1`,
      [schoolId, userId],
    );
    const result = await ticketService.create({
      schoolId, source: 'ai', type: 'refund', priority: 'urgent',
      subject: `AI 客服转退款申请：${order ? order.order_no : '未关联订单'}`,
      description: `用户诉求：${String(content).slice(0, 500)}`,
      relatedOrderId: order?.id ?? null, relatedUserId: userId, reporterId: userId,
    });
    return { ticketId: result.ticketId, orderId: order?.id ?? null };
  },

  async transferToHuman({ schoolId, userId, sessionId, reason }) {
    const session = await q1(pool, 'SELECT * FROM chat_sessions WHERE id = ? AND school_id = ?', [sessionId, schoolId]);
    if (!session) throw new AppError(ERR.NOT_FOUND, '会话不存在');

    let ticketId = session.ticket_id;
    if (!ticketId) {
      const created = await ticketService.create({
        schoolId, source: 'ai', type: 'other', priority: 'normal',
        subject: 'AI 客服转人工', description: `转人工原因：${reason}`,
        reporterId: userId, relatedUserId: userId,
      });
      ticketId = created.ticketId;
    }
    await run(
      pool,
      `UPDATE chat_sessions SET channel = 'human', status = 'transferred', ticket_id = ? WHERE id = ? AND school_id = ?`,
      [ticketId, sessionId, schoolId],
    );
    await run(
      pool,
      `INSERT INTO chat_messages (session_id, school_id, role, content, intent, tool_calls)
       VALUES (?, ?, 'system', ?, 'transfer', CAST(? AS JSON))`,
      [sessionId, schoolId, `已转人工：${reason}`, JSON.stringify([{ tool: 'create_ticket', ticketId }])],
    );
    await notifyService.notify(userId, {
      schoolId, type: 'ticket', title: '已为你转接人工客服',
      content: `人工客服工作时间 9:00-21:00，你的问题已生成工单 ${ticketId}`,
      relatedType: 'ticket', relatedId: ticketId,
    });
    return { ticketId, transferred: true };
  },

  async sessionMessages({ schoolId, userId, sessionId }) {
    const session = await q1(pool, 'SELECT * FROM chat_sessions WHERE id = ? AND school_id = ? AND user_id = ?', [sessionId, schoolId, userId]);
    if (!session) throw new AppError(ERR.NOT_FOUND, '会话不存在');
    const messages = await q(pool, 'SELECT id, role, content, intent, confidence, tool_calls, created_at FROM chat_messages WHERE session_id = ? ORDER BY id ASC', [sessionId]);
    return { session, messages };
  },
};
