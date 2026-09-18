// 违禁词服务：四级词库 + 归一化检测 + 命中留痕 + 分级处置 + 累计升级
// 设计要点：
//   1) 检测在「归一化文本」上做，命中区间再映射回原文（用于打码与位置提示）
//   2) 白名单（学校级）用于避免教材书名误伤
//   3) 所有命中写 word_hits，形成可反查的证据链
//   4) 处置动作、扣分、级别全部取自 configs.banned_word.*
import { AppError, ERR } from '../lib/errors.js';
import { normalizeWithMap, toOriginalRange } from '../lib/normalize.js';
import { buildMatcher, findHits } from '../lib/word-matcher.js';
import { maskSegments } from '../lib/mask.js';
import { configService } from './config.service.js';
import { creditService } from './credit.service.js';
import { penaltyService } from './penalty.service.js';
import { notifyService } from './notify.service.js';
import { q, q1, run } from '../db/tx.js';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';
import { currentTx } from '../db/tx-context.js';

const CACHE_TTL_MS = 60_000;
const cache = new Map(); // schoolId -> { matcher, whitelist, entries, expireAt }

const LEVEL_WEIGHT = { L1: 1, L2: 2, L3: 3, L4: 4 };

export const wordService = {
  async loadEntries(schoolId) {
    const rows = await q(
      pool,
      `SELECT id, word, normalized, level, category, match_type, action, score_delta, violation_count, scope, school_id, status
       FROM banned_words
       WHERE status IN ('active', 'whitelist') AND (scope = 'global' OR (scope = 'school' AND school_id = ?))`,
      [schoolId],
    );
    return rows;
  },

  async getMatcher(schoolId) {
    const cached = cache.get(schoolId);
    if (cached && cached.expireAt > Date.now()) return cached;

    const entries = await this.loadEntries(schoolId);
    const active = entries
      .filter((e) => e.status === 'active')
      .map((e) => ({
        id: e.id, word: e.word, normalized: e.normalized, level: e.level,
        matchType: e.match_type, action: e.action, scoreDelta: Number(e.score_delta),
        violationCount: Number(e.violation_count),
      }));
    const whitelist = entries.filter((e) => e.status === 'whitelist').map((e) => ({ word: e.word, normalized: e.normalized }));

    const value = { matcher: buildMatcher(active), whitelist, entryCount: active.length, expireAt: Date.now() + CACHE_TTL_MS };
    cache.set(schoolId, value);
    return value;
  },

  async invalidateCache(schoolId = null) {
    if (schoolId) cache.delete(Number(schoolId));
    else cache.clear();
  },

  // 纯检测（不产生副作用），返回处置建议
  async check({ schoolId, text, options = {} }) {
    const normalizeOptions = await this.normalizeOptions(schoolId);
    const { matcher, whitelist } = await this.getMatcher(schoolId);
    const { text: normalized, map } = normalizeWithMap(text, { ...normalizeOptions, ...options });
    const rawHits = findHits(matcher, normalized);
    const hits = this.applyWhitelist(rawHits, normalized, whitelist);

    if (hits.length === 0) {
      return { level: null, action: 'pass', blocked: false, text, hits: [], scoreDelta: 0, violation: 0, needsTicket: false, normalized };
    }

    const penaltyCfg = await configService.get('banned_word.penalty', schoolId);
    let level = 'L1';
    for (const hit of hits) {
      if (LEVEL_WEIGHT[hit.entry.level] > LEVEL_WEIGHT[level]) level = hit.entry.level;
    }
    const rule = penaltyCfg[level] || {};
    const action = rule.action || 'hint';

    const detailed = hits.map((hit) => {
      const range = toOriginalRange(map, hit.start, hit.end);
      return {
        entryId: hit.entry.id,
        word: hit.entry.word,
        level: hit.entry.level,
        action: hit.entry.action,
        position: range.start,
        end: range.end,
        matchedText: String(text).slice(range.start, range.end + 1),
        normalizedMatch: hit.word,
      };
    });

    const shouldMask = level === 'L1' || action === 'mask';
    const outputText = shouldMask ? maskSegments(text, detailed.map((d) => ({ start: d.position, end: d.end }))) : text;

    return {
      level,
      action: shouldMask ? 'mask' : action,
      blocked: action === 'block' || action === 'delete',
      deleteContent: action === 'delete',
      text: outputText,
      hits: detailed,
      scoreDelta: Number(rule.scoreDelta || 0),
      violation: Number(rule.violation || 0),
      needsTicket: Boolean(rule.ticket),
      needsBan: Boolean(rule.ban),
      normalized,
    };
  },

  /**
   * 检测 + 处置 + 留痕（发帖/评论/私信/简介/图片 OCR 统一入口）
   * @throws AppError CONTENT_BLOCKED_PENALTY（L3/L4）或 CONTENT_BLOCKED（L2）——命中拦截时抛出
   */
  async enforce({ conn = pool, schoolId, userId, scene, targetType = null, targetId = null, text, options = {} }) {
    // 契约：命中留痕/扣分/封禁必须独立提交，因此 enforce 应在业务事务之外调用；
    // 若调用方已在事务中，命中留痕会随业务回滚（这里只做告警，便于排查）
    if (currentTx()) logger.warn('wordService.enforce 在事务内被调用，命中留痕可能随业务回滚', { scene });
    const decision = await this.check({ schoolId, text, options });
    if (decision.hits.length === 0) return decision;

    // 1) 命中留痕
    for (const hit of decision.hits) {
      await run(
        conn,
        `INSERT INTO word_hits (school_id, user_id, word_id, word, level, scene, target_type, target_id, matched_text, position, action_taken)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [schoolId, userId, hit.entryId, hit.word, hit.level, scene, targetType, targetId,
          hit.matchedText, hit.position, decision.action],
      );
    }

    // 2) L3：扣分（规则键 banned_word，便于申诉回滚）
    if (decision.scoreDelta < 0) {
      await creditService.applyRule({
        conn, userId, schoolId, ruleKey: 'banned_word',
        reason: `发布内容命中 L3 违禁词：${decision.hits.map((h) => h.word).join('、')}`,
        relatedType: 'word_hit', relatedId: decision.hits[0].entryId,
        expiresAt: new Date(Date.now() + 365 * 86400000),
        deltaOverride: decision.scoreDelta,
      });
    }

    // 3) L4：转人工工单 + 视情节封禁
    if (decision.needsTicket) {
      const words = [...new Set(decision.hits.map((h) => h.word))].join('、');
      await run(
        conn,
        `INSERT INTO tickets (ticket_no, school_id, source, type, priority, subject, description, related_user_id, reporter_id, status, first_response_due_at, resolve_due_at)
         VALUES (?, ?, 'word_hit', 'content', 'urgent', ?, ?, ?, ?, 'pending', DATE_ADD(NOW(3), INTERVAL 4 HOUR), DATE_ADD(NOW(3), INTERVAL 24 HOUR))`,
        [`TK${Date.now()}${Math.floor(Math.random() * 1000)}`, schoolId,
          `违禁词 L4 命中：${words}`, `场景 ${scene}，命中词：${words}，内容片段：${String(text).slice(0, 200)}`,
          userId, userId],
      );
    }
    if (decision.needsBan) {
      await penaltyService.apply({
        conn, userId, schoolId, severity: 'severe', source: 'word_hit',
        reason: `发布严重违规内容（命中 L4：${[...new Set(decision.hits.map((h) => h.word))].join('、')}）`,
        type: 'permanent_ban', days: null, scoreDelta: 0,
      });
    }

    // 4) 累计升级：L1 当日 3 次提醒 -> 禁言 1 天；L2/L3 累计 3 次 -> 禁言 7 天；5 次 -> 禁发帖 30 天
    await this.applyEscalation({ conn, schoolId, userId, scene });

    if (decision.blocked) {
      const code = decision.level === 'L1' ? ERR.CONTENT_MASKED : ERR.CONTENT_BLOCKED_PENALTY;
      throw new AppError(code, this.buildBlockMessage(decision), {
        level: decision.level,
        hits: decision.hits.map((h) => ({ word: h.word, position: h.position, matchedText: h.matchedText })),
        scoreDelta: decision.scoreDelta,
      });
    }

    return decision;
  },

  // 命中累计升级（阈值取自 configs.banned_word.escalation）
  async applyEscalation({ conn = pool, schoolId, userId, scene }) {
    const cfg = await configService.get('banned_word.escalation', schoolId);
    const l1 = await q1(
      conn,
      `SELECT COUNT(*) AS total FROM word_hits
       WHERE user_id = ? AND school_id = ? AND level = 'L1' AND created_at >= DATE_SUB(NOW(3), INTERVAL 1 DAY)`,
      [userId, schoolId],
    );
    const l23 = await q1(
      conn,
      `SELECT COUNT(*) AS total FROM word_hits
       WHERE user_id = ? AND school_id = ? AND level IN ('L2','L3')`,
      [userId, schoolId],
    );

    const applied = [];
    if (Number(l1.total) > 0 && Number(l1.total) % Number(cfg.L1_hint_per_day) === 0) {
      applied.push(await penaltyService.apply({
        conn, userId, schoolId, source: 'word_hit', severity: 'light',
        reason: `当日 L1 提示类违禁词累计 ${l1.total} 次`,
        type: 'mute', days: cfg.L1_mute_days, scoreDelta: 0,
      }));
    }
    const l23Count = Number(l23.total);
    if (l23Count >= Number(cfg.L2L3_post_ban_hits) && l23Count % Number(cfg.L2L3_post_ban_hits) === 0) {
      applied.push(await penaltyService.apply({
        conn, userId, schoolId, source: 'word_hit', severity: 'light',
        reason: `L2/L3 违禁词累计命中 ${l23Count} 次，禁止发帖`,
        type: 'mute', days: cfg.L2L3_post_ban_days, scoreDelta: 0,
      }));
    } else if (l23Count >= Number(cfg.L2L3_mute_hits) && l23Count % Number(cfg.L2L3_mute_hits) === 0) {
      applied.push(await penaltyService.apply({
        conn, userId, schoolId, source: 'word_hit', severity: 'light',
        reason: `L2/L3 违禁词累计命中 ${l23Count} 次，禁言`,
        type: 'mute', days: cfg.L2L3_mute_days, scoreDelta: 0,
      }));
    }
    return applied;
  },

  buildBlockMessage(decision) {
    const first = decision.hits[0];
    const list = decision.hits.slice(0, 3).map((h) => `「${h.word}」`).join('、');
    if (decision.level === 'L4') {
      return `内容包含严重违规信息（${list}），已删除并转人工处理，位置：第 ${first.position + 1} 个字符`;
    }
    if (decision.level === 'L3') {
      return `内容包含违规信息（${list}），已拦截并扣除 ${Math.abs(decision.scoreDelta)} 信誉分，位置：第 ${first.position + 1} 个字符`;
    }
    return `内容包含不允许发布的信息（${list}），请修改后重试，位置：第 ${first.position + 1} 个字符`;
  },

  applyWhitelist(hits, normalizedText, whitelist) {
    if (!whitelist || whitelist.length === 0) return hits;
    const exact = new Set(whitelist.map((w) => w.normalized));
    const ranges = [];
    for (const w of whitelist) {
      if (!w.normalized || w.normalized.length < 2) continue;
      let idx = normalizedText.indexOf(w.normalized);
      while (idx !== -1) {
        ranges.push([idx, idx + w.normalized.length - 1]);
        idx = normalizedText.indexOf(w.normalized, idx + 1);
      }
    }
    return hits.filter((h) => {
      if (exact.has(h.word)) return false;
      return !ranges.some(([s, e]) => h.start >= s && h.end <= e);
    });
  },

  async normalizeOptions(schoolId) {
    try {
      return await configService.get('banned_word.normalize', schoolId);
    } catch {
      return { fullWidth: true, traditional: true, pinyin: true, stripSymbols: true };
    }
  },

  // 通知用户被拦截（可选：由路由层在捕获异常后调用）
  async notifyBlocked({ schoolId, userId, decision, scene }) {
    await notifyService.notify(userId, {
      schoolId, type: 'word',
      title: '内容发布提醒',
      content: this.buildBlockMessage(decision) + `（场景：${scene}）`,
      relatedType: 'word_hit', relatedId: decision.hits[0]?.entryId ?? null,
    });
  },

  async listHits({ schoolId, userId = null, level = null, page = 1, pageSize = 20 }) {
    const where = ['school_id = ?'];
    const params = [schoolId];
    if (userId) { where.push('user_id = ?'); params.push(userId); }
    if (level) { where.push('level = ?'); params.push(level); }
    const list = await q(
      pool,
      `SELECT id, user_id, word, level, scene, target_type, target_id, matched_text, position, action_taken, created_at
       FROM word_hits WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`,
      [...params, Number(pageSize), (page - 1) * pageSize],
    );
    const total = await q1(pool, `SELECT COUNT(*) AS total FROM word_hits WHERE ${where.join(' AND ')}`, params);
    return { list, total: Number(total.total) };
  },

  // ------- 词库维护（管理后台） -------
  async listWords({ schoolId = null, level = null, status = null }) {
    const where = ["(scope = 'global' OR school_id = ?)"];
    const params = [schoolId];
    if (level) { where.push('level = ?'); params.push(level); }
    if (status) { where.push('status = ?'); params.push(status); }
    return q(
      pool,
      `SELECT id, word, normalized, level, category, match_type, action, score_delta, violation_count, scope, school_id, status, remark, created_at
       FROM banned_words WHERE ${where.join(' AND ')} ORDER BY level, id`,
      params,
    );
  },

  async createWord(payload, { actorId = null } = {}) {
    const { word, level, category = null, matchType = 'keyword', scope = 'global', schoolId = null, status = 'active', action = null, scoreDelta = null, remark = null } = payload;
    const penaltyCfg = await configService.get('banned_word.penalty', schoolId);
    const rule = penaltyCfg[level] || {};
    if (matchType === 'regex') {
      try {
        // eslint-disable-next-line no-new
        new RegExp(word);
      } catch {
        throw new AppError(ERR.VALIDATION_ERROR, '正则表达式非法，请检查后重试');
      }
    }
    const normalized = matchType === 'regex' ? word : normalizeWithMap(word, await this.normalizeOptions(schoolId)).text;
    const result = await run(
      pool,
      `INSERT INTO banned_words (word, normalized, level, category, match_type, action, score_delta, violation_count, scope, school_id, status, remark, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [word, normalized, level, category, matchType,
        action || rule.action || 'hint', scoreDelta ?? Number(rule.scoreDelta || 0), Number(rule.violation || 0),
        scope, schoolId, status, remark, actorId],
    );
    await this.invalidateCache(schoolId);
    return { id: result.insertId, word, normalized, level };
  },

  async updateWord(id, patch, { schoolId = null } = {}) {
    const fields = [];
    const params = [];
    const mapping = {
      word: 'word', level: 'level', category: 'category', matchType: 'match_type', action: 'action',
      scoreDelta: 'score_delta', status: 'status', remark: 'remark', scope: 'scope', schoolId: 'school_id',
    };
    for (const [key, column] of Object.entries(mapping)) {
      if (patch[key] !== undefined) { fields.push(`${column} = ?`); params.push(patch[key]); }
    }
    if (patch.word !== undefined) {
      fields.push('normalized = ?');
      params.push(patch.matchType === 'regex' || patch.match_type === 'regex'
        ? patch.word
        : normalizeWithMap(patch.word, await this.normalizeOptions(schoolId)).text);
    }
    if (fields.length === 0) throw new AppError(ERR.VALIDATION_ERROR, '没有需要更新的字段');
    params.push(id);
    await run(pool, `UPDATE banned_words SET ${fields.join(', ')} WHERE id = ?`, params);
    await this.invalidateCache(schoolId);
    return { id };
  },

  async deleteWord(id, { actorId = null } = {}) {
    const row = await q1(pool, 'SELECT id, school_id FROM banned_words WHERE id = ?', [id]);
    if (!row) throw new AppError(ERR.NOT_FOUND, '词条不存在');
    await run(pool, 'DELETE FROM banned_words WHERE id = ?', [id]);
    await this.invalidateCache(row.school_id);
    logger.info('违禁词已删除', { id, actorId });
    return { id };
  },
};
