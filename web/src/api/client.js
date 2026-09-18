// 统一请求封装：注入 JWT / 幂等键 / 学校上下文，统一错误码处理与登录失效跳转
import axios from 'axios';

export const TOKEN_KEY = 'campus_book_token';
export const REFRESH_KEY = 'campus_book_refresh';
export const REQUEST_ID_HEADER = 'X-Request-Id';

const http = axios.create({ baseURL: '/api/v1', timeout: 20000 });

http.interceptors.request.use((config) => {
  const token = localStorage.getItem(TOKEN_KEY);
  if (token) config.headers.Authorization = `Bearer ${token}`;
  // 资金/下单等写操作建议带幂等键：调用方可通过 options.idempotencyKey 指定
  if (config.idempotencyKey) config.headers['Idempotency-Key'] = config.idempotencyKey;
  return config;
});

export class ApiError extends Error {
  constructor(code, message, details, requestId) {
    super(message || '请求失败');
    this.code = code;
    this.details = details;
    this.requestId = requestId;
  }
}

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

export default http;
