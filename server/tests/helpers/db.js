// 集成测试辅助：复用应用的数据库连接池与鉴权实现，保证测的就是线上同一套逻辑
// 前置：先执行 npm run db:reset（种子数据），测试只补充自己的夹具数据，不依赖执行顺序
import { pool, query, queryOne, closePool } from '../../src/db/pool.js';
import { hmac } from '../../src/lib/crypto.js';
import { signTokens } from '../../src/middleware/auth.js';
import { redis } from '../../src/services/redis.service.js';

export { pool, closePool };
export const q = query;
export const q1 = queryOne;

// 种子账号（统一密码 Test@123456，见 src/db/seed.js）
export const SEED = {
  password: 'Test@123456',
  students: {
    jiangnanSeller: '13800000001', // 学校1 林晓（卖家，无钱包余额）
    jiangnanBuyer: '13800000002', // 学校1 陈默（买家，余额 18000 分）
    jiangnanPending: '13800000003', // 学校1 王雨（认证待审核）
    zhengqing: '13800000004', // 学校2 赵磊
    chengli: '13800000007', // 学校3 李文
    chengliB: '13800000008', // 学校3 郑一
    chengliC: '13800000009', // 学校3 高远
  },
  staff: {
    schoolAdmin: '13900000001', // 学校1 校管
    support: '13900000002', // 人工客服（无 school_id）
    platform: '13900000003', // 平台管理员
  },
};

export async function userByPhone(phone) {
  return q1(
    `SELECT id, school_id, role, nickname, credit_score, verification_status, status
       FROM users WHERE phone_hash = ? AND deleted_at IS NULL`,
    [hmac(phone)],
  );
}

// 直接签发令牌（避开登录接口限流，聚焦被测逻辑；登录流程另有专门用例）
export async function auth(phone) {
  const user = await userByPhone(phone);
  if (!user) throw new Error(`测试账号不存在：${phone}，请先执行 npm run db:reset`);
  const { accessToken } = signTokens(user);
  return { user, token: accessToken, bearer: `Bearer ${accessToken}` };
}

export function json(token) {
  return { Authorization: token.startsWith('Bearer ') ? token : `Bearer ${token}`, 'Content-Type': 'application/json' };
}

// 造一本在售教材（不经过发布接口，避免限流与违禁词干扰）
export async function makeBook({ schoolId, sellerId, priceCents = 1000, title = null, status = 'on_sale' }) {
  const finalTitle = title || `测试教材-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const result = await query(
    `INSERT INTO books (school_id, seller_id, title, author, publisher, course_name, condition_level,
       original_price_cents, price_cents, status, published_at)
     VALUES (?, ?, ?, '测试作者', '测试出版社', '测试课程', 'like_new', ?, ?, ?, NOW(3))`,
    [schoolId, sellerId, finalTitle, priceCents + 500, priceCents, status],
  );
  return { id: result.insertId, title: finalTitle, priceCents };
}

export async function bookById(id) {
  return q1('SELECT * FROM books WHERE id = ?', [id]);
}

export async function orderById(id) {
  return q1('SELECT * FROM orders WHERE id = ?', [id]);
}

// 钱包口径：以流水求和为准（wallet_accounts 只是派生缓存）
export async function balanceOf(userId, account = 'balance') {
  const row = await q1(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END), 0) AS total
       FROM wallet_transactions WHERE user_id = ? AND account = ? AND status = 'success'`,
    [userId, account],
  );
  return Number(row.total);
}

export async function transactionsOfOrder(orderId) {
  return q('SELECT * FROM wallet_transactions WHERE order_id = ? ORDER BY id ASC', [orderId]);
}

export async function platformAccount() {
  return q1("SELECT id, school_id FROM users WHERE role = 'platform_admin' AND deleted_at IS NULL ORDER BY id ASC LIMIT 1");
}

// 每轮清理：把用户信誉分/封禁开关复位，避免测试间互相影响
export async function resetUserRisk(userId) {
  await query(
    `UPDATE users SET mute_until = NULL, trade_ban_until = NULL, login_ban_until = NULL,
       banned_permanently = 0, status = 'active' WHERE id = ?`,
    [userId],
  );
}

export async function setCredit(userId, schoolId, score) {
  await query('UPDATE users SET credit_score = ? WHERE id = ? AND school_id = ?', [score, userId, schoolId]);
}

// 清理限流计数（内存/Redis 均可用）
export async function clearRateLimit(scene, identity) {
  await redis.del(`rl:${scene}:${identity}`);
}

// 临时放宽敏感接口限流（并发用例需要一次打满），返回原值用于还原
// 必须在文件内发出第一个请求之前调用，避免 configService 进程内缓存命中旧值
export async function bumpSensitiveRateLimit(scene, max) {
  const row = await q1(
    "SELECT id, config_value FROM configs WHERE scope = 'platform' AND config_key = 'rate_limit.sensitive' LIMIT 1",
  );
  const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value;
  const previous = value[scene];
  value[scene] = max;
  await query("UPDATE configs SET config_value = CAST(? AS JSON) WHERE id = ?", [JSON.stringify(value), row.id]);
  await redis.del('cfg:platform:rate_limit.sensitive');
  return previous;
}

// 用 title 前缀清理本次测试造的数据（订单先删日志，再删订单，最后删书）
export async function deleteBooksByTitlePrefix(prefix) {
  const books = await q('SELECT id FROM books WHERE title LIKE ?', [`${prefix}%`]);
  const ids = books.map((b) => b.id);
  if (ids.length === 0) return 0;
  const marks = ids.map(() => '?').join(',');
  await query(`DELETE FROM book_images WHERE book_id IN (${marks})`, ids);
  await query(`DELETE FROM books WHERE id IN (${marks})`, ids);
  return ids.length;
}

export async function cleanupByTitlePrefix(prefix = '测试教材-') {
  const books = await q('SELECT id FROM books WHERE title LIKE ?', [`${prefix}%`]);
  const ids = books.map((b) => b.id);
  if (ids.length === 0) return 0;
  const marks = ids.map(() => '?').join(',');
  const orders = await q(`SELECT id FROM orders WHERE book_id IN (${marks})`, ids);
  if (orders.length > 0) {
    const orderIds = orders.map((o) => o.id);
    const omarks = orderIds.map(() => '?').join(',');
    await query(`DELETE FROM order_status_log WHERE order_id IN (${omarks})`, orderIds);
    // 资金流水保留（append-only 是审计事实来源），只解绑测试订单，保证钱包对账仍然成立
    await query(`UPDATE wallet_transactions SET order_id = NULL WHERE order_id IN (${omarks})`, orderIds);
    await query(`UPDATE notifications SET related_id = NULL WHERE related_type = 'order' AND related_id IN (${omarks})`, orderIds).catch(() => {});
    await query(`DELETE FROM idempotency_records WHERE scope LIKE 'order.%' AND response_snapshot IS NOT NULL AND JSON_EXTRACT(response_snapshot, '$.id') IN (${omarks})`, orderIds).catch(() => {});
    await query(`DELETE FROM orders WHERE id IN (${omarks})`, orderIds);
  }
  await query(`DELETE FROM book_images WHERE book_id IN (${marks})`, ids);
  await query(`DELETE FROM books WHERE id IN (${marks})`, ids);
  return ids.length;
}
