// 集成测试：违禁词四级处置（打码/拦截/扣分记违规/删除转工单封禁）+ 归一化绕过 + 白名单
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { wordService } from '../../src/services/word.service.js';
import { pool } from '../../src/db/pool.js';
import { auth, q, q1, resetUserRisk, closePool, SEED } from '../helpers/db.js';

const SCHOOL_1 = 1; // 江南大学（配置了教材书名白名单）
const SCHOOL_3 = 3; // 成都理工大学
const users = {};

async function cleanWord(userId) {
  await q('DELETE FROM word_hits WHERE user_id = ?', [userId]);
  await q("DELETE FROM penalties WHERE user_id = ? AND source = 'word_hit'", [userId]);
  await q("DELETE FROM credit_logs WHERE user_id = ? AND rule_key = 'banned_word'", [userId]);
  await q("DELETE FROM tickets WHERE source = 'word_hit' AND related_user_id = ?", [userId]);
  await resetUserRisk(userId);
}

before(async () => {
  const zhengyi = await auth(SEED.students.chengliB);
  const gaoyuan = await auth(SEED.students.chengliC);
  users.zhengyi = zhengyi;
  users.gaoyuan = gaoyuan;
  await cleanWord(zhengyi.user.id);
  await cleanWord(gaoyuan.user.id);
  await q('UPDATE users SET credit_score = 100 WHERE id IN (?, ?)', [zhengyi.user.id, gaoyuan.user.id]);
});

after(async () => {
  await cleanWord(users.zhengyi.user.id);
  await cleanWord(users.gaoyuan.user.id);
  await closePool();
});

test('归一化检测：空格/符号/零宽/全角/繁体/拼音谐音绕过后仍能识别', async () => {
  const cases = [
    ['微 信', 'L1'],
    ['微*信', 'L1'],
    ['薇信', 'L1'],
    ['ｖｘ', 'L1'],
    ['weixin', 'L1'],
    ['daixie', 'L3'],
    ['盜版', 'L3'],
    ['刷單', 'L3'],
    ['dubo', 'L4'],
  ];
  for (const [text, expectedLevel] of cases) {
    const decision = await wordService.check({ schoolId: SCHOOL_1, text: `出售：${text}` });
    assert.equal(decision.level, expectedLevel, `「${text}」应识别为 ${expectedLevel}，实际 ${decision.level}`);
    assert.ok(decision.hits.length > 0);
  }
});

test('L1 提示类：允许发布但打码，并给出命中位置', async () => {
  const text = '我的手机号是13800138000，加微信详聊';
  const decision = await wordService.check({ schoolId: SCHOOL_1, text });
  assert.equal(decision.level, 'L1');
  assert.equal(decision.action, 'mask');
  assert.equal(decision.blocked, false, 'L1 不应拦截发布');
  assert.ok(!decision.text.includes('13800138000'), 'L1 命中内容必须打码');
  const hit = decision.hits.find((h) => h.word === '手机号');
  assert.ok(hit);
  assert.equal(typeof hit.position, 'number');
  assert.ok(text.slice(hit.position).startsWith('13800138000'), '命中位置应指向原文');
});

test('L2 拦截类：引流广告/外链/二维码拦截并要求修改', async () => {
  const decision = await wordService.check({ schoolId: SCHOOL_1, text: '扫码加群领资料，外链 https://spam.example.com' });
  assert.equal(decision.level, 'L2');
  assert.equal(decision.blocked, true);
  assert.equal(decision.scoreDelta, 0, 'L2 不扣分');

  await assert.rejects(
    () => wordService.enforce({ schoolId: SCHOOL_1, userId: users.zhengyi.user.id, scene: 'thread', text: '扫码加群领资料' }),
    (err) => err.code === 42202 && /不允许发布/.test(err.message),
  );
});

test('L3 违规类：拦截 + 扣 3 分 + 记违规 1 次 + 命中留痕', async () => {
  const user = users.zhengyi.user;
  const before = await q1('SELECT credit_score FROM users WHERE id = ?', [user.id]);
  const text = '出售考研盗版教材，另提供代写服务';

  await assert.rejects(
    () => wordService.enforce({ schoolId: user.school_id, userId: user.id, scene: 'thread', text }),
    (err) => err.code === 42202,
  );

  const after = await q1('SELECT credit_score FROM users WHERE id = ?', [user.id]);
  assert.equal(Number(after.credit_score), Number(before.credit_score) - 3, 'L3 必须扣 3 分');

  const log = await q1("SELECT * FROM credit_logs WHERE user_id = ? AND rule_key = 'banned_word' ORDER BY id DESC LIMIT 1", [user.id]);
  assert.ok(log, 'L3 必须写信誉分流水');
  assert.equal(Number(log.delta), -3);

  const hits = await q("SELECT level, word, scene, action_taken FROM word_hits WHERE user_id = ? AND level = 'L3'", [user.id]);
  assert.ok(hits.length >= 2, '每个命中词都要留痕');
  assert.ok(hits.some((h) => h.word === '盗版'));
  assert.ok(hits.some((h) => h.word === '代写'));
  assert.ok(hits.every((h) => h.action_taken === 'block'));

  // 违规次数：L3 命中记为 1 次（配置 banned_word.penalty.L3.violation = 1）
  const decision = await wordService.check({ schoolId: user.school_id, text });
  assert.equal(decision.violation, 1);
});

test('L4 严重类：删除内容 + 转人工工单 + 永久封禁', async () => {
  const user = users.gaoyuan.user;
  const text = '博彩赌博网站，充值返水';

  await assert.rejects(
    () => wordService.enforce({ schoolId: user.school_id, userId: user.id, scene: 'message', text }),
    (err) => err.code === 42202 && /严重违规/.test(err.message),
  );

  const ticket = await q1("SELECT * FROM tickets WHERE source = 'word_hit' AND related_user_id = ? ORDER BY id DESC LIMIT 1", [user.id]);
  assert.ok(ticket, 'L4 必须转人工工单');
  assert.equal(ticket.priority, 'urgent');
  assert.equal(Number(ticket.school_id), Number(user.school_id));

  const row = await q1('SELECT banned_permanently, status FROM users WHERE id = ?', [user.id]);
  assert.equal(Number(row.banned_permanently), 1, 'L4 必须封禁');
  assert.ok(ticket.first_response_due_at, '工单必须带 SLA 时限');
});

test('白名单：教材书名中的「答案」不误伤（学校级白名单）', async () => {
  const text = '转让《高等数学课后习题与答案解析》';
  const school1 = await wordService.check({ schoolId: SCHOOL_1, text });
  assert.equal(school1.hits.length, 0, '白名单内的命中应被忽略');
  assert.equal(school1.level, null);

  // 未配置白名单的学校仍然按全局词库拦截
  const school3 = await wordService.check({ schoolId: SCHOOL_3, text });
  assert.equal(school3.level, 'L3');
  assert.ok(school3.hits.some((h) => h.word === '答案'));
});

test('累计升级：同日 L1 提醒 3 次后禁言 1 天（阈值来自 configs）', async () => {
  const user = users.zhengyi.user;
  const schoolId = user.school_id;
  await cleanWord(user.id);

  for (let i = 1; i <= 3; i += 1) {
    const decision = await wordService.enforce({
      schoolId, userId: user.id, scene: 'reply', text: `联系方式 1380013800${i}`,
    });
    assert.equal(decision.level, 'L1');
  }

  const row = await q1('SELECT mute_until FROM users WHERE id = ?', [user.id]);
  assert.ok(row.mute_until && new Date(row.mute_until) > new Date(), '第 3 次 L1 命中应触发禁言');

  const penalty = await q1("SELECT * FROM penalties WHERE user_id = ? AND source = 'word_hit' ORDER BY id DESC LIMIT 1", [user.id]);
  assert.equal(penalty.type, 'mute');
  await cleanWord(user.id);
});
