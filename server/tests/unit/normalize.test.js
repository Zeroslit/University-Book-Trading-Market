// 单元测试：违禁词归一化识别（去空格符号 / 全半角 / 繁简 / 拼音谐音 / 零宽字符）
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWithMap, normalizeText, toOriginalRange } from '../../src/lib/normalize.js';
import { buildMatcher, findHits, filterWhitelist } from '../../src/lib/word-matcher.js';
import { maskSegments } from '../../src/lib/mask.js';

test('归一化：去除空格与符号，还原词组', () => {
  assert.equal(normalizeText('微 信'), '微信');
  assert.equal(normalizeText('微*信'), '微信');
  assert.equal(normalizeText('微　信'), '微信');
  assert.equal(normalizeText('薇信'), '微信');
  assert.equal(normalizeText('嶶信'), '微信');
});

test('归一化：去除零宽字符与不可见字符', () => {
  assert.equal(normalizeText('微\u200b信'), '微信');
  assert.equal(normalizeText('代\ufeff写'), '代写');
});

test('归一化：全角转半角', () => {
  assert.equal(normalizeText('ＱＱ号'), 'QQ号');
  assert.equal(normalizeText('１２３４５'), '12345');
});

test('归一化：繁体转简体', () => {
  assert.equal(normalizeText('盜版'), '盗版');
  assert.equal(normalizeText('代寫'), '代写');
  assert.equal(normalizeText('二維碼'), '二维码');
});

test('归一化：拼音与英文谐音还原', () => {
  assert.equal(normalizeText('daixie'), '代写');
  assert.equal(normalizeText('daikao'), '代考');
  assert.equal(normalizeText('shuadan'), '刷单');
  assert.equal(normalizeText('vx'), '微信');
  assert.equal(normalizeText('weixin'), '微信');
});

test('归一化：开关可关闭（检测策略来自 configs.banned_word.normalize）', () => {
  // 词组级还原（盜版 -> 盗版）仍会生效，属于纵深防御；两者都关闭时保持原文
  assert.equal(normalizeText('盜版', { traditional: false, stripSymbols: false }), '盜版');
  assert.equal(normalizeText('微 信', { stripSymbols: false }), '微 信');
  assert.equal(normalizeText('daixie', { pinyin: false }), 'daixie');
});

test('归一化：命中区间可映射回原文，用于打码与位置提示', () => {
  const source = '联系我 微 * 信 一起买书';
  const { text, map } = normalizeWithMap(source);
  assert.ok(text.includes('微信'));
  const start = text.indexOf('微信');
  const range = toOriginalRange(map, start, start + 1);
  const raw = Array.from(source).slice(range.start, range.end + 1).join('');
  // 原文片段应覆盖被拆开的「微」「信」，用于定位提示
  assert.ok(raw.includes('微'));
  assert.ok(raw.includes('信'));
});

test('匹配器：关键词 AC 自动机 + 正则规则（手机号）', () => {
  const entries = [
    { id: 1, word: '代写', normalized: '代写', level: 'L3', matchType: 'keyword' },
    { id: 2, word: '手机号', normalized: '1[3-9]\\d{9}', level: 'L1', matchType: 'regex' },
  ];
  const matcher = buildMatcher(entries);

  const hits1 = findHits(matcher, normalizeText('可以代写作业'));
  assert.equal(hits1.length, 1);
  assert.equal(hits1[0].entry.level, 'L3');

  // 全角/带符号的手机号也要能命中
  const hits2 = findHits(matcher, normalizeText('加我１３８-００１３-８０００'));
  assert.equal(hits2.length, 1);
  assert.equal(hits2[0].entry.level, 'L1');
  assert.equal(hits2[0].raw, '13800138000');

  assert.equal(findHits(matcher, normalizeText('正常教材转让')).length, 0);
});

test('白名单：教材书名等正常词不误伤', () => {
  const entries = [{ id: 1, word: '答案', normalized: '答案', level: 'L3', matchType: 'keyword' }];
  const matcher = buildMatcher(entries);
  const hits = findHits(matcher, normalizeText('《高等数学课后习题与答案解析》'));
  assert.equal(hits.length, 1);
  // 白名单命中后应被过滤
  assert.equal(filterWhitelist(hits, ['习题与答案解析']).length, 0);
});

test('L1 打码：命中片段在原文中打码，保留首尾', () => {
  const text = '我的手机号 13800138000 请加我';
  const start = text.indexOf('13800138000');
  const masked = maskSegments(text, [{ start, end: start + 10 }]);
  assert.ok(masked.includes('1*********0'));
  assert.ok(!masked.includes('13800138000'));
});
