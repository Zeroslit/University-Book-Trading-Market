// 违禁词检测前的文本归一化
// 目标：把「微*信 / 薇信 / ｗｅｉｘｉｎ / weixin / 微　信 / 微<零宽>信 / 代寫」统一还原成「微信」「代写」
// 原则：归一化只用于“检测匹配”，落库与展示仍用原文（L1 命中时对原文对应片段打码）
import { logger } from './logger.js';

const INVISIBLE = new Set([
  '\u200b', '\u200c', '\u200d', '\u200e', '\u200f', '\u2060', '\u2061', '\u2062',
  '\u2063', '\u2064', '\ufeff', '\u00ad', '\u180e',
]);

// 常见繁体 -> 简体（覆盖风控词库涉及的字形，可按需扩充）
const TRADITIONAL_MAP = {
  學: '学', 書: '书', 網: '网', 賣: '卖', 買: '买', 錢: '钱', 賬: '账', 帳: '账', 號: '号',
  證: '证', 憑: '凭', 銀: '银', 綁: '绑', 軟: '软', 導: '导', 鏈: '链', 廣: '广', 舉: '举',
  報: '报', 處: '处', 罰: '罚', 訴: '诉', 審: '审', 關: '关', 閉: '闭', 開: '开', 個: '个',
  體: '体', 這: '这', 嗎: '吗', 們: '们', 為: '为', 產: '产', 專: '专', 業: '业', 務: '务',
  費: '费', 際: '际', 溝: '沟', 聯: '联', 絡: '络', 條: '条', 約: '约', 價: '价', 貨: '货',
  運: '运', 遞: '递', 訂: '订', 單: '单', 確: '确', 認: '认', 檢: '检', 測: '测', 違: '违',
  規: '规', 詞: '词', 庫: '库', 寫: '写', 試: '试', 題: '题', 盜: '盗', 版: '版', 維: '维',
  碼: '码', 圖: '图', 騙: '骗', 詐: '诈', 黃: '黄', 賭: '赌', 罵: '骂', 遊: '游', 戲: '戏',
  幣: '币', 沖: '充', 賺: '赚', 傭: '佣', 貸: '贷', 匯: '汇', 轉: '转', 資: '资', 訊: '讯',
  話: '话', 機: '机', 視: '视', 頻: '频', 郵: '邮', 簡: '简', 歷: '历', 複: '复', 講: '讲',
  義: '义', 筆: '笔', 記: '记', 課: '课', 數: '数', 據: '据', 結: '结', 構: '构', 編: '编',
  譯: '译', 帶: '带', 帯: '带', 單: '单', 學: '学', 證: '证', 擺: '摆', 脫: '脱', 換: '换',
};

// 拼音 / 英文谐音还原
const PINYIN_ALIAS = {
  weixin: '微信', wechat: '微信', weix: '微信', wx: '微信', vx: '微信',
  weixinhao: '微信号', qqhao: 'QQ号', qq: 'QQ',
  daixie: '代写', daikao: '代考', daitikao: '代替考', tikao: '替考', tidaikao: '替代考',
  shuadan: '刷单', shuatidan: '刷单', shua: '刷',
  daoban: '盗版', erweima: '二维码', wailian: '外链', lianjie: '链接',
  jiaqun: '加群', jiaweixin: '加微信', jiawx: '加微信', jiawo: '加我', siwo: '私我',
  daan: '答案', kaoshidaan: '考试答案', anmo: '答案',
  zhuanzhang: '转账', daili: '代理', bozha: '博彩', dubo: '赌博', huangse: '黄色',
  zhapian: '诈骗', pianzi: '骗子', lianxi: '联系', mianshou: '面授',
};

// 词组级谐音/形近字还原（保守：只做词组映射，避免误伤正常词汇）
const PHRASE_MAP = {
  薇信: '微信', 溦信: '微信', 嶶信: '微信', 微芯: '微信', 徽信: '微信', 徵信: '微信',
  威芯: '微信', // 注意：威信/威芯属正常词时由白名单兜底，不在归一化层做特殊处理
  代寫: '代写', 帶考: '代考', 帯考: '代考', 刷單: '刷单', 盜版: '盗版',
  外鏈: '外链', 二維碼: '二维码', 賭博: '赌博', 博彩: '博彩',
};

const CJK = /[\u4e00-\u9fff\u3400-\u4dbf]/;
const ALNUM = /[a-z0-9]/;
const KEEP = /[\u4e00-\u9fff\u3400-\u4dbfA-Za-z0-9]/;

export const DEFAULT_NORMALIZE_OPTIONS = {
  fullWidth: true,
  traditional: true,
  pinyin: true,
  stripSymbols: true,
};

/**
 * 归一化并返回「归一化字符 -> 原文下标」映射
 * @param {string} input 原文
 * @param {object} options 归一化开关（来自 configs.banned_word.normalize）
 * @returns {{ text: string, map: number[] }}
 */
export function normalizeWithMap(input, options = {}) {
  const opts = { ...DEFAULT_NORMALIZE_OPTIONS, ...(options || {}) };
  const source = String(input ?? '');
  let text = opts.fullWidth ? source.normalize('NFKC') : source;

  const chars = [];
  const map = [];
  for (let i = 0; i < text.length; i += 1) {
    let ch = text[i];
    if (INVISIBLE.has(ch)) continue;
    if (opts.traditional && TRADITIONAL_MAP[ch]) ch = TRADITIONAL_MAP[ch];
    if (opts.stripSymbols && !KEEP.test(ch)) continue;
    chars.push(ch.toLowerCase());
    map.push(Math.min(i, Math.max(0, source.length - 1)));
  }

  let normalized = chars.join('');

  // 1) 词组还原：长词优先，替换后统一把新字符指回原起点
  if (opts.traditional || opts.stripSymbols) {
    const phrases = Object.keys(PHRASE_MAP).sort((a, b) => b.length - a.length);
    const current = normalized;
    const out = [];
    const outMap = [];
    let i = 0;
    while (i < current.length) {
      let hit = null;
      for (const phrase of phrases) {
        const key = foldPhrase(phrase, opts);
        if (key && current.startsWith(key, i)) {
          hit = { key, value: PHRASE_MAP[phrase] };
          break;
        }
      }
      if (hit) {
        for (const ch of hit.value) {
          out.push(ch);
          outMap.push(map[i] ?? 0);
        }
        i += hit.key.length;
      } else {
        out.push(current[i]);
        outMap.push(map[i] ?? 0);
        i += 1;
      }
    }
    normalized = out.join('');
    map.length = 0;
    map.push(...outMap);
  }

  // 2) 拼音 / 英文谐音还原：逐段扫描字母数字串，做最长前缀替换
  if (opts.pinyin && normalized.length > 0) {
    const out = [];
    const outMap = [];
    let i = 0;
    while (i < normalized.length) {
      if (!ALNUM.test(normalized[i])) {
        out.push(normalized[i]);
        outMap.push(map[i] ?? 0);
        i += 1;
        continue;
      }
      let j = i;
      while (j < normalized.length && ALNUM.test(normalized[j])) j += 1;
      let cursor = i;
      while (cursor < j) {
        let matchedLen = 0;
        for (let len = j - cursor; len >= 2; len -= 1) {
          const alias = PINYIN_ALIAS[normalized.slice(cursor, cursor + len)];
          if (!alias) continue;
          // 2~3 字符的缩写（wx/vx）仅在整串被消费时才还原，避免误伤英文单词
          const consumesAll = cursor + len === j;
          if (len < 4 && !consumesAll) continue;
          for (const ch of alias) {
            out.push(ch);
            outMap.push(map[cursor] ?? 0);
          }
          matchedLen = len;
          break;
        }
        if (matchedLen === 0) {
          out.push(normalized[cursor]);
          outMap.push(map[cursor] ?? 0);
          cursor += 1;
        } else {
          cursor += matchedLen;
        }
      }
      i = j;
    }
    normalized = out.join('');
    map.length = 0;
    map.push(...outMap);
  }

  return { text: normalized, map };
}

function foldPhrase(phrase, opts) {
  let t = opts.fullWidth ? String(phrase).normalize('NFKC') : String(phrase);
  const chars = [];
  for (const ch of t) {
    if (INVISIBLE.has(ch)) continue;
    const mapped = opts.traditional ? TRADITIONAL_MAP[ch] || ch : ch;
    if (opts.stripSymbols && !KEEP.test(mapped)) continue;
    chars.push(mapped.toLowerCase());
  }
  return chars.join('');
}

export function normalizeText(input, options = {}) {
  return normalizeWithMap(input, options).text;
}

export function isCjk(ch) {
  return CJK.test(ch);
}

// 归一化后的命中区间 -> 原文区间
export function toOriginalRange(map, start, endInclusive) {
  const from = map[start] ?? 0;
  const to = map[Math.max(0, Math.min(endInclusive, map.length - 1))] ?? from;
  return { start: Math.min(from, to), end: Math.max(from, to) };
}

export const __internal = { TRADITIONAL_MAP, PINYIN_ALIAS, PHRASE_MAP, foldPhrase };
logger.debug('normalize 模块已加载');
