// 演示版违禁词服务：与后端 word.service 同源逻辑（归一化 -> AC/正则匹配 -> 白名单 -> 分级处置）
import { configValue, table, insert, filter, nowIso, isoAfter } from './store.js';
import {
  normalizeWithMap, toOriginalRange, buildMatcher, findHits, maskSegments, AppError, ERR,
} from './vendor.js';
import { applyCreditRule, applyPenalty, notify } from './rules.js';

const LEVEL_WEIGHT = { L1: 1, L2: 2, L3: 3, L4: 4 };

function entriesFor(schoolId) {
  const rows = table('banned_words').filter((w) => w.scope === 'global' || Number(w.school_id) === Number(schoolId));
  const active = rows.filter((w) => w.status === 'active');
  const whitelist = rows.filter((w) => w.status === 'whitelist');
  return {
    matcher: buildMatcher(active.map((w) => ({ ...w, matchType: w.match_type }))),
    whitelist,
  };
}

// 白名单：命中片段落在白名单词内部则忽略（避免教材名/正常用词误伤）
export function applyWhitelist(hits, normalizedText, whitelist) {
  if (!whitelist || whitelist.length === 0) return hits;
  const exact = new Set(whitelist.map((w) => w.normalized || w.word));
  const ranges = [];
  for (const w of whitelist) {
    const key = w.normalized || w.word;
    if (!key || key.length < 2) continue;
    let idx = normalizedText.indexOf(key);
    while (idx !== -1) {
      ranges.push([idx, idx + key.length - 1]);
      idx = normalizedText.indexOf(key, idx + 1);
    }
  }
  return hits.filter((h) => {
    if (exact.has(h.word)) return false;
    return !ranges.some(([s, e]) => h.start >= s && h.end <= e);
  });
}

export function check({ schoolId, text }) {
  const options = configValue('banned_word.normalize', schoolId);
  const { matcher, whitelist } = entriesFor(schoolId);
  const { text: normalized, map } = normalizeWithMap(text, options);
  const hits = applyWhitelist(findHits(matcher, normalized), normalized, whitelist);

  if (hits.length === 0) {
    return { level: null, action: 'pass', blocked: false, text, hits: [], scoreDelta: 0, violation: 0, needsTicket: false, normalized };
  }

  const penaltyCfg = configValue('banned_word.penalty', schoolId);
  let level = 'L1';
  for (const hit of hits) {
    if (LEVEL_WEIGHT[hit.entry.level] > LEVEL_WEIGHT[level]) level = hit.entry.level;
  }
  const rule = penaltyCfg[level] || {};
  const action = rule.action || 'hint';
  const detailed = hits.map((hit) => {
    const range = toOriginalRange(map, hit.start, hit.end);
    return {
      entryId: hit.entry.id, word: hit.entry.word, level: hit.entry.level, action: hit.entry.action,
      position: range.start, end: range.end,
      matchedText: String(text).slice(range.start, range.end + 1), normalizedMatch: hit.word,
    };
  });
  const shouldMask = level === 'L1' || action === 'mask';
  return {
    level,
    action: shouldMask ? 'mask' : action,
    blocked: action === 'block' || action === 'delete',
    deleteContent: action === 'delete',
    text: shouldMask ? maskSegments(text, detailed.map((d) => ({ start: d.position, end: d.end }))) : text,
    hits: detailed,
    scoreDelta: Number(rule.scoreDelta || 0),
    violation: Number(rule.violation || 0),
    needsTicket: Boolean(rule.ticket),
    needsBan: Boolean(rule.ban),
    normalized,
  };
}

function applyEscalation({ schoolId, userId }) {
  const cfg = configValue('banned_word.escalation', schoolId);
  const dayAgo = Date.now() - 86400000;
  const l1 = filter('word_hits', (h) => Number(h.user_id) === Number(userId) && Number(h.school_id) === Number(schoolId)
    && h.level === 'L1' && new Date(h.created_at).getTime() >= dayAgo).length;
  const l23 = filter('word_hits', (h) => Number(h.user_id) === Number(userId) && Number(h.school_id) === Number(schoolId)
    && (h.level === 'L2' || h.level === 'L3')).length;

  if (l1 > 0 && l1 % Number(cfg.L1_hint_per_day) === 0) {
    applyPenalty({
      schoolId, userId, type: 'mute', days: cfg.L1_mute_days, severity: 'light', source: 'word_hit',
      reason: `当日 L1 提示类违禁词累计 ${l1} 次`, effectiveCount: l1,
    });
  }
  if (l23 >= Number(cfg.L2L3_post_ban_hits) && l23 % Number(cfg.L2L3_post_ban_hits) === 0) {
    applyPenalty({
      schoolId, userId, type: 'mute', days: cfg.L2L3_post_ban_days, severity: 'light', source: 'word_hit',
      reason: `L2/L3 违禁词累计命中 ${l23} 次，禁止发帖`, effectiveCount: l23,
    });
  } else if (l23 >= Number(cfg.L2L3_mute_hits) && l23 % Number(cfg.L2L3_mute_hits) === 0) {
    applyPenalty({
      schoolId, userId, type: 'mute', days: cfg.L2L3_mute_days, severity: 'light', source: 'word_hit',
      reason: `L2/L3 违禁词累计命中 ${l23} 次，禁言`, effectiveCount: l23,
    });
  }
}

export function buildBlockMessage(decision) {
  const first = decision.hits[0];
  const list = decision.hits.slice(0, 3).map((h) => `「${h.word}」`).join('、');
  if (decision.level === 'L4') {
    return `内容包含严重违规信息（${list}），已删除并转人工处理，位置：第 ${first.position + 1} 个字符`;
  }
  if (decision.level === 'L3') {
    return `内容包含违规信息（${list}），已拦截并扣除 ${Math.abs(decision.scoreDelta)} 信誉分，位置：第 ${first.position + 1} 个字符`;
  }
  return `内容包含不允许发布的信息（${list}），请修改后重试，位置：第 ${first.position + 1} 个字符`;
}

export function notifyBlocked({ schoolId, userId, decision, scene }) {
  const words = [...new Set(decision.hits.map((h) => h.word))].join('、');
  notify(userId, {
    schoolId,
    type: 'word_hit',
    title: decision.level === 'L1' ? '内容中的联系方式已自动打码' : '内容命中违禁词提醒',
    content: `场景：${scene}；命中：${words}；处置：${decision.action}。${buildBlockMessage(decision)}`,
    relatedType: 'word_hit',
  });
}

/** 检测 + 处置 + 留痕：发布/评论/私信/简介统一入口 */
export function enforce({ schoolId, userId, scene, targetType = null, targetId = null, text }) {
  const decision = check({ schoolId, text });
  if (decision.hits.length === 0) return decision;

  for (const hit of decision.hits) {
    insert('word_hits', {
      school_id: Number(schoolId), user_id: Number(userId), word_id: hit.entryId, word: hit.word,
      level: hit.level, scene, target_type: targetType, target_id: targetId,
      matched_text: hit.matchedText, position: hit.position, action_taken: decision.action, created_at: nowIso(),
    });
  }

  if (decision.scoreDelta < 0) {
    applyCreditRule({
      schoolId, userId, ruleKey: 'banned_word',
      reason: `发布内容命中 L3 违禁词：${decision.hits.map((h) => h.word).join('、')}`,
      relatedType: 'word_hit', relatedId: decision.hits[0].entryId,
      expiresAt: isoAfter(365 * 86400000), deltaOverride: decision.scoreDelta,
    });
  }

  if (decision.needsTicket) {
    const words = [...new Set(decision.hits.map((h) => h.word))].join('、');
    insert('tickets', {
      ticket_no: `TK${Date.now()}`, school_id: Number(schoolId), source: 'word_hit', type: 'content',
      priority: 'urgent', subject: `违禁词 L4 命中：${words}`,
      description: `场景 ${scene}，命中词：${words}，内容片段：${String(text).slice(0, 200)}`,
      related_order_id: null, related_user_id: Number(userId), reporter_id: Number(userId),
      assignee_id: null, status: 'pending',
      first_response_at: null, first_response_due_at: isoAfter(4 * 3600000), resolve_due_at: isoAfter(24 * 3600000),
      escalated: 0, escalated_at: null, resolution: null, created_at: nowIso(), updated_at: nowIso(), closed_at: null,
    });
  }
  if (decision.needsBan) {
    applyPenalty({
      schoolId, userId, severity: 'severe', source: 'word_hit', type: 'permanent_ban', days: 0,
      reason: `发布严重违规内容（命中 L4：${[...new Set(decision.hits.map((h) => h.word))].join('、')}）`,
      permanent: true,
    });
  }

  applyEscalation({ schoolId, userId });

  if (decision.blocked) {
    const code = decision.level === 'L1' ? ERR.CONTENT_MASKED : ERR.CONTENT_BLOCKED_PENALTY;
    throw new AppError(code, buildBlockMessage(decision), {
      level: decision.level,
      hits: decision.hits.map((h) => ({ word: h.word, position: h.position, matchedText: h.matchedText })),
      scoreDelta: decision.scoreDelta,
    });
  }
  if (decision.hits.length > 0) notifyBlocked({ schoolId, userId, decision, scene });
  return decision;
}

// ---------------- 词库维护（管理后台） ----------------
export function listWords({ schoolId, level = null, status = null }) {
  return table('banned_words')
    .filter((w) => w.scope === 'global' || Number(w.school_id) === Number(schoolId) || !schoolId)
    .filter((w) => (!level || w.level === level) && (!status || w.status === status))
    .map((w) => ({ ...w }));
}

export function createWord(payload, { actorId = null, schoolId = null } = {}) {
  const normalized = normalizeWithMap(payload.word, { fullWidth: true, traditional: true, pinyin: false, stripSymbols: true }).text;
  return insert('banned_words', {
    word: payload.word, normalized,
    level: payload.level, category: payload.category || '未分类',
    match_type: payload.matchType || 'keyword', action: payload.action || 'block',
    score_delta: payload.scoreDelta ?? 0, violation_count: payload.violation || 0,
    scope: payload.scope || 'school', school_id: payload.scope === 'global' ? null : schoolId,
    status: payload.status || 'active', remark: payload.remark || null,
    created_by: actorId, created_at: nowIso(), updated_at: nowIso(),
  });
}

export function updateWord(id, patch, { schoolId = null } = {}) {
  const row = table('banned_words').find((w) => Number(w.id) === Number(id));
  if (!row) throw new AppError(ERR.NOT_FOUND, '词条不存在');
  Object.assign(row, {
    word: patch.word ?? row.word,
    level: patch.level ?? row.level,
    category: patch.category ?? row.category,
    match_type: patch.matchType ?? row.match_type,
    action: patch.action ?? row.action,
    score_delta: patch.scoreDelta ?? row.score_delta,
    status: patch.status ?? row.status,
    remark: patch.remark ?? row.remark,
    updated_at: nowIso(),
  });
  row.normalized = normalizeWithMap(row.word, { fullWidth: true, traditional: true, pinyin: false, stripSymbols: true }).text;
  return row;
}

export function deleteWord(id) {
  const rows = table('banned_words');
  const idx = rows.findIndex((w) => Number(w.id) === Number(id));
  if (idx < 0) throw new AppError(ERR.NOT_FOUND, '词条不存在');
  rows.splice(idx, 1);
  return { id: Number(id), deleted: true };
}

export function listHits({ schoolId, userId = null, level = null, page = 1, pageSize = 20 }) {
  const rows = filter('word_hits', (h) => Number(h.school_id) === Number(schoolId)
    && (!userId || Number(h.user_id) === Number(userId))
    && (!level || h.level === level))
    .sort((a, b) => Number(b.id) - Number(a.id));
  return { list: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

export { LEVEL_WEIGHT };
