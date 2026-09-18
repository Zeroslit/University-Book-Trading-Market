// Express 应用装配：中间件 -> 业务路由 -> 统一错误处理
// 约定：业务接口统一挂载在 /api/v1，响应体固定为 { code, message, data, requestId }
import express from 'express';
import path from 'node:path';
import { config } from './config/index.js';
import { requestId } from './middleware/request-id.js';
import { notFoundHandler, errorHandler } from './middleware/error-handler.js';
import { healthCheck } from './db/pool.js';
import { redis } from './services/redis.service.js';

// 业务路由
import { authRouter } from './modules/auth/auth.routes.js';
import { schoolsRouter } from './modules/schools/schools.routes.js';
import { usersRouter } from './modules/users/users.routes.js';
import { verificationsRouter } from './modules/verifications/verifications.routes.js';
import { paymentAccountsRouter } from './modules/payment-accounts/payment-accounts.routes.js';
import { uploadsRouter } from './modules/uploads/uploads.routes.js';
import { booksRouter } from './modules/books/books.routes.js';
import { threadsRouter, repliesRouter } from './modules/threads/threads.routes.js';
import { conversationsRouter } from './modules/conversations/conversations.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { walletRouter } from './modules/wallet/wallet.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { reportsRouter, appealsRouter } from './modules/reports/reports.routes.js';
import { wordsRouter, adminWordsRouter } from './modules/words/words.routes.js';
import { kbRouter } from './modules/kb/kb.routes.js';
import { ticketsRouter } from './modules/tickets/tickets.routes.js';
import { chatRouter } from './modules/chat/chat.routes.js';
import { adminRouter } from './modules/admin/admin.routes.js';

// 跨域：开发期允许 Vite 5173 直连；生产建议由 Nginx 同域反代并关闭 CORS
function corsMiddleware(req, res, next) {
  const origin = req.get('Origin');
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Idempotency-Key,X-Request-Id,X-School-Id');
  res.setHeader('Access-Control-Expose-Headers', 'X-Request-Id,X-RateLimit-Limit,X-RateLimit-Remaining');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

// 基础安全响应头（无第三方依赖）
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  return next();
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', true);
  app.set('etag', false);

  app.use(requestId);
  app.use(securityHeaders);
  app.use(corsMiddleware);
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  // 上传图片静态访问：库中只存 URL，物理文件按天分目录
  app.use('/static', express.static(path.resolve(process.cwd(), config.upload.dir), {
    index: false, dotfiles: 'deny', maxAge: '7d', fallthrough: true,
  }));

  app.get('/health', async (req, res) => {
    const dbOk = await healthCheck();
    const data = {
      service: config.appName,
      env: config.env,
      db: dbOk ? 'up' : 'down',
      redis: redis.status(),
      time: new Date().toISOString(),
    };
    return res.status(dbOk ? 200 : 503).json({
      code: dbOk ? 0 : 50003,
      message: dbOk ? 'ok' : '依赖服务不可用',
      data,
      requestId: res.locals.requestId || null,
    });
  });

  const api = express.Router();
  api.use('/auth', authRouter);
  api.use('/schools', schoolsRouter);
  api.use('/users', usersRouter);
  api.use('/verifications', verificationsRouter);
  api.use('/payment-accounts', paymentAccountsRouter);
  api.use('/uploads', uploadsRouter);
  api.use('/books', booksRouter);
  api.use('/threads', threadsRouter);
  api.use('/replies', repliesRouter);
  api.use('/conversations', conversationsRouter);
  api.use('/notifications', notificationsRouter);
  api.use('/wallet', walletRouter);
  api.use('/orders', ordersRouter);
  api.use('/reports', reportsRouter);
  api.use('/appeals', appealsRouter);
  api.use('/words', wordsRouter);
  api.use('/kb', kbRouter);
  api.use('/tickets', ticketsRouter);
  api.use('/chat', chatRouter);
  // 注意：/admin/banned-words 必须挂载在 /admin 之前，否则会被 adminRouter 的 404 兜底截获
  api.use('/admin/banned-words', adminWordsRouter);
  api.use('/admin', adminRouter);

  // 接口清单（便于本地联调时快速自检）
  api.get('/', (req, res) => res.json({
    code: 0,
    message: 'ok',
    data: { service: config.appName, version: 'v1', docs: 'docs/05-接口清单.md' },
    requestId: res.locals.requestId || null,
  }));

  app.use('/api/v1', api);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

export const app = createApp();
export default app;
