// 集成测试：处罚梯度与次数口径（全部来自 configs.penalty.escalation，禁止写死）
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { penaltyService } from '../../src/services/penalty.service.js';
import { orderService } from '../../src/services/order.service.js';
import { pool } from '../../src/db/pool.js';
import {
  auth, makeBook, cleanupByTitlePrefix, clearRateLimit, bumpSensitiveRateLimit,
  balanceOf, q, q1, resetUserRisk, closePool, SEED,
} from '../helpers/db.js';

const app = createApp();
const TEST_PHONES = [
  SEED.students.chengli, // 李文（学校3）
  SEED.students.zhengqing, // 赵磊（学校2）
  SEED.students.jiangnanBuyer, // 陈默（学校1，仅用于封禁不锁资金用例的买家）
];
const users = {};
let previousOrderLimit;

async function cleanRisk(userId) {
  await q('DELETE FROM penalties WHERE user_id = ?', [userId]);
  await q("DELETE FROM credit_logs WHERE user_id = ? AND rule_key <> 'recharge'", [userId]);
  await resetUserRisk(userId);
  await q('UPDATE users SET credit_score = 100 WHERE id = ?', [userId]);
}

before(async () => {
  previousOrderLimit = await bumpSensitiveRateLimit('order', 500);
  for (const phone of TEST_PHONES) {
    const item = await auth(phone);
    users[phone] = item;
    await cleanRisk(item.user.id);
  }
});

after(async () => {
  for (const phone of TEST_PHONES) await cleanRisk(users[phone].user.id);
  await cleanupByTitlePrefix();
  if (previousOrderLimit !== undefined) await bumpSensitiveRateLimit('order', previousOrderLimit);
  await closePool();
});

test('处罚梯度：1-2 次警告、3 次禁言 3 天并扣 5 分、4 次限制交易、5-9 次逐级封禁、10 次永久封禁', async () => {
  const { user } = users[SEED.students.chengli];
  const schoolId = user.school_id;

  const expected = [
    { times: 1, type: 'warning', days: 0 },
    { times: 2, type: 'warning', days: 0 },
    { times: 3, type: 'mute', days: 3 },
    { times: 4, type: 'trade_ban', days: 7 },
    { times: 5, type: 'login_ban', days: 7 },
    { times: 6, type: 'login_ban', days: 15 },
    { times: 7, type: 'login_ban', days: 20 },
    { times: 8, type: 'login_ban', days: 25 },
    { times: 9, type: 'login_ban', days: 30 },
    { times: 10, type: 'permanent_ban', days: null },
  ];

  for (const step of expected) {
    const result = await penaltyService.apply({
      userId: user.id, schoolId, severity: 'light',
      reason: `测试：第 ${step.times} 次违规成立`, source: 'report',
    });
    assert.equal(result.effectiveCount, step.times, `第 ${step.times} 次处罚的有效次数应为 ${step.times}`);
    assert.equal(result.step.type, step.type, `第 ${step.times} 次应为 ${step.type}`);
    if (step.days !== null) assert.equal(Number(result.step.days), step.days);
  }

  const after = await q1('SELECT credit_score, banned_permanently FROM users WHERE id = ?', [user.id]);
  assert.equal(Number(after.credit_score), 95, '只有第 3 次扣 5 分');
  assert.equal(Number(after.banned_permanently), 1);

  const counter = await penaltyService.countEffectiveViolations(pool, { userId: user.id, schoolId });
  assert.equal(counter.effectiveCount, 10);
  const rows = await q('SELECT type FROM penalties WHERE user_id = ? ORDER BY id', [user.id]);
  assert.equal(rows.length, 10);
});

test('严重违规一票永久封禁', async () => {
  const { user } = users[SEED.students.chengli];
  const result = await penaltyService.apply({
    userId: user.id, schoolId: user.school_id, severity: 'severe',
    reason: '测试：涉嫌诈骗', source: 'report',
  });
  assert.equal(result.step.type, 'permanent_ban');
  const row = await q1('SELECT banned_permanently, status FROM users WHERE id = ?', [user.id]);
  assert.equal(Number(row.banned_permanently), 1);
  assert.equal(row.status, 'banned');
});

test('申诉成功：撤销处罚、回滚信誉分、解除封禁，且不计入成立次数', async () => {
  const { user } = users[SEED.students.zhengqing];
  const schoolId = user.school_id;
  await cleanRisk(user.id);

  let last = null;
  for (let i = 1; i <= 3; i += 1) {
    last = await penaltyService.apply({ userId: user.id, schoolId, severity: 'light', reason: `测试第 ${i} 次` });
  }
  assert.equal(last.step.type, 'mute');
  const banned = await q1('SELECT credit_score, mute_until FROM users WHERE id = ?', [user.id]);
  assert.equal(Number(banned.credit_score), 95);
  assert.ok(banned.mute_until);

  const revoked = await penaltyService.revoke({ penaltyId: last.penaltyId, reviewerId: null, reason: '申诉通过，撤销处罚' });
  assert.equal(revoked.revoked, true);

  const after = await q1('SELECT credit_score, mute_until, status FROM users WHERE id = ?', [user.id]);
  assert.equal(Number(after.credit_score), 100, '申诉成功必须回滚信誉分');
  assert.equal(after.mute_until, null, '申诉成功必须解除封禁');
  assert.equal(after.status, 'active');

  const penaltyRow = await q1('SELECT status, appeal_status FROM penalties WHERE id = ?', [last.penaltyId]);
  assert.equal(penaltyRow.status, 'revoked');
  assert.equal(penaltyRow.appeal_status, 'approved');

  const counter = await penaltyService.countEffectiveViolations(pool, { userId: user.id, schoolId });
  assert.equal(counter.effectiveCount, 2, '撤销后不计入成立次数');
});

test('次数口径：轻度违规 12 个月滚动过期，连续 6 个月无违规消除 1 次', async () => {
  const { user } = users[SEED.students.zhengqing];
  const schoolId = user.school_id;
  await q('DELETE FROM penalties WHERE user_id = ?', [user.id]);

  await q(
    `INSERT INTO penalties (user_id, school_id, type, severity, effective_count, reason, start_at, status, source)
     VALUES (?, ?, 'warning', 'light', 1, '历史违规A', DATE_SUB(NOW(3), INTERVAL 14 MONTH), 'active', 'report'),
            (?, ?, 'warning', 'light', 2, '历史违规B', DATE_SUB(NOW(3), INTERVAL 13 MONTH), 'active', 'report'),
            (?, ?, 'warning', 'light', 3, '近期违规', NOW(3), 'active', 'report')`,
    [user.id, schoolId, user.id, schoolId, user.id, schoolId],
  );
  const counter = await penaltyService.countEffectiveViolations(pool, { userId: user.id, schoolId });
  assert.equal(counter.expiredCount, 2, '超过 12 个月的轻度违规应过期');
  assert.equal(counter.effectiveCount, 1, '过期记录不计入有效次数');

  // 连续 8 个月无违规：消除 1 次
  await q('UPDATE penalties SET start_at = DATE_SUB(NOW(3), INTERVAL 8 MONTH) WHERE user_id = ?', [user.id]);
  const clean = await penaltyService.countEffectiveViolations(pool, { userId: user.id, schoolId });
  assert.equal(clean.reduction, 1);
  assert.equal(clean.effectiveCount, 2, '3 条成立 - 消除 1 次 = 2');
});

test('封禁不锁死资金：买家被封禁后订单仍可发货并由系统放款给卖家', async () => {
  const seller = await auth(SEED.students.jiangnanSeller); // 林晓（学校1）
  const buyer = users[SEED.students.jiangnanBuyer]; // 陈默（学校1）
  await cleanRisk(seller.user.id);
  await cleanRisk(buyer.user.id);
  await clearRateLimit('order', `u:${buyer.user.id}`);
  await clearRateLimit('order', `u:${seller.user.id}`);

  const book = await makeBook({ schoolId: seller.user.school_id, sellerId: seller.user.id, priceCents: 900 });
  const sellerBefore = await balanceOf(seller.user.id);

  const created = await request(app).post('/api/v1/orders')
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `ban-${book.id}-create`)
    .send({ bookId: book.id, shipMode: 'meetup' });
  assert.equal(created.body.code, 0, created.body.message);
  const orderId = created.body.data.id;

  const paid = await request(app).post(`/api/v1/orders/${orderId}/pay`)
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `ban-${book.id}-pay`).send({});
  assert.equal(paid.body.code, 0, paid.body.message);

  // 买家被封禁（禁止登录）
  await q("UPDATE users SET login_ban_until = DATE_ADD(NOW(3), INTERVAL 7 DAY), status = 'banned' WHERE id = ?", [buyer.user.id]);
  const bannedReq = await request(app).get('/api/v1/orders').set('Authorization', buyer.bearer);
  assert.equal(bannedReq.body.code, 40307, '被封禁用户应被拒绝登录态访问');

  // 卖家仍可发货；到期后系统自动确认收货并放款，资金不被锁死
  const shipped = await request(app).post(`/api/v1/orders/${orderId}/ship`)
    .set('Authorization', seller.bearer).send({});
  assert.equal(shipped.body.code, 0, shipped.body.message);

  await q('UPDATE orders SET auto_confirm_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?', [orderId]);
  await orderService.autoConfirmDue({ limit: 10 });

  const order = await q1('SELECT status, seller_income_cents FROM orders WHERE id = ?', [orderId]);
  assert.equal(order.status, 'completed');
  assert.equal(await balanceOf(seller.user.id), sellerBefore + Number(order.seller_income_cents));
});
