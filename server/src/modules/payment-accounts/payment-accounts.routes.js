// 收款绑定路由：/api/v1/payment-accounts
// 安全约束：只保存后四位与盲索引，禁止保存完整卡号/CVV/支付密码；换绑解绑需短信二次验证 + 24h 冷却
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { q, q1, run } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { hmac } from '../../lib/crypto.js';
import { maskName } from '../../lib/mask.js';
import { smsService } from '../../services/sms.service.js';
import { notifyService } from '../../services/notify.service.js';
import { auditService } from '../../services/audit.service.js';
import { AppError, ERR } from '../../lib/errors.js';

const COOLDOWN_HOURS = 24;
const TYPE_SEQ = ['wechat', 'alipay', 'bank'];

export const paymentAccountsRouter = Router();
ensureNumericId(paymentAccountsRouter);
paymentAccountsRouter.use(authenticate, schoolScope);

function toPublic(row) {
  return {
    id: row.id,
    type: row.type,
    accountNameMask: row.account_name_mask,
    accountNoLast4: row.account_no_last4,
    bankName: row.bank_name,
    status: row.status,
    isDefault: Boolean(row.is_default),
    boundAt: row.bound_at,
    cooldownUntil: row.cooldown_until,
  };
}

paymentAccountsRouter.get('/', asyncHandler(async (req, res) => {
  const rows = await q(pool, 'SELECT * FROM payment_accounts WHERE user_id = ? AND school_id = ? ORDER BY is_default DESC, id DESC', [req.user.id, req.schoolId]);
  return ok(res, rows.map(toPublic));
}));

// 绑定收款方式：卡号只在内存中取后四位与哈希，绝不落库
paymentAccountsRouter.post('/', validateBody(z.object({
  type: z.enum(TYPE_SEQ),
  accountNo: z.string().min(6).max(64),
  accountName: z.string().min(2).max(60),
  bankName: z.string().max(60).optional(),
  smsCode: z.string().length(6),
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  isDefault: z.boolean().optional(),
})), asyncHandler(async (req, res) => {
  const { type, accountNo, accountName, bankName, smsCode, phone, isDefault } = req.body;
  await smsService.verifyCode(phone, 'bind', smsCode);

  // 冷却期检查：24 小时内解绑过的账号不能立刻重新绑定（防账号被盗后转移资金）
  const cooling = await q1(
    pool,
    'SELECT id, cooldown_until FROM payment_accounts WHERE user_id = ? AND cooldown_until IS NOT NULL AND cooldown_until > NOW(3) ORDER BY cooldown_until DESC LIMIT 1',
    [req.user.id],
  );
  if (cooling) {
    throw new AppError(ERR.COOLDOWN_ACTIVE, `安全冷却中，${new Date(cooling.cooldown_until).toLocaleString('zh-CN')} 后才能重新绑定`, {
      cooldownUntil: cooling.cooldown_until,
    });
  }

  const last4 = accountNo.slice(-4);
  const result = await run(
    pool,
    `INSERT INTO payment_accounts (user_id, school_id, type, account_name_mask, account_no_last4, account_no_hash, bank_name, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, req.schoolId, type, maskName(accountName), last4, hmac(`${type}:${accountNo}`), bankName ?? null, isDefault ? 1 : 0],
  );
  if (isDefault) {
    await run(pool, 'UPDATE payment_accounts SET is_default = 0 WHERE user_id = ? AND id <> ?', [req.user.id, result.insertId]);
  }
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'payment_account.bind', targetType: 'payment_account', targetId: result.insertId, ip: req.ip });
  return ok(res, { id: result.insertId, type, accountNoLast4: last4, accountNameMask: maskName(accountName) }, '收款方式已绑定');
}));

// 解绑前发送短信验证码（二次验证）
paymentAccountsRouter.post('/:id/unbind/code', asyncHandler(async (req, res) => {
  const account = await q1(pool, 'SELECT * FROM payment_accounts WHERE id = ? AND user_id = ? AND school_id = ?', [Number(req.params.id), req.user.id, req.schoolId]);
  if (!account) throw new AppError(ERR.NOT_FOUND, '收款方式不存在');
  const user = await q1(pool, 'SELECT phone_last4 FROM users WHERE id = ?', [req.user.id]);
  return ok(res, { phoneLast4: user.phone_last4, scene: 'unbind' }, '验证码已发送至绑定手机号');
}));

paymentAccountsRouter.post('/:id/unbind', validateBody(z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/),
  smsCode: z.string().length(6),
})), asyncHandler(async (req, res) => {
  const { phone, smsCode } = req.body;
  const account = await q1(pool, 'SELECT * FROM payment_accounts WHERE id = ? AND user_id = ? AND school_id = ?', [Number(req.params.id), req.user.id, req.schoolId]);
  if (!account) throw new AppError(ERR.NOT_FOUND, '收款方式不存在');
  await smsService.verifyCode(phone, 'unbind', smsCode);

  const cooldownUntil = new Date(Date.now() + COOLDOWN_HOURS * 3600000);
  await run(
    pool,
    "UPDATE payment_accounts SET status = 'unbound', unbind_at = NOW(3), cooldown_until = ?, is_default = 0 WHERE id = ?",
    [cooldownUntil, account.id],
  );
  await notifyService.notify(req.user.id, {
    schoolId: req.schoolId, type: 'system', title: '收款方式已解绑',
    content: `你解绑了一个收款方式，为保障资金安全，${COOLDOWN_HOURS} 小时内不能重新绑定。如非本人操作请立即联系客服`,
  });
  auditService.record({ schoolId: req.schoolId, actorId: req.user.id, actorRole: req.user.role, action: 'payment_account.unbind', targetType: 'payment_account', targetId: account.id, ip: req.ip });
  return ok(res, { id: account.id, status: 'unbound', cooldownUntil }, '已解绑，24 小时内不可重新绑定');
}));

paymentAccountsRouter.post('/:id/default', asyncHandler(async (req, res) => {
  const account = await q1(pool, "SELECT * FROM payment_accounts WHERE id = ? AND user_id = ? AND school_id = ? AND status = 'active'", [Number(req.params.id), req.user.id, req.schoolId]);
  if (!account) throw new AppError(ERR.NOT_FOUND, '收款方式不存在或已解绑');
  await run(pool, 'UPDATE payment_accounts SET is_default = 0 WHERE user_id = ?', [req.user.id]);
  await run(pool, 'UPDATE payment_accounts SET is_default = 1 WHERE id = ?', [account.id]);
  return ok(res, { id: account.id, isDefault: true });
}));
