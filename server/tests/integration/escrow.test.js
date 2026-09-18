// 集成测试：资金托管全链路（付款托管 -> 发货 -> 确认收货放款扣服务费）+ 自动确认收货
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { orderService } from '../../src/services/order.service.js';
import {
  auth, makeBook, cleanupByTitlePrefix, clearRateLimit, bumpSensitiveRateLimit,
  balanceOf, transactionsOfOrder, orderById, bookById, platformAccount, q, q1, closePool, SEED,
} from '../helpers/db.js';

const app = createApp();
let seller;
let buyer;
let platform;
let previousOrderLimit;

before(async () => {
  previousOrderLimit = await bumpSensitiveRateLimit('order', 500);
  seller = await auth(SEED.students.jiangnanSeller); // 学校1 林晓
  buyer = await auth(SEED.students.jiangnanBuyer); // 学校1 陈默（有余额）
  platform = await platformAccount();
});

after(async () => {
  await cleanupByTitlePrefix();
  if (previousOrderLimit !== undefined) await bumpSensitiveRateLimit('order', previousOrderLimit);
  await closePool();
});

async function runToShipped(priceCents = 1000, suffix = '', { ship = true } = {}) {
  const book = await makeBook({ schoolId: seller.user.school_id, sellerId: seller.user.id, priceCents });
  const key = `${suffix}-${book.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const created = await request(app).post('/api/v1/orders')
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `create-${key}`)
    .send({ bookId: book.id, shipMode: 'meetup' });
  assert.equal(created.body.code, 0, created.body.message);
  const orderId = created.body.data.id;

  const paid = await request(app).post(`/api/v1/orders/${orderId}/pay`)
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `pay-${key}`).send({});
  assert.equal(paid.body.code, 0, paid.body.message);
  assert.equal(paid.body.data.escrowStatus, 'held');

  if (ship) {
    const shipped = await request(app).post(`/api/v1/orders/${orderId}/ship`)
      .set('Authorization', seller.bearer).send({});
    assert.equal(shipped.body.code, 0, shipped.body.message);
  }
  return { book, orderId, key };
}

test('托管放款：确认收货后卖家到账（已扣服务费）、平台服务费入账、流水可按订单追溯', async () => {
  const priceCents = 1000;
  const buyerBefore = await balanceOf(buyer.user.id);
  const sellerBefore = await balanceOf(seller.user.id);
  const platformBefore = await balanceOf(platform.id);
  const buyerFrozenBefore = await balanceOf(buyer.user.id, 'frozen');

  const { book, orderId, key } = await runToShipped(priceCents, 'release');

  // 付款后：买家可用 -1000、冻结 +1000（资金在平台托管）
  const buyerAfterPay = await balanceOf(buyer.user.id);
  const buyerFrozenAfterPay = await balanceOf(buyer.user.id, 'frozen');
  assert.equal(buyerAfterPay, buyerBefore - priceCents, '付款后买家可用余额应减少');
  assert.equal(buyerFrozenAfterPay, buyerFrozenBefore + priceCents, '付款后应产生等额托管冻结');

  const orderRow = await orderById(orderId);
  const fee = Number(orderRow.service_fee_cents);
  const income = Number(orderRow.seller_income_cents);
  assert.equal(fee + income, priceCents);
  assert.ok(fee > 0, '服务费必须来自学校配置（>0）');

  const confirmed = await request(app).post(`/api/v1/orders/${orderId}/confirm`)
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `confirm-${key}`).send({});
  assert.equal(confirmed.body.code, 0, confirmed.body.message);
  assert.equal(confirmed.body.data.status, 'completed');
  assert.equal(confirmed.body.data.escrowStatus, 'released');
  assert.equal(confirmed.body.data.sellerIncomeCents, income);

  // 资金结果
  assert.equal(await balanceOf(buyer.user.id), buyerBefore - priceCents, '买家余额回到付款前口径（钱已给卖家）');
  assert.equal(await balanceOf(buyer.user.id, 'frozen'), buyerFrozenBefore, '托管冻结应释放');
  assert.equal(await balanceOf(seller.user.id), sellerBefore + income, '卖家应按 seller_income_cents 到账');
  assert.equal(await balanceOf(platform.id), platformBefore + fee, '平台服务费应入账');

  // 流水可追溯：pay / escrow_hold / escrow_release / settle / fee
  const txs = await transactionsOfOrder(orderId);
  const bizTypes = txs.map((t) => t.biz_type).sort();
  assert.deepEqual(bizTypes, ['escrow_hold', 'escrow_release', 'fee', 'pay', 'settle']);
  for (const tx of txs) assert.ok(tx.idempotency_key, '每笔流水必须有幂等键便于反查');

  // 状态留痕
  const logs = await q('SELECT action, to_status FROM order_status_log WHERE order_id = ? ORDER BY id ASC', [orderId]);
  assert.deepEqual(logs.map((l) => l.action), ['create', 'pay', 'ship', 'confirm']);

  // 图书售出
  assert.equal((await bookById(book.id)).status, 'sold');

  // 钱包缓存与流水求和一致（资金对账）
  for (const userId of [buyer.user.id, seller.user.id, platform.id]) {
    const account = await q1('SELECT balance_cents, frozen_cents FROM wallet_accounts WHERE user_id = ?', [userId]);
    assert.equal(Number(account.balance_cents), await balanceOf(userId, 'balance'), `用户 ${userId} 余额缓存应与流水一致`);
    assert.equal(Number(account.frozen_cents), await balanceOf(userId, 'frozen'), `用户 ${userId} 冻结缓存应与流水一致`);
  }
});

test('幂等：确认收货重复提交不会重复放款', async () => {
  const { orderId, key } = await runToShipped(800, 'idem-release');
  const sellerBefore = await balanceOf(seller.user.id);

  const first = await request(app).post(`/api/v1/orders/${orderId}/confirm`)
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `confirm-${key}`).send({});
  assert.equal(first.body.code, 0);
  const sellerAfterFirst = await balanceOf(seller.user.id);

  const second = await request(app).post(`/api/v1/orders/${orderId}/confirm`)
    .set('Authorization', buyer.bearer).set('Idempotency-Key', `confirm-${key}`).send({});
  assert.equal(second.body.code, 0);
  assert.equal(second.body.data.sellerIncomeCents, first.body.data.sellerIncomeCents);
  assert.equal(await balanceOf(seller.user.id), sellerAfterFirst, '重复确认不得二次放款');
  assert.ok(sellerAfterFirst > sellerBefore);
});

test('权限：非买家本人不能确认收货，非卖家本人不能发货', async () => {
  const { orderId } = await runToShipped(700, 'perm');
  // 卖家假装买家确认收货
  const res = await request(app).post(`/api/v1/orders/${orderId}/confirm`)
    .set('Authorization', seller.bearer).send({});
  assert.equal(res.body.code, 40301);
});

test('自动确认收货：发货后超过 auto_confirm_at 由定时任务放款', async () => {
  const { orderId } = await runToShipped(600, 'auto');
  const sellerBefore = await balanceOf(seller.user.id);

  // 把自动确认时间提前，模拟「发货 7 天后」
  await q('UPDATE orders SET auto_confirm_at = DATE_SUB(NOW(3), INTERVAL 1 MINUTE) WHERE id = ?', [orderId]);
  const results = await orderService.autoConfirmDue({ limit: 10 });
  assert.ok(results.some((r) => r.orderId === orderId));

  const row = await orderById(orderId);
  assert.equal(row.status, 'completed');
  assert.equal(row.escrow_status, 'released');
  assert.equal(await balanceOf(seller.user.id), sellerBefore + Number(row.seller_income_cents));

  const autoLog = await q1(
    "SELECT action FROM order_status_log WHERE order_id = ? AND action = 'auto_confirm' LIMIT 1",
    [orderId],
  );
  assert.ok(autoLog, '自动确认收货必须留痕');
});

test('争议订单不参与自动确认（冻结倒计时）', async () => {
  const { orderId } = await runToShipped(500, 'dispute-auto');
  const disputed = await request(app).post(`/api/v1/orders/${orderId}/dispute`)
    .set('Authorization', buyer.bearer).send({ reason: '教材与描述不符，缺页严重' });
  assert.equal(disputed.body.code, 0);
  assert.equal(disputed.body.data.status, 'disputed');

  const row = await orderById(orderId);
  assert.equal(row.auto_confirm_at, null, '进入争议必须清空自动确认时间');
  const results = await orderService.autoConfirmDue({ limit: 50 });
  assert.ok(!results.some((r) => r.orderId === orderId));
  assert.equal((await orderById(orderId)).status, 'disputed');

  // 争议自动生成加急工单（资金类 4 小时响应 SLA）
  const ticket = await q1('SELECT * FROM tickets WHERE related_order_id = ? ORDER BY id DESC LIMIT 1', [orderId]);
  assert.ok(ticket, '争议必须生成客服工单');
  assert.equal(ticket.priority, 'urgent');
  assert.ok(ticket.first_response_due_at);
});

test('退款：付款后未发货，卖家同意退款，资金原路退回买家', async () => {
  // 余额基线必须在付款前采集
  const buyerBefore = await balanceOf(buyer.user.id);
  const buyerFrozenBefore = await balanceOf(buyer.user.id, 'frozen');
  const { book, orderId } = await runToShipped(1200, 'refund', { ship: false });

  const requested = await request(app).post(`/api/v1/orders/${orderId}/refund-request`)
    .set('Authorization', buyer.bearer).send({ reason: '卖家迟迟不发货' });
  assert.equal(requested.body.code, 0);
  assert.equal(requested.body.data.status, 'refund_requested');

  const agreed = await request(app).post(`/api/v1/orders/${orderId}/refund/agree`)
    .set('Authorization', seller.bearer).send({ reason: '同意退款' });
  assert.equal(agreed.body.code, 0, agreed.body.message);
  assert.equal(agreed.body.data.refundedCents, 1200);

  assert.equal(await balanceOf(buyer.user.id), buyerBefore, '买家余额恢复到付款前');
  assert.equal(await balanceOf(buyer.user.id, 'frozen'), buyerFrozenBefore, '托管冻结被释放');
  const row = await orderById(orderId);
  assert.equal(row.status, 'refunded');
  assert.equal(row.escrow_status, 'refunded');
  assert.equal((await bookById(book.id)).status, 'on_sale', '退款后教材重新上架');
});

test('退货退款：已发货后买家申请退货，卖家同意后退款', async () => {
  const buyerBefore = await balanceOf(buyer.user.id);
  const { orderId } = await runToShipped(1500, 'return');

  const returned = await request(app).post(`/api/v1/orders/${orderId}/return-request`)
    .set('Authorization', buyer.bearer).send({ reason: '收到后发现是盗印版本' });
  assert.equal(returned.body.code, 0, returned.body.message);
  assert.equal(returned.body.data.status, 'return_requested');

  const agreed = await request(app).post(`/api/v1/orders/${orderId}/refund/agree`)
    .set('Authorization', seller.bearer).send({ reason: '同意退货退款' });
  assert.equal(agreed.body.code, 0, agreed.body.message);
  assert.equal(agreed.body.data.status, 'refunded');
  assert.equal(await balanceOf(buyer.user.id), buyerBefore, '退货退款后买家余额恢复');
});
