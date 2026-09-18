// 多模式匹配器：AC 自动机（关键词） + 正则规则（手机号/QQ/微信号等 L1 模式）
// 关键词与正则都基于「归一化后的文本」匹配，命中区间会映射回原文用于打码与位置提示
export class AhoCorasick {
  constructor() {
    this.goto = [Object.create(null)];
    this.fail = [0];
    this.out = [[]];
  }

  add(word, payload) {
    if (!word) return;
    let state = 0;
    for (const ch of word) {
      if (this.goto[state][ch] === undefined) {
        this.goto[state][ch] = this.goto.length;
        this.goto.push(Object.create(null));
        this.fail.push(0);
        this.out.push([]);
      }
      state = this.goto[state][ch];
    }
    this.out[state].push({ word, payload });
  }

  build() {
    const queue = [];
    for (const ch of Object.keys(this.goto[0])) {
      const next = this.goto[0][ch];
      this.fail[next] = 0;
      queue.push(next);
    }
    while (queue.length > 0) {
      const state = queue.shift();
      for (const ch of Object.keys(this.goto[state])) {
        const next = this.goto[state][ch];
        let f = this.fail[state];
        while (f !== 0 && this.goto[f][ch] === undefined) f = this.fail[f];
        const target = this.goto[f][ch];
        this.fail[next] = target !== undefined && target !== next ? target : 0;
        if (this.out[this.fail[next]].length > 0) {
          this.out[next] = this.out[next].concat(this.out[this.fail[next]]);
        }
        queue.push(next);
      }
    }
    return this;
  }

  // 返回所有命中（含重叠），坐标基于传入文本
  search(text) {
    const hits = [];
    let state = 0;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      while (state !== 0 && this.goto[state][ch] === undefined) state = this.fail[state];
      state = this.goto[state][ch] !== undefined ? this.goto[state][ch] : 0;
      for (const item of this.out[state]) {
        hits.push({
          entry: item.payload,
          word: item.word,
          start: i - item.word.length + 1,
          end: i,
        });
      }
    }
    return hits;
  }
}

/**
 * 构建匹配器
 * @param {Array<{id:number, word:string, normalized:string, level:string, matchType:string, action?:string}>} entries
 */
export function buildMatcher(entries = []) {
  const automaton = new AhoCorasick();
  const regexRules = [];
  for (const entry of entries) {
    if (entry.matchType === 'regex') {
      try {
        regexRules.push({ entry, regex: new RegExp(entry.normalized || entry.word, 'gi') });
      } catch {
        // 非法正则跳过（词库录入时会校验，这里兜底防止阻塞整个匹配器）
      }
    } else {
      automaton.add(entry.normalized || entry.word, entry);
    }
  }
  automaton.build();
  return { automaton, regexRules };
}

/**
 * 在归一化文本上查找全部命中
 * @returns {Array<{entry, word, start, end, raw}>}
 */
export function findHits(matcher, normalizedText) {
  const text = String(normalizedText || '');
  const hits = matcher.automaton.search(text).map((h) => ({
    entry: h.entry,
    word: h.word,
    start: h.start,
    end: h.end,
    raw: text.slice(h.start, h.end + 1),
  }));

  for (const rule of matcher.regexRules) {
    rule.regex.lastIndex = 0;
    let m = rule.regex.exec(text);
    while (m) {
      hits.push({
        entry: rule.entry,
        word: m[0],
        start: m.index,
        end: m.index + m[0].length - 1,
        raw: m[0],
      });
      if (m[0].length === 0) rule.regex.lastIndex += 1; // 防止零宽匹配死循环
      m = rule.regex.exec(text);
    }
  }

  return hits.sort((a, b) => a.start - b.start || b.end - a.end);
}

// 白名单过滤：命中片段完全落在白名单词内部则忽略（避免教材书名误伤）
export function filterWhitelist(hits, whitelist = []) {
  if (!whitelist.length) return hits;
  const words = whitelist.map((w) => String(w).toLowerCase()).filter(Boolean);
  return hits.filter((hit) => {
    return !words.some((w) => {
      if (!w) return false;
      const contains = hit.word && w.includes(hit.word);
      return contains;
    });
  });
}
