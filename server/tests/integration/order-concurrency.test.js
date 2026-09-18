// 集成测试：并发下单防超卖（同一本书同一时刻只能有一个有效订单）
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import {
  auth, makeBook, cleanupByTitlePrefix, clearRateLimit, bumpSensitiveRateLimit, bookById, q, q1, closePool, SEED,
} from '../helpers/db.js';

const app = createApp();
let seller;
let buyer;
let book;
let previousOrderLimit;

before(async () => {
  // 并发用例需要一次打满 20 个请求，先放宽 order 场景限流（用后还原）
  previousOrderLimit = await bumpSensitiveRateLimit('order', 500);
  seller = await auth(SEED.students.jiangnanSeller);
  buyer = await auth(SEED.students.jiangnanBuyer);
  book = await makeBook({ schoolId: seller.user.school_id, sellerId: seller.user.id, priceCents: 1200 });
});

after(async () => {
  await cleanupByTitlePrefix();
  if (previousOrderLimit !== undefined) await bumpSensitiveRateLimit('order', previousOrderLimit);
  await closePool();
});

function createOrder(key, bookId = book.id, token = buyer.bearer) {
  return request(app)
    .post('/api/v1/orders')
    .set('Authorization', token)
    .set('Idempotency-Key', key)
    .send({ bookId, shipMode: 'meetup' });
}

test('20 个并发下单请求只有 1 个成功，其余返回教材不可用', async () => {
  await clearRateLimit('order', `u:${buyer.user.id}`);

  const responses = await Promise.all(
    Array.from({ length: 20 }, (_, i) => createOrder(`concurrency-${book.id}-${i}-${Date.now()}`)),
  );

  const succeeded = responses.filter((r) => r.body.code === 0);
  const rejected = responses.filter((r) => r.body.code !== 0);

  assert.equal(succeeded.length, 1, `期望只有 1 个成功，实际 ${succeeded.length}`);
  assert.equal(rejected.length, 19);
  for (const r of rejected) {
    assert.equal(r.body.code, 40904, `期望 40904（教材已不可用），实际 ${r.body.code}: ${r.body.message}`);
    assert.equal(r.status, 409);
  }

  const activeOrders = await q(
    "SELECT id FROM orders WHERE book_id = ? AND status IN ('pending_payment','paid','shipped','refund_requested','return_requested','disputed')",
    [book.id],
  );
  assert.equal(activeOrders.length, 1);

  const locked = await bookById(book.id);
  assert.equal(locked.status, 'locked');

  const again = await createOrder(`concurrency-${book.id}-again-${Date.now()}`);
  assert.equal(again.body.code, 40904);
});

test('订单快照：下单时固化服务费比例，避免后续配置变更影响历史订单', async () => {
  await clearRateLimit('order', `u:${buyer.user.id}`);
  const second = await makeBook({ schoolId: seller.user.school_id, sellerId: seller.user.id, priceCents: 2000 });
  const res = await createOrder(`snapshot-${second.id}-${Date.now()}`, second.id);
  assert.equal(res.body.code, 0);
  assert.equal(res.body.data.amountCents, 2000);

  const row = await q1('SELECT * FROM orders WHERE id = ?', [res.body.data.id]);
  const school = await q1('SELECT service_fee_bps FROM schools WHERE id = ?', [seller.user.school_id]);
  assert.equal(Number(row.service_fee_bps), Number(school.service_fee_bps));
  assert.equal(Number(row.service_fee_cents), Math.floor((2000 * Number(school.service_fee_bps)) / 10000));
  assert.equal(Number(row.seller_income_cents), 2000 - Number(row.service_fee_cents));
  assert.equal(row.status, 'pending_payment');
  assert.ok(row.order_no.startsWith('OD'));
});

test('幂等：同一 Idempotency-Key 重复下单只创建一个订单', async () => {
  await clearRateLimit('order', `u:${buyer.user.id}`);
  const third = await makeBook({ schoolId: seller.user.school_id, sellerId: seller.user.id, priceCents: 900 });
  const key = `idem-${third.id}-${Date.now()}`;
  const first = await createOrder(key, third.id);
  const second = await createOrder(key, third.id);
  assert.equal(first.body.code, 0);
  assert.equal(second.body.code, 0);
  assert.equal(first.body.data.id, second.body.data.id);

  const rows = await q('SELECT id FROM orders WHERE book_id = ?', [third.id]);
  assert.equal(rows.length, 1);
});
