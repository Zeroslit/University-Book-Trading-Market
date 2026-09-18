// 集成测试：信誉分档位与联动权限（阈值全部来自 configs.credit.*，禁止写死）
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { creditService } from '../../src/services/credit.service.js';
import {
  auth, q, closePool, SEED, makeBook, cleanupByTitlePrefix, deleteBooksByTitlePrefix, clearRateLimit, bumpSensitiveRateLimit,
} from '../helpers/db.js';

const app = createApp();
let user;
let schoolId;
let previousOrderLimit;

async function setScore(score) {
  await q('UPDATE users SET credit_score = ? WHERE id = ?', [score, user.id]);
}

before(async () => {
  previousOrderLimit = await bumpSensitiveRateLimit('order', 500);
  const item = await auth(SEED.students.zhengqing); // 赵磊（学校2）
  user = item.user;
  schoolId = item.user.school_id;
  await deleteBooksByTitlePrefix('档位测试');
});

after(async () => {
  await deleteBooksByTitlePrefix('档位测试');
  await cleanupByTitlePrefix();
  await setScore(100);
  if (previousOrderLimit !== undefined) await bumpSensitiveRateLimit('order', previousOrderLimit);
  await closePool();
});

test('档位映射：90-100 优秀 / 70-89 良好 / 50-69 受限 / 30-49 高风险 / <30 禁止交易', async () => {
  const cases = [
    [100, 'excellent'], [90, 'excellent'],
    [89, 'good'], [70, 'good'],
    [69, 'limited'], [50, 'limited'],
    [49, 'high_risk'], [30, 'high_risk'],
    [29, 'banned'], [0, 'banned'],
  ];
  for (const [score, expected] of cases) {
    await setScore(score);
    const tier = await creditService.getTier(schoolId, score);
    assert.equal(tier.key, expected, `${score} 分应属于 ${expected}`);
  }
});

test('档位联动权限：挂书数量 / 提现时效 / 能否发布 / 能否交易', async () => {
  const expectations = [
    ['excellent', { canPublish: true, canTrade: true, maxBooks: 999, withdrawDelayHours: 0 }],
    ['good', { canPublish: true, canTrade: true, maxBooks: 50, withdrawDelayHours: 0 }],
    ['limited', { canPublish: true, canTrade: true, maxBooks: 3, withdrawDelayHours: 24 }],
    ['high_risk', { canPublish: false, canTrade: true, maxBooks: 0, withdrawDelayHours: 24 }],
    ['banned', { canPublish: false, canTrade: false, maxBooks: 0, withdrawDelayHours: 24 }],
  ];
  const scoreByTier = { excellent: 95, good: 80, limited: 60, high_risk: 40, banned: 20 };
  for (const [tierKey, expected] of expectations) {
    await setScore(scoreByTier[tierKey]);
    const permissions = await creditService.getPermissions(schoolId, user.id);
    assert.equal(permissions.tier, tierKey);
    assert.equal(permissions.canPublish, expected.canPublish, `${tierKey} canPublish`);
    assert.equal(permissions.canTrade, expected.canTrade, `${tierKey} canTrade`);
    assert.equal(permissions.maxBooks, expected.maxBooks, `${tierKey} maxBooks`);
    assert.equal(permissions.withdrawDelayHours, expected.withdrawDelayHours, `${tierKey} withdrawDelayHours`);
  }
});

test('高风险档位：不能发布但可以浏览与交易', async () => {
  await setScore(40); // 高风险
  const publish = await request(app).post('/api/v1/threads')
    .set('Authorization', `Bearer ${(await auth(SEED.students.zhengqing)).token}`)
    .send({ type: 'seek', title: '高风险档位测试帖子', content: '测试内容，用于验证禁止发布。' });
  assert.equal(publish.body.code, 40308);
  assert.match(publish.body.message, /不允许发布/);

  const browse = await request(app).get('/api/v1/threads').set('Authorization', `Bearer ${(await auth(SEED.students.zhengqing)).token}`);
  assert.equal(browse.body.code, 0, '高风险档位仍可浏览');
});

test('禁止交易档位：可以浏览但无法下单', async () => {
  const token = (await auth(SEED.students.zhengqing)).token;
  await setScore(20);
  await clearRateLimit('order', `u:${user.id}`);
  const order = await request(app).post('/api/v1/orders')
    .set('Authorization', `Bearer ${token}`)
    .send({ bookId: 1, shipMode: 'meetup' });
  assert.equal(order.body.code, 40308);
  assert.match(order.body.message, /无法交易|仅可浏览/);

  const browse = await request(app).get('/api/v1/books').set('Authorization', `Bearer ${token}`);
  assert.equal(browse.body.code, 0);
});

test('受限档位：最多同时挂 3 本书', async () => {
  const token = (await auth(SEED.students.zhengqing)).token;
  await setScore(60); // 受限
  await deleteBooksByTitlePrefix('档位测试');
  for (let i = 1; i <= 3; i += 1) {
    await makeBook({ schoolId, sellerId: user.id, priceCents: 1000, title: `档位测试书${i}` });
  }
  await clearRateLimit('publish', `u:${user.id}`);

  const res = await request(app).post('/api/v1/books')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: '档位测试第 4 本', author: '测试', publisher: '测试出版社', courseName: '测试课程',
      conditionLevel: 'good', originalPriceCents: 2000, priceCents: 1000,
      images: ['/static/test/1.jpg'],
    });
  assert.equal(res.body.code, 40308);
  assert.equal(res.body.details.maxBooks, 3);

  // 优秀档位可继续发布（上限 999）
  await setScore(95);
  await clearRateLimit('publish', `u:${user.id}`);
  const ok = await request(app).post('/api/v1/books')
    .set('Authorization', `Bearer ${token}`)
    .send({
      title: '档位测试第 4 本（优秀档位）', author: '测试', publisher: '测试出版社', courseName: '测试课程',
      conditionLevel: 'good', originalPriceCents: 2000, priceCents: 1000,
      images: ['/static/test/1.jpg'],
    });
  assert.equal(ok.body.code, 0, ok.body.message);
});
