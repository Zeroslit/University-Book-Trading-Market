// 钱包路由：/api/v1/wallet（一期为模拟充值/提现，不接入真实支付）
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../lib/async-handler.js';
import { ok, paged } from '../../lib/response.js';
import { validateBody, ensureNumericId } from '../../middleware/validate.js';
import { authenticate } from '../../middleware/auth.js';
import { schoolScope } from '../../middleware/school-scope.js';
import { rateLimit } from '../../middleware/rate-limit.js';
import { q1 } from '../../db/tx.js';
import { pool } from '../../db/pool.js';
import { getIdempotencyKey } from '../../lib/idempotency.js';
import { parsePagination } from '../../lib/pagination.js';
import { walletService } from '../../services/wallet.service.js';
import { creditService } from '../../services/credit.service.js';
import { notifyService } from '../../services/notify.service.js';

export const walletRouter = Router();
ensureNumericId(walletRouter);
walletRouter.use(authenticate, schoolScope);

walletRouter.get('/', asyncHandler(async (req, res) => {
  const account = await walletService.account(req.user.id);
  const permissions = await creditService.getPermissions(req.schoolId, req.user.id);
  const escrow = await q1(
    pool,
    `SELECT COALESCE(SUM(CASE WHEN account = 'frozen' THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0) AS frozen
     FROM wallet_transactions WHERE user_id = ? AND status = 'success'`,
    [req.user.id],
  );
  return ok(res, {
    ...account,
    frozenCents: Number(escrow.frozen),
    creditTier: permissions.tier,
    withdrawDelayHours: permissions.withdrawDelayHours,
    withdrawInstant: permissions.withdrawDelayHours === 0,
  });
}));

walletRouter.get('/transactions', asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const data = await walletService.transactions(req.user.id, {
    orderId: req.query.orderId ? Number(req.query.orderId) : null,
    bizType: req.query.bizType ?? null, page, pageSize,
  });
  return ok(res, paged(data.list, data.total, page, pageSize));
}));

// 模拟充值（幂等）
walletRouter.post('/recharge', rateLimit('withdraw'), validateBody(z.object({
  amountCents: z.number().int().min(100).max(500000),
})), asyncHandler(async (req, res) => {
  const result = await walletService.recharge({
    userId: req.user.id, schoolId: req.schoolId, amountCents: req.body.amountCents,
    idempotencyKey: `recharge:${req.user.id}:${getIdempotencyKey(req) || `auto:${Date.now()}`}`,
  });
  return ok(res, result, result.idempotent ? '重复请求，已忽略' : '充值成功（模拟）');
}));

// 提现：必须已绑定收款方式 + 已认证；档位决定到账时效
walletRouter.post('/withdraw', rateLimit('withdraw'), validateBody(z.object({
  amountCents: z.number().int().min(100),
  paymentAccountId: z.number().int().positive(),
})), asyncHandler(async (req, res) => {
  const permissions = await creditService.getPermissions(req.schoolId, req.user.id);
  const result = await walletService.withdraw({
    userId: req.user.id, schoolId: req.schoolId, amountCents: req.body.amountCents,
    paymentAccountId: req.body.paymentAccountId, permissions,
    idempotencyKey: `withdraw:${req.user.id}:${getIdempotencyKey(req) || `auto:${Date.now()}`}`,
  });
  await notifyService.notify(req.user.id, {
    schoolId: req.schoolId, type: 'withdraw', title: '提现申请已提交',
    content: `提现 ${(result.amountCents / 100).toFixed(2)} 元，${result.arrivalType === 'instant' ? '预计即时到账' : `预计 ${new Date(result.expectAt).toLocaleString('zh-CN')} 到账`}`,
  });
  return ok(res, result, '提现申请已提交');
}));

walletRouter.get('/withdrawals', asyncHandler(async (req, res) => {
  const { page, pageSize } = parsePagination(req.query);
  const data = await walletService.listWithdrawals(req.user.id, { page, pageSize });
  return ok(res, paged(data.list, data.total, page, pageSize));
}));
