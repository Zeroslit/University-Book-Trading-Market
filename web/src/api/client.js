// 统一请求封装：注入 JWT / 幂等键 / 学校上下文，统一错误码处理与登录失效跳转
// 演示模式（VITE_DEMO=true）下不发真实请求，改为调用浏览器内的模拟后端（web/src/demo/server.js），
// 路径、参数、错误码与真实后端完全一致，因此页面代码零改动。
import axios from 'axios';

export const TOKEN_KEY = 'campus_book_token';
export const REFRESH_KEY = 'campus_book_refresh';
export const REQUEST_ID_HEADER = 'X-Request-Id';

// 是否为纯静态演示构建（GitHub Pages 等无后端环境）
export const IS_DEMO = String(import.meta.env.VITE_DEMO) === 'true';

export class ApiError extends Error {
  constructor(code, message, details, requestId) {
    super(message || '请求失败');
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

// ---------------- 演示模式：浏览器内模拟后端 ----------------
let demoHandleRequest = null;

async function loadDemoBackend() {
  if (!demoHandleRequest) {
    const mod = await import('../demo/server.js');
    demoHandleRequest = mod.handleRequest;
  }
  return demoHandleRequest;
}

function toQueryString(params) {
  if (!params) return '';
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    search.append(key, String(value));
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

const demoHttp = {
  async request(method, url, body, options = {}) {
    const handleRequest = await loadDemoBackend();
    const headers = { ...(options.headers || {}) };
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    try {
      const envelope = await handleRequest({
        method,
        url: url + toQueryString(options.params),
        body: body ?? {},
        headers,
      });
      return envelope.data;
    } catch (err) {
      if (err && typeof err.code === 'number') throw new ApiError(err.code, err.message, err.details, null);
      throw new ApiError(50000, err?.message || '演示环境处理失败，请刷新重试');
    }
  },
  get(url, options) { return this.request('GET', url, null, options); },
  post(url, body, options) { return this.request('POST', url, body, options); },
  put(url, body, options) { return this.request('PUT', url, body, options); },
  patch(url, body, options) { return this.request('PATCH', url, body, options); },
  delete(url, options) { return this.request('DELETE', url, null, options); },
};

// ---------------- 真实模式：axios ----------------
const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // 资金/下单等写操作建议带幂等键：调用方可通过 options.idempotencyKey 指定
  if (config.idempotencyKey) config.headers['Idempotency-Key'] = config.idempotencyKey;
  return config;
});

http.interceptors.response.use(
  (res) => {
    const body = res.data;
    if (body && typeof body.code === 'number' && body.code !== 0) {
      return Promise.reject(new ApiError(body.code, body.message, body.details, body.requestId));
    }
    return body?.data ?? null;
  },
  (error) => {
    const body = error.response?.data;
    if (body?.code) return Promise.reject(new ApiError(body.code, body.message, body.details, body.requestId));
    const message = error.code === 'ECONNABORTED' ? '请求超时，请重试' : '网络异常，请检查后端服务是否启动';
    return Promise.reject(new ApiError(50000, message));
  },
);

export function setTokens({ accessToken, refreshToken }) {
  if (accessToken) localStorage.setItem(TOKEN_KEY, accessToken);
  if (refreshToken) localStorage.setItem(REFRESH_KEY, refreshToken);
}

export function clearTokens() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(REFRESH_KEY);
}

export function hasToken() {
  return Boolean(localStorage.getItem(TOKEN_KEY));
}

export default IS_DEMO ? demoHttp : http;
