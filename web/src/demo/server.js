// 演示版模拟后端：在浏览器内按真实接口契约处理请求（路径、参数、错误码、响应体与后端一致）
import { AppError, ERR } from './vendor.js';
import { save, table } from './store.js';
import { registerAccountRoutes } from './handlers/account.js';
import { registerBookRoutes } from './handlers/books.js';
import { registerForumRoutes } from './handlers/forum.js';
import { registerTradeRoutes } from './handlers/trade.js';
import { registerRiskRoutes } from './handlers/risk.js';
import { registerAdminRoutes } from './handlers/admin.js';
import { registerUploadRoutes } from './handlers/uploads.js';

const routes = [];
let registered = false;

export function route(method, path, handler, options = {}) {
  const keys = [];
  const pattern = path.replace(/:([A-Za-z_]+)/g, (_, key) => {
    keys.push(key);
    return '([^/]+)';
  });
  routes.push({ method, path, keys, regex: new RegExp(`^${pattern}$`), handler, options });
}

function registerAll() {
  if (registered) return;
  registered = true;
  // 具体路径先注册，避免被 /:id 之类的通配规则抢先匹配
  registerAccountRoutes(route);
  registerBookRoutes(route);
  registerForumRoutes(route);
  registerTradeRoutes(route);
  registerRiskRoutes(route);
  registerAdminRoutes(route);
  registerUploadRoutes(route);
}

// ---------------- 上下文与守卫 ----------------
function decodeToken(headers) {
  const raw = headers?.Authorization || headers?.authorization || '';
  const token = String(raw).replace(/^Bearer\s+/i, '').trim();
  if (!token.startsWith('demo-token.')) return null;
  return Number(token.split('.')[1]) || null;
}

function requireUser(ctx) {
  if (!ctx.user) throw new AppError(ERR.UNAUTHORIZED, '登录已失效，请重新登录');
  if (ctx.user.banned_permanently) throw new AppError(ERR.LOGIN_BANNED, '账号已被永久封禁，如有疑问可提交申诉');
  if (ctx.user.login_ban_until && new Date(ctx.user.login_ban_until) > new Date()) {
    throw new AppError(ERR.LOGIN_BANNED, `账号处于封禁状态，解禁时间：${new Date(ctx.user.login_ban_until).toLocaleString('zh-CN')}`, {
      until: ctx.user.login_ban_until, appealAvailable: true,
    });
  }
  return ctx.user;
}

// 学校上下文：学生/校管取登录态学校；客服/平台管理员必须显式传 schoolId（跨校）
const PLATFORM_GLOBAL_PATHS = [/^\/admin\/schools(\/|$)/, /^\/admin\/configs(\/|$)/, /^\/admin\/audit-logs(\/|$)/];

export function schoolIdOf(ctx, { required = true } = {}) {
  const user = requireUser(ctx);
  if (user.role === 'support' || user.role === 'platform_admin') {
    const raw = ctx.query.schoolId ?? ctx.body?.schoolId ?? ctx.params?.schoolId;
    const sid = Number(raw);
    if (!Number.isFinite(sid) || sid <= 0) {
      if (user.role === 'platform_admin' && PLATFORM_GLOBAL_PATHS.some((re) => re.test(ctx.path))) return null;
      if (!required) return null;
      throw new AppError(ERR.SCHOOL_REQUIRED, '跨校角色访问必须显式指定 schoolId（请在顶部选择学校）', { path: '/admin/schools' });
    }
    return sid;
  }
  return Number(user.school_id);
}

export function isModerator(user) {
  return ['school_admin', 'support', 'platform_admin'].includes(user?.role);
}

export function requireModerator(ctx) {
  const user = requireUser(ctx);
  if (!isModerator(user)) throw new AppError(ERR.FORBIDDEN, '仅管理员或客服可执行该操作');
  const schoolId = schoolIdOf(ctx);
  if (user.role === 'school_admin' && Number(user.school_id) !== Number(schoolId)) {
    throw new AppError(ERR.FORBIDDEN, '校管只能管理本校数据');
  }
  return user;
}

export function requireRoles(ctx, roles) {
  const user = requireUser(ctx);
  if (!roles.includes(user.role)) throw new AppError(ERR.FORBIDDEN, '当前角色无权访问该接口');
  return user;
}

function assertNumericParams(params) {
  for (const [key, value] of Object.entries(params)) {
    if (!/^(id|.*Id|.*_id)$/.test(key)) continue;
    if (!/^\d+$/.test(String(value))) {
      throw new AppError(ERR.VALIDATION_ERROR, `参数 ${key} 必须为数字`);
    }
  }
}

// ---------------- 请求分发 ----------------
export async function handleRequest({ method, url, body, headers }) {
  registerAll();
  const [pathname, search] = String(url).split('?');
  const query = Object.fromEntries(new URLSearchParams(search || ''));

  const matched = routes.filter((r) => r.method === method && r.regex.test(pathname));
  if (matched.length === 0) {
    throw new AppError(ERR.NOT_FOUND, `演示环境未实现该接口：${method} ${pathname}`);
  }

  let lastError = null;
  for (const item of matched) {
    const execResult = item.regex.exec(pathname);
    const params = {};
    item.keys.forEach((key, i) => { params[key] = decodeURIComponent(execResult[i + 1]); });
    try {
      assertNumericParams(params);
    } catch (err) {
      throw err;
    }

    const ctx = {
      params, query, body: body ?? {}, headers: headers || {},
      userId: decodeToken(headers),
      method, path: pathname,
      get user() {
        if (this.userId === null || this.userId === undefined) return null;
        return table('users').find((u) => Number(u.id) === Number(this.userId)) || null;
      },
      schoolId: null,
    };

    if (!item.options.public) requireUser(ctx);
    ctx.schoolId = item.options.schoolScope === false ? null : schoolIdOf(ctx);
    if (item.options.roles) requireRoles(ctx, item.options.roles);
    if (item.options.moderator) requireModerator(ctx);

    try {
      const data = await item.handler(ctx);
      if (method !== 'GET') save();
      return { code: 0, message: item.options.message || 'ok', data: data === undefined ? null : data, requestId: null };
    } catch (err) {
      lastError = err;
      if (err instanceof AppError) throw err;
      throw err;
    }
  }
  throw lastError || new AppError(ERR.NOT_FOUND, '接口不存在');
}

export { routes };
