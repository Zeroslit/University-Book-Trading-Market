// 演示版管理后台处理器：数据看板 / 学校开通配置 / 用户与风控 / 内容审核 / 订单仲裁 / 规则阈值 / 审计日志
// 全部按 school_id 过滤；平台级主数据（学校、阈值、审计）允许平台管理员以 platformScope 访问（与后端 school-scope 一致）
import { table, insert, nowIso, isoAfter, configValue, setConfigValue, db } from '../store.js';
import { AppError, ERR } from '../vendor.js';
import { applyPenalty, notify, audit, creditPermissions } from '../rules.js';
import {
  reportStats, ticketStats, effectiveViolationCounter, configOr,
} from './risk.js';
import { paged, pageOf, requireFields } from './util.js';

const DAY = 86400000;
const PLATFORM_ROLES = ['platform_admin'];
const BAN_FIELDS = { mute: 'mute_until', trade_ban: 'trade_ban_until', login_ban: 'login_ban_until' };

// 规则阈值说明（仅用于后台展示；阈值本身一律来自 configs，不在此写死）
const CONFIG_DESCRIPTIONS = {
  'credit.tiers': '信誉分档位（优秀 / 良好 / 受限 / 高风险 / 禁止交易）',
  'credit.tier_permissions': '各档位权限：是否可发布、是否可交易、挂书上限、提现延迟',
  'credit.rules': '信誉分加减分规则（按时发货、好评、逾期、描述不符等）',
  'credit.bounds': '信誉分上下限',
  'credit.light_violation_expire_months': '轻度违规滚动过期月数',
  'credit.clean_months_clear_count': '连续无违规可消除 1 次的月数',
  'penalty.escalation': '处罚梯度（按累计成立次数）与严重违规一票封禁开关',
  'banned_word.penalty': '违禁词分级处置（L1 提示 / L2 拦截 / L3 拦截扣分 / L4 删除转人工）',
  'banned_word.escalation': '违禁词累计命中触发的禁言与禁发帖',
  'banned_word.normalize': '违禁词检测归一化选项（全角、繁简、拼音谐音、去符号）',
  'order.state_machine': '订单状态机（状态流转与终态）',
  'order.auto_confirm_days': '发货后自动确认收货天数',
  'order.ship_deadline_days': '卖家发货时限（天）',
  'order.service_fee_bps': '平台服务费比例（基点，200 = 2%）',
  'order.report_proof_hours': '被投诉人举证时限（小时）',
  'report.appeal_days': '处罚申诉期（天）',
  'ticket.sla': '工单 SLA（普通 / 资金类响应与处理时限）',
  'ticket.auto_escalate': 'SLA 超时是否自动升级',
  'ai.escalate_rules': 'AI 客服转人工规则（关键词、资金关键词、未解决轮数、置信度阈值）',
  'content.categories': '可发布品类',
};

function metaOf(key) {
  const meta = db().configMeta || {};
  return meta[key] || {};
}

function rememberConfig(key, description) {
  if (!db().configMeta) db().configMeta = {};
  db().configMeta[key] = {
    description: description || db().configMeta[key]?.description || CONFIG_DESCRIPTIONS[key] || '',
    updatedAt: nowIso(),
    version: Number(db().configMeta[key]?.version || 0) + 1,
  };
}

function configList(schoolId) {
  const rows = [];
  for (const [key, value] of Object.entries(db().configs)) {
    rows.push({
      key, scope: 'platform', schoolId: null, value,
      description: metaOf(key).description || CONFIG_DESCRIPTIONS[key] || '',
      version: Number(metaOf(key).version || 1),
      updatedAt: metaOf(key).updatedAt || null,
    });
  }
  for (const [sid, bundle] of Object.entries(db().schoolConfigs || {})) {
    if (schoolId && Number(sid) !== Number(schoolId)) continue;
    for (const [key, value] of Object.entries(bundle)) {
      rows.push({
        key, scope: 'school', schoolId: Number(sid), value,
        description: metaOf('school:' + sid + ':' + key).description || '学校级覆盖：' + (CONFIG_DESCRIPTIONS[key] || ''),
        version: Number(metaOf('school:' + sid + ':' + key).version || 1),
        updatedAt: metaOf('school:' + sid + ':' + key).updatedAt || null,
      });
    }
  }
  return rows.sort((a, b) => (a.key === b.key ? String(a.schoolId || '').localeCompare(String(b.schoolId || '')) : a.key.localeCompare(b.key)));
}

export function registerAdminRoutes(route) {
  // ---------------- 数据看板 ----------------
  route('GET', '/admin/dashboard', (ctx) => {
    const schoolId = ctx.schoolId;
    const orders = table('orders').filter((o) => Number(o.school_id) === Number(schoolId));
    const grouped = new Map();
    for (const o of orders) {
      if (!grouped.has(o.status)) grouped.set(o.status, { status: o.status, total: 0, amount: 0 });
      const g = grouped.get(o.status);
      g.total += 1;
      g.amount += Number(o.amount_cents);
    }
    const users = table('users').filter((u) => Number(u.school_id) === Number(schoolId) && !u.deleted_at);
    const userGrouped = new Map();
    for (const u of users) {
      const key = u.verification_status || 'unverified';
      if (!userGrouped.has(key)) userGrouped.set(key, { verification_status: key, total: 0 });
      userGrouped.get(key).total += 1;
    }
    const onSaleBooks = table('books').filter((b) => Number(b.school_id) === Number(schoolId) && b.status === 'on_sale' && !b.deleted_at).length;
    const publishedThreads = table('threads').filter((t) => Number(t.school_id) === Number(schoolId) && t.status === 'published' && !t.deleted_at).length;
    const escrowFrozenCents = table('wallet_transactions')
      .filter((t) => Number(t.school_id) === Number(schoolId) && t.status === 'success' && t.account === 'frozen')
      .reduce((sum, t) => sum + (t.direction === 'in' ? Number(t.amount_cents) : -Number(t.amount_cents)), 0);
    const gmvCents = orders.filter((o) => ['completed', 'arbitrated_release'].includes(o.status))
      .reduce((sum, o) => sum + Number(o.amount_cents), 0);
    const platformFeeCents = table('wallet_transactions')
      .filter((t) => Number(t.school_id) === Number(schoolId) && t.biz_type === 'fee' && t.status === 'success')
      .reduce((sum, t) => sum + Number(t.amount_cents), 0);
    return {
      schoolId, orders: [...grouped.values()], users: [...userGrouped.values()],
      onSaleBooks, publishedThreads, escrowFrozenCents, gmvCents, platformFeeCents,
      reports: reportStats(schoolId), tickets: ticketStats(schoolId),
    };
  }, { moderator: true });

  // ---------------- 学校开通与配置 ----------------
  route('GET', '/admin/schools', () => table('schools')
    .slice()
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((s) => ({
      id: s.id, name: s.name, province: s.province, city: s.city, code: s.code, status: s.status,
      service_fee_bps: Number(s.service_fee_bps), require_student_verification: Number(s.require_student_verification),
      cross_school_enabled: Number(s.cross_school_enabled), cross_school_mode: s.cross_school_mode,
      forum_sections: s.forum_sections, allowed_categories: s.allowed_categories, created_at: s.created_at,
    })), { roles: PLATFORM_ROLES });

  route('POST', '/admin/schools', (ctx) => {
    requireFields(ctx.body, ['name', 'province', 'city', 'code']);
    const code = String(ctx.body.code);
    if (table('schools').some((s) => s.code === code)) throw new AppError(ERR.CONFLICT, '学校编码已存在');
    const sections = ctx.body.forumSections || [{ key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' }];
    const school = insert('schools', {
      name: String(ctx.body.name), province: String(ctx.body.province), city: String(ctx.body.city), code,
      status: 'active', forum_sections: sections,
      service_fee_bps: Number(ctx.body.serviceFeeBps ?? configValue('order.service_fee_bps', null)),
      allowed_categories: configOr('content.categories', null, ['教材']),
      require_student_verification: ctx.body.requireStudentVerification === false ? 0 : 1,
      cross_school_enabled: ctx.body.crossSchoolEnabled ? 1 : 0,
      cross_school_mode: ctx.body.crossSchoolMode || 'off',
      created_at: nowIso(), updated_at: nowIso(),
    });
    audit({ actorId: ctx.user.id, actorRole: ctx.user.role, action: 'school.create', targetType: 'school', targetId: school.id, detail: ctx.body });
    return { schoolId: school.id };
  }, { roles: PLATFORM_ROLES, schoolScope: false, message: '学校已开通并生成论坛版块' });

  route('PATCH', '/admin/schools/:id', (ctx) => {
    const school = table('schools').find((s) => Number(s.id) === Number(ctx.params.id));
    if (!school) throw new AppError(ERR.NOT_FOUND, '学校不存在');
    const map = {
      status: 'status', serviceFeeBps: 'service_fee_bps', requireStudentVerification: 'require_student_verification',
      crossSchoolEnabled: 'cross_school_enabled', crossSchoolMode: 'cross_school_mode',
    };
    let changed = false;
    for (const [key, column] of Object.entries(map)) {
      if (ctx.body[key] === undefined) continue;
      const value = typeof ctx.body[key] === 'boolean' ? (ctx.body[key] ? 1 : 0) : ctx.body[key];
      school[column] = value;
      changed = true;
    }
    for (const [key, column] of [['allowedCategories', 'allowed_categories'], ['forumSections', 'forum_sections']]) {
      if (ctx.body[key] === undefined) continue;
      school[column] = ctx.body[key];
      changed = true;
    }
    if (!changed) throw new AppError(ERR.VALIDATION_ERROR, '没有需要更新的字段');
    school.updated_at = nowIso();
    audit({ schoolId: school.id, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'school.update', targetType: 'school', targetId: school.id, detail: ctx.body });
    return { schoolId: school.id, updated: true };
  }, { roles: PLATFORM_ROLES, schoolScope: false, message: '学校配置已更新' });

  // ---------------- 用户管理 ----------------
  route('GET', '/admin/users', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const keyword = ctx.query.keyword || '';
    const now = Date.now();
    const rows = table('users')
      .filter((u) => Number(u.school_id) === Number(ctx.schoolId) && !u.deleted_at)
      .filter((u) => !keyword || (u.nickname || '').includes(keyword) || (u.student_no_mask || '').includes(keyword) || u.student_no === keyword)
      .filter((u) => !ctx.query.verificationStatus || u.verification_status === ctx.query.verificationStatus)
      .filter((u) => ctx.query.banned !== 'true' || (Number(u.banned_permanently) === 1
        || (u.login_ban_until && new Date(u.login_ban_until).getTime() > now)
        || (u.trade_ban_until && new Date(u.trade_ban_until).getTime() > now)
        || (u.mute_until && new Date(u.mute_until).getTime() > now)))
      .sort((a, b) => Number(b.id) - Number(a.id));
    const list = rows.slice(offset, offset + pageSize).map((u) => ({
      id: u.id, nickname: u.nickname, student_no_mask: u.student_no_mask, phone_last4: u.phone_last4,
      role: u.role, status: u.status, verification_status: u.verification_status,
      credit_score: u.credit_score, mute_until: u.mute_until, trade_ban_until: u.trade_ban_until,
      login_ban_until: u.login_ban_until, banned_permanently: u.banned_permanently, created_at: u.created_at,
    }));
    return paged(list, rows.length, page, pageSize);
  }, { moderator: true });

  // 一键处罚：梯度与封禁字段全部由 configs 驱动
  route('POST', '/admin/users/:id/ban', (ctx) => {
    const { type, days, reason } = ctx.body;
    requireFields(ctx.body, ['type', 'reason']);
    if (!['warning', 'mute', 'trade_ban', 'login_ban', 'permanent_ban'].includes(type)) {
      throw new AppError(ERR.VALIDATION_ERROR, '不支持的处罚类型');
    }
    const user = table('users').find((u) => Number(u.id) === Number(ctx.params.id) && Number(u.school_id) === Number(ctx.schoolId));
    if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在或不属于本校');
    if (type === 'permanent_ban' && !PLATFORM_ROLES.includes(ctx.user.role)) {
      throw new AppError(ERR.FORBIDDEN, '永久封禁只能由平台管理员执行');
    }
    const counter = effectiveViolationCounter(ctx.schoolId, user.id);
    const record = applyPenalty({
      schoolId: ctx.schoolId, userId: user.id, type, days: days ?? 0,
      severity: type === 'permanent_ban' ? 'severe' : 'light', source: 'admin',
      reason: String(reason), operatorId: ctx.user.id,
      effectiveCount: counter.effectiveCount + 1, permanent: type === 'permanent_ban',
    });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.ban', targetType: 'user', targetId: user.id, detail: ctx.body });
    return { penaltyId: record.id, step: { type: record.type, days: days ?? 0, label: '人工处罚' }, effectiveCount: record.effective_count, endAt: record.end_at, creditDelta: 0, counter };
  }, { moderator: true, message: '处罚已执行' });

  route('POST', '/admin/users/:id/unban', (ctx) => {
    const type = ctx.body.type;
    if (!['mute', 'trade_ban', 'login_ban', 'permanent_ban', 'all'].includes(type)) {
      throw new AppError(ERR.VALIDATION_ERROR, '不支持的解禁类型');
    }
    const user = table('users').find((u) => Number(u.id) === Number(ctx.params.id) && Number(u.school_id) === Number(ctx.schoolId));
    if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在或不属于本校');
    if (type === 'permanent_ban' && !PLATFORM_ROLES.includes(ctx.user.role)) {
      throw new AppError(ERR.FORBIDDEN, '仅平台管理员可解除永久封禁');
    }
    const targets = type === 'all' ? ['mute', 'trade_ban', 'login_ban', 'permanent_ban'] : [type];
    for (const t of targets) {
      if (t === 'permanent_ban') user.banned_permanently = 0;
      else {
        const field = BAN_FIELDS[t];
        if (field) user[field] = null;
      }
    }
    user.status = 'active';
    user.updated_at = nowIso();
    for (const p of table('penalties')) {
      if (Number(p.user_id) !== Number(user.id) || p.status !== 'active') continue;
      if (type === 'all' || p.type === type) p.status = 'revoked';
    }
    notify(user.id, {
      schoolId: ctx.schoolId, type: 'ban', title: '账号限制已解除',
      content: ctx.body.reason || '你的账号限制已被解除，请遵守平台规则',
    });
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.unban', targetType: 'user', targetId: user.id, detail: ctx.body });
    return { userId: user.id, unbanType: type };
  }, { moderator: true, message: '已解除限制' });

  // 风控一屏
  route('GET', '/admin/users/:id/risk', (ctx) => {
    const userId = Number(ctx.params.id);
    const user = table('users').find((u) => Number(u.id) === userId && Number(u.school_id) === Number(ctx.schoolId));
    if (!user) throw new AppError(ERR.USER_NOT_FOUND, '用户不存在或不属于本校');
    const permissions = creditPermissions(ctx.schoolId, userId);
    const penalties = table('penalties')
      .filter((p) => Number(p.user_id) === userId)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 20)
      .map((p) => ({
        id: p.id, type: p.type, severity: p.severity, effective_count: p.effective_count,
        reason: p.reason, start_at: p.start_at, end_at: p.end_at, status: p.status,
        appeal_status: p.appeal_status, source: p.source,
      }));
    const credits = table('credit_logs')
      .filter((c) => Number(c.user_id) === userId)
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 20)
      .map((c) => ({ delta: c.delta, score_after: c.score_after, rule_key: c.rule_key, reason: c.reason, created_at: c.created_at }));
    const orders = table('orders')
      .filter((o) => Number(o.school_id) === Number(ctx.schoolId)
        && (Number(o.buyer_id) === userId || Number(o.seller_id) === userId))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 10)
      .map((o) => ({ id: o.id, order_no: o.order_no, status: o.status, amount_cents: o.amount_cents, buyer_id: o.buyer_id, seller_id: o.seller_id, created_at: o.created_at }));
    const tickets = table('tickets')
      .filter((t) => Number(t.school_id) === Number(ctx.schoolId)
        && (Number(t.reporter_id) === userId || Number(t.related_user_id) === userId))
      .sort((a, b) => Number(b.id) - Number(a.id))
      .slice(0, 10)
      .map((t) => ({ id: t.id, ticket_no: t.ticket_no, type: t.type, status: t.status, subject: t.subject, created_at: t.created_at }));
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'user.risk_view', targetType: 'user', targetId: userId });
    const userView = {
      id: user.id, nickname: user.nickname, student_no_mask: user.student_no_mask, phone_last4: user.phone_last4,
      role: user.role, status: user.status, verification_status: user.verification_status,
      credit_score: user.credit_score, mute_until: user.mute_until, trade_ban_until: user.trade_ban_until,
      login_ban_until: user.login_ban_until, banned_permanently: user.banned_permanently, created_at: user.created_at,
    };
    return {
      user: userView, permissions, violationCounter: effectiveViolationCounter(ctx.schoolId, userId),
      penalties, credits, orders, tickets,
    };
  }, { moderator: true });

  // ---------------- 内容审核队列 ----------------
  route('GET', '/admin/contents', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const type = ctx.query.type || 'book';
    const schoolId = ctx.schoolId;
    let rows;
    if (type === 'thread') {
      rows = table('threads').filter((t) => Number(t.school_id) === Number(schoolId) && !t.deleted_at)
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((t) => ({
          id: t.id, title: t.title, content: t.content, status: t.status, created_at: t.created_at,
          author_id: t.author_id, word_hit_level: t.word_hit_level,
          author_nickname: table('users').find((u) => Number(u.id) === Number(t.author_id))?.nickname || null,
        }));
    } else if (type === 'reply') {
      rows = table('replies').filter((r) => Number(r.school_id) === Number(schoolId) && !r.deleted_at)
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((r) => ({
          id: r.id, title: r.content, content: r.content, status: r.status, created_at: r.created_at,
          author_id: r.author_id, word_hit_level: null,
          author_nickname: table('users').find((u) => Number(u.id) === Number(r.author_id))?.nickname || null,
        }));
    } else {
      rows = table('books').filter((b) => Number(b.school_id) === Number(schoolId) && !b.deleted_at)
        .sort((a, b) => Number(b.id) - Number(a.id))
        .map((b) => ({
          id: b.id, title: b.title, content: b.remark, status: b.status, created_at: b.created_at,
          author_id: b.seller_id, banned_reason: b.banned_reason, word_hit_level: null,
          author_nickname: table('users').find((u) => Number(u.id) === Number(b.seller_id))?.nickname || null,
        }));
    }
    const hits = table('word_hits').filter((h) => Number(h.school_id) === Number(schoolId) && h.target_id !== null);
    const hitMap = new Map();
    for (const h of hits) {
      const key = h.target_type + ':' + h.target_id;
      if (!hitMap.has(key) || Number(hitMap.get(key).level.slice(1)) < Number(String(h.level).slice(1))) hitMap.set(key, h);
    }
    const list = rows.slice(offset, offset + pageSize).map((row) => {
      const hit = hitMap.get(type + ':' + row.id) || null;
      return {
        ...row,
        wordHit: hit ? { level: hit.level, word: hit.word, total: 1 } : null,
      };
    });
    return paged(list, rows.length, page, pageSize);
  }, { moderator: true });

  route('POST', '/admin/contents/:type/:id/review', (ctx) => {
    const { type, id } = ctx.params;
    const action = ctx.body.action;
    if (!['approve', 'hide', 'delete'].includes(action)) throw new AppError(ERR.VALIDATION_ERROR, '不支持的审核动作');
    const tableName = { book: 'books', thread: 'threads', reply: 'replies' }[type];
    if (!tableName) throw new AppError(ERR.VALIDATION_ERROR, '不支持的内容类型');
    const statusMap = { approve: type === 'book' ? 'on_sale' : 'published', hide: type === 'book' ? 'off_shelf' : 'hidden', delete: 'deleted' };
    const row = table(tableName).find((r) => Number(r.id) === Number(id) && Number(r.school_id) === Number(ctx.schoolId));
    if (!row) throw new AppError(ERR.NOT_FOUND, '内容不存在或不属于本校');
    row.status = statusMap[action];
    row.updated_at = nowIso();
    if (action === 'delete') row.deleted_at = nowIso();
    if (type === 'book') row.banned_reason = ctx.body.reason || null;
    const authorId = type === 'book' ? row.seller_id : row.author_id;
    if (authorId && action !== 'approve') {
      notify(authorId, {
        schoolId: ctx.schoolId, type: 'content', title: '内容审核结果通知',
        content: '你发布的内容（' + type + '#' + id + '）被' + (action === 'delete' ? '删除' : '下架')
          + '。原因：' + (ctx.body.reason || '违反平台规则'),
        relatedType: type, relatedId: Number(id),
      });
    }
    audit({ schoolId: ctx.schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'content.review', targetType: type, targetId: Number(id), detail: { action, reason: ctx.body.reason } });
    return { type, id: Number(id), action, status: statusMap[action] };
  }, { moderator: true, message: '审核完成' });

  // ---------------- 订单仲裁 ----------------
  route('GET', '/admin/orders', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const rows = table('orders')
      .filter((o) => Number(o.school_id) === Number(ctx.schoolId))
      .filter((o) => !ctx.query.status || o.status === ctx.query.status)
      .filter((o) => !ctx.query.orderNo || o.order_no === ctx.query.orderNo)
      .sort((a, b) => {
        if ((a.status === 'disputed') !== (b.status === 'disputed')) return a.status === 'disputed' ? -1 : 1;
        return Number(b.id) - Number(a.id);
      });
    const nameOf = (uid) => table('users').find((u) => Number(u.id) === Number(uid))?.nickname || null;
    const titleOf = (bid) => table('books').find((b) => Number(b.id) === Number(bid))?.title || null;
    const list = rows.slice(offset, offset + pageSize).map((o) => ({
      id: o.id, order_no: o.order_no, book_id: o.book_id, amount_cents: o.amount_cents,
      service_fee_cents: o.service_fee_cents, status: o.status, escrow_status: o.escrow_status,
      ship_mode: o.ship_mode, dispute_reason: o.dispute_reason, dispute_at: o.dispute_at,
      arbitration_result: o.arbitration_result, created_at: o.created_at, auto_confirm_at: o.auto_confirm_at,
      book_title: titleOf(o.book_id), buyer_nickname: nameOf(o.buyer_id), seller_nickname: nameOf(o.seller_id),
    }));
    return paged(list, rows.length, page, pageSize);
  }, { moderator: true });

  // ---------------- 规则阈值配置 ----------------
  route('GET', '/admin/configs', (ctx) => configList(ctx.schoolId), { moderator: true });

  route('PUT', '/admin/configs/:key', (ctx) => {
    if (ctx.body.value === undefined) throw new AppError(ERR.VALIDATION_ERROR, '缺少参数 value');
    const scope = ctx.body.scope || 'platform';
    const schoolId = ctx.body.schoolId ? Number(ctx.body.schoolId) : null;
    const result = setConfigValue(ctx.params.key, ctx.body.value, {
      scope, schoolId, description: ctx.body.description || null,
    });
    rememberConfig(scope === 'school' ? 'school:' + schoolId + ':' + ctx.params.key : ctx.params.key, ctx.body.description);
    audit({
      schoolId, actorId: ctx.user.id, actorRole: ctx.user.role, action: 'config.update',
      targetType: 'config', targetId: null, detail: { key: ctx.params.key, scope, value: ctx.body.value },
    });
    return { ...result, version: metaOf(scope === 'school' ? 'school:' + schoolId + ':' + ctx.params.key : ctx.params.key).version };
  }, { roles: PLATFORM_ROLES, schoolScope: false, message: '规则阈值已更新' });

  // ---------------- 审计日志（平台级） ----------------
  route('GET', '/admin/audit-logs', (ctx) => {
    const { page, pageSize, offset } = pageOf(ctx.query);
    const rows = table('audit_logs')
      .filter((l) => !ctx.query.action || l.action === ctx.query.action)
      .sort((a, b) => Number(b.id) - Number(a.id));
    return paged(rows.slice(offset, offset + pageSize), rows.length, page, pageSize);
  }, { roles: PLATFORM_ROLES, schoolScope: false });
}
