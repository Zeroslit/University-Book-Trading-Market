// 集成测试：多校数据隔离与越权拦截（学校上下文只能由服务端决定）
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { auth, q, q1, closePool, SEED } from '../helpers/db.js';

const app = createApp();
let studentA; // 学校1
let studentB; // 学校2
let adminA; // 学校1 校管
let support; // 人工客服（无学校）
let platform; // 平台管理员
let school1Book;
let school2Book;
let school2Thread;
let school2Order;
let createdThreadId = null;

before(async () => {
  studentA = await auth(SEED.students.jiangnanSeller);
  studentB = await auth(SEED.students.zhengqing);
  adminA = await auth(SEED.staff.schoolAdmin);
  support = await auth(SEED.staff.support);
  platform = await auth(SEED.staff.platform);
  school1Book = await q1("SELECT id, school_id FROM books WHERE school_id = 1 AND deleted_at IS NULL ORDER BY id LIMIT 1");
  school2Book = await q1("SELECT id, school_id FROM books WHERE school_id = 2 AND deleted_at IS NULL ORDER BY id LIMIT 1");
  school2Order = await q1('SELECT id, school_id FROM orders WHERE school_id = 2 ORDER BY id LIMIT 1');

  // 种子数据里帖子都在学校1，这里用学校2 学生发一条真实帖子用于越权验证
  const created = await request(app).post('/api/v1/threads')
    .set('Authorization', studentB.bearer)
    .send({ type: 'seek', title: '测试求书帖（跨校越权用例）', content: '求《测试课程》教材一本，校内面交。' });
  assert.equal(created.body.code, 0, created.body.message);
  createdThreadId = created.body.data.threadId ?? created.body.data.id;
  school2Thread = { id: createdThreadId, school_id: 2 };
});

after(async () => {
  if (createdThreadId) {
    await q('DELETE FROM replies WHERE thread_id = ?', [createdThreadId]);
    await q('DELETE FROM threads WHERE id = ?', [createdThreadId]);
  }
  await closePool();
});

// 审计日志是异步写入（不阻塞主流程），这里做短暂轮询
async function waitForAudit(userId, action, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await q1(
      'SELECT * FROM audit_logs WHERE actor_id = ? AND action = ? ORDER BY id DESC LIMIT 1',
      [userId, action],
    );
    if (row) return row;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return null;
}

test('学生读取他校图书返回 404（不泄露数据是否存在）', async () => {
  const res = await request(app).get(`/api/v1/books/${school2Book.id}`).set('Authorization', studentA.bearer);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 40402);
});

test('学生显式传 schoolId 无法越权（服务端忽略客户端传参）', async () => {
  const res = await request(app)
    .get(`/api/v1/books/${school1Book.id}?schoolId=${school2Book.school_id}`)
    .set('Authorization', studentA.bearer);
  assert.equal(res.body.code, 0);
  assert.equal(Number(res.body.data.school_id ?? res.body.data.schoolId), Number(school1Book.school_id));

  // 传他校 schoolId 也读不到他校数据
  const cross = await request(app)
    .get(`/api/v1/books/${school2Book.id}?schoolId=1`)
    .set('Authorization', studentA.bearer);
  assert.equal(cross.body.code, 40402);
});

test('列表接口只返回本校数据', async () => {
  const res = await request(app).get('/api/v1/books?pageSize=50').set('Authorization', studentA.bearer);
  assert.equal(res.body.code, 0);
  assert.ok(res.body.data.list.length > 0);
  for (const book of res.body.data.list) {
    assert.equal(Number(book.school_id ?? book.schoolId), Number(studentA.user.school_id));
  }

  const threads = await request(app).get('/api/v1/threads?pageSize=50').set('Authorization', studentA.bearer);
  assert.equal(threads.body.code, 0);
  for (const thread of threads.body.data.list) {
    assert.equal(Number(thread.school_id ?? thread.schoolId ?? studentA.user.school_id), Number(studentA.user.school_id));
  }
});

test('他校帖子 / 订单同样返回 404', async () => {
  const thread = await request(app).get(`/api/v1/threads/${school2Thread.id}`).set('Authorization', studentA.bearer);
  assert.equal(thread.status, 404);

  const order = await request(app).get(`/api/v1/orders/${school2Order.id}`).set('Authorization', studentA.bearer);
  assert.equal(order.status, 404);
  assert.equal(order.body.code, 40403);
});

test('学生无权访问管理后台接口', async () => {
  const users = await request(app).get('/api/v1/admin/users').set('Authorization', studentA.bearer);
  assert.equal(users.status, 403);
  assert.equal(users.body.code, 40301);

  const verifications = await request(app).get('/api/v1/verifications').set('Authorization', studentA.bearer);
  assert.equal(verifications.status, 403);
});

test('跨校角色（客服/平台）不显式指定 schoolId 一律拒绝', async () => {
  for (const token of [support.bearer, platform.bearer]) {
    const res = await request(app).get('/api/v1/admin/dashboard').set('Authorization', token);
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 40302);
  }
});

test('客服指定 schoolId 只能看到该校数据，并留下跨校访问审计', async () => {
  const res = await request(app).get('/api/v1/admin/users?schoolId=2&pageSize=50').set('Authorization', support.bearer);
  assert.equal(res.body.code, 0);
  assert.ok(res.body.data.list.length > 0);
  for (const user of res.body.data.list) {
    const row = await q1('SELECT school_id FROM users WHERE id = ?', [user.id]);
    assert.equal(Number(row.school_id), 2);
  }

  const audit = await waitForAudit(support.user.id, 'cross_school_access');
  assert.ok(audit, '跨校访问必须留痕');
  assert.equal(Number(audit.school_id), 2);
});

test('校管只能管理本校：即使显式传他校 schoolId 也无效', async () => {
  const res = await request(app).get('/api/v1/admin/users?schoolId=2&pageSize=50').set('Authorization', adminA.bearer);
  assert.equal(res.body.code, 0);
  for (const user of res.body.data.list) {
    const row = await q1('SELECT school_id FROM users WHERE id = ?', [user.id]);
    assert.equal(Number(row.school_id), Number(studentA.user.school_id));
  }
});

test('图书详情不返回卖家敏感字段（手机号/学号脱敏）', async () => {
  const res = await request(app).get(`/api/v1/books/${school1Book.id}`).set('Authorization', studentA.bearer);
  assert.equal(res.body.code, 0);
  const seller = res.body.data.seller || {};
  assert.ok(!seller.phone, '禁止返回完整手机号');
  assert.ok(!seller.student_no, '禁止返回完整学号');
  const raw = JSON.stringify(res.body);
  assert.ok(!raw.includes('138000000'), '响应体不得包含完整手机号');
});

test('平台管理员可以查看学校列表并配置阈值（配置化，不写死）', async () => {
  const schools = await request(app).get('/api/v1/admin/schools').set('Authorization', platform.bearer);
  assert.equal(schools.body.code, 0);
  assert.ok(schools.body.data.length >= 3);

  const configs = await request(app).get('/api/v1/admin/configs').set('Authorization', platform.bearer);
  assert.equal(configs.body.code, 0);
  const keys = (configs.body.data.list || configs.body.data).map((c) => c.key ?? c.config_key ?? c.configKey);
  assert.ok(keys.includes('penalty.escalation'), '处罚梯度必须在 configs 中');
  assert.ok(keys.includes('banned_word.penalty'));
  assert.ok(keys.includes('ticket.sla'));
});
