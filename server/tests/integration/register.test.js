// 集成测试：注册 / 登录 / 唯一性约束 / 认证前仅可浏览
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { hmac } from '../../src/lib/crypto.js';
import { q, q1, closePool, bumpSensitiveRateLimit } from '../helpers/db.js';

const app = createApp();
const PASSWORD = 'Test@123456';
const DEV_CODE = '123456';
const stamp = `${Date.now()}`.slice(-7);
const studentNo = `S${stamp}`;

function randomPhone() {
  return `139${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
}

const phones = { a: randomPhone(), b: randomPhone(), c: randomPhone() };
let previousSmsLimit;
let userA;

async function sendCode(phone, scene = 'register') {
  const res = await request(app).post('/api/v1/auth/sms/send').send({ phone, scene });
  assert.equal(res.body.code, 0, res.body.message);
}

before(async () => {
  previousSmsLimit = await bumpSensitiveRateLimit('sms', 200);
});

after(async () => {
  for (const phone of Object.values(phones)) {
    const rows = await q('SELECT id FROM users WHERE phone_hash = ?', [hmac(phone)]);
    for (const row of rows) {
      await q('DELETE FROM user_verifications WHERE user_id = ?', [row.id]);
      await q('DELETE FROM wallet_accounts WHERE user_id = ?', [row.id]);
      await q('DELETE FROM notifications WHERE user_id = ?', [row.id]);
      await q('DELETE FROM credit_logs WHERE user_id = ?', [row.id]);
      await q('DELETE FROM users WHERE id = ?', [row.id]);
    }
  }
  if (previousSmsLimit !== undefined) await bumpSensitiveRateLimit('sms', previousSmsLimit);
  await closePool();
});

test('注册：学校下拉选择 + 学号 + 手机号验证码 + 密码，认证状态为待认证', async () => {
  await sendCode(phones.a);
  const res = await request(app).post('/api/v1/auth/register').send({
    schoolId: 1, studentNo, phone: phones.a, code: DEV_CODE, password: PASSWORD, nickname: '注册测试同学',
  });
  assert.equal(res.body.code, 0, res.body.message);
  userA = res.body.data;
  assert.ok(userA.accessToken);
  assert.equal(userA.user.verificationStatus, 'unverified');
  assert.equal(userA.needVerification, true);
  assert.ok(!JSON.stringify(res.body).includes(phones.a), '响应不得回显完整手机号');
});

test('唯一性：学号在同一学校内唯一，手机号全平台唯一', async () => {
  // 同学号 + 同学校 -> 拒绝
  await sendCode(phones.b);
  const dupStudent = await request(app).post('/api/v1/auth/register').send({
    schoolId: 1, studentNo, phone: phones.b, code: DEV_CODE, password: PASSWORD,
  });
  assert.equal(dupStudent.body.code, 40902);

  // 同学号 + 不同学校 -> 允许（多校架构下学号不冲突）
  await sendCode(phones.c);
  const otherSchool = await request(app).post('/api/v1/auth/register').send({
    schoolId: 2, studentNo, phone: phones.c, code: DEV_CODE, password: PASSWORD,
  });
  assert.equal(otherSchool.body.code, 0, otherSchool.body.message);

  // 同手机号（全平台唯一）-> 拒绝
  const dupPhone = await request(app).post('/api/v1/auth/register').send({
    schoolId: 2, studentNo: `X${stamp}`, phone: phones.a, code: DEV_CODE, password: PASSWORD,
  });
  assert.ok([40002, 40901].includes(dupPhone.body.code), `实际 ${dupPhone.body.code}`);
});

test('验证码错误或未发送时注册被拒绝', async () => {
  const phone = randomPhone();
  const res = await request(app).post('/api/v1/auth/register').send({
    schoolId: 1, studentNo: `Y${stamp}`, phone, code: '000000', password: PASSWORD,
  });
  assert.equal(res.body.code, 40002);
});

test('认证前仅可浏览：可以看图书库，不能发布', async () => {
  const token = userA.accessToken;
  const browse = await request(app).get('/api/v1/books').set('Authorization', `Bearer ${token}`);
  assert.equal(browse.body.code, 0);

  const publish = await request(app).post('/api/v1/threads')
    .set('Authorization', `Bearer ${token}`)
    .send({ type: 'seek', title: '未认证用户测试发帖', content: '这条内容不应该发布成功。' });
  assert.equal(publish.body.code, 40304);
});

test('登录成功后返回学校信息（前端据此直接进入本校图书库与论坛）', async () => {
  const res = await request(app).post('/api/v1/auth/login').send({ phone: phones.a, password: PASSWORD });
  assert.equal(res.body.code, 0, res.body.message);
  assert.ok(res.body.data.accessToken);
  assert.equal(res.body.data.user.schoolId, 1);

  const me = await request(app).get('/api/v1/auth/me').set('Authorization', `Bearer ${res.body.data.accessToken}`);
  assert.equal(me.body.code, 0);
  assert.equal(me.body.data.school.name, '江南大学');
  assert.ok(Array.isArray(me.body.data.school.forum_sections) || typeof me.body.data.school.forum_sections === 'object');

  const wrong = await request(app).post('/api/v1/auth/login').send({ phone: phones.a, password: 'WrongPass123' });
  assert.equal(wrong.body.code, 40104);
});

test('学校主数据：按省份城市搜索 + 申请开通入口', async () => {
  const list = await request(app).get('/api/v1/schools?province=江苏省');
  assert.equal(list.body.code, 0);
  assert.ok(list.body.data.list.length >= 1);
  assert.ok(list.body.data.list.every((s) => s.province === '江苏省'));

  const provinces = await request(app).get('/api/v1/schools/provinces');
  assert.equal(provinces.body.code, 0);

  // 找不到学校：提交开通申请
  const applyPhone = `138${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const apply = await request(app).post('/api/v1/schools/applications').send({
    schoolName: `测试大学${stamp}`, province: '测试省', city: '测试市',
    applicantName: '测试老师', phone: applyPhone, note: '学校未开通，申请入驻',
  });
  assert.equal(apply.body.code, 0, apply.body.message);
  await q('DELETE FROM school_applications WHERE applicant_phone_hash = ?', [hmac(applyPhone)]);
});
