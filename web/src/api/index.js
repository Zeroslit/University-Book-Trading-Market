// 接口清单（与 docs/05-接口清单.md 对应）：按模块分组，页面只调用这里
import http from './client.js';

const idem = () => `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const authApi = {
  sendSms: (body) => http.post('/auth/sms/send', body),
  register: (body) => http.post('/auth/register', body),
  login: (body) => http.post('/auth/login', body),
  loginWechat: (body) => http.post('/auth/login/wechat', body),
  me: () => http.get('/auth/me'),
  logout: () => http.post('/auth/logout'),
  resetPassword: (body) => http.post('/auth/password/reset', body),
};

export const schoolApi = {
  list: (params) => http.get('/schools', { params }),
  provinces: () => http.get('/schools/provinces'),
  detail: (id) => http.get(`/schools/${id}`),
  apply: (body) => http.post('/schools/applications', body),
  applications: (params) => http.get('/schools/applications/list', { params }),
  reviewApplication: (id, body) => http.post(`/schools/applications/${id}/review`, body),
};

export const userApi = {
  profile: () => http.get('/users/me/profile'),
  updateProfile: (body) => http.patch('/users/me/profile', body),
  credit: () => http.get('/users/me/credit'),
  creditLogs: (params) => http.get('/users/me/credit/logs', { params }),
  publicProfile: (id) => http.get(`/users/${id}/public`),
};

export const verificationApi = {
  submit: (body) => http.post('/verifications', body),
  mine: () => http.get('/verifications/me'),
  list: (params, schoolId) => http.get('/verifications', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  review: (id, body, schoolId) => http.post(`/verifications/${id}/review`, body, { params: schoolId ? { schoolId } : {} }),
};

export const paymentAccountApi = {
  list: () => http.get('/payment-accounts'),
  bind: (body, idempotencyKey = idem()) => http.post('/payment-accounts', body, { idempotencyKey }),
  unbindCode: (id) => http.post(`/payment-accounts/${id}/unbind/code`),
  unbind: (id, body) => http.post(`/payment-accounts/${id}/unbind`, body),
  setDefault: (id) => http.post(`/payment-accounts/${id}/default`),
};

export const uploadApi = {
  // 前端已把长边压缩到 ≤1080px，这里只负责上传
  image: (file) => {
    const form = new FormData();
    form.append('file', file);
    return http.post('/uploads/image', form, { headers: { 'Content-Type': 'multipart/form-data' } });
  },
};

export const bookApi = {
  list: (params) => http.get('/books', { params }),
  detail: (id) => http.get(`/books/${id}`),
  create: (body, idempotencyKey = idem()) => http.post('/books', body, { idempotencyKey }),
  update: (id, body) => http.patch(`/books/${id}`, body),
  offShelf: (id) => http.post(`/books/${id}/off-shelf`),
  relist: (id) => http.post(`/books/${id}/relist`),
  remove: (id) => http.delete(`/books/${id}`),
};

export const threadApi = {
  list: (params) => http.get('/threads', { params }),
  detail: (id) => http.get(`/threads/${id}`),
  create: (body, idempotencyKey = idem()) => http.post('/threads', body, { idempotencyKey }),
  update: (id, body) => http.patch(`/threads/${id}`, body),
  remove: (id) => http.delete(`/threads/${id}`),
  reply: (id, body, idempotencyKey = idem()) => http.post(`/threads/${id}/replies`, body, { idempotencyKey }),
  removeReply: (id) => http.delete(`/replies/${id}`),
};

export const messageApi = {
  conversations: (params) => http.get('/conversations', { params }),
  open: (body) => http.post('/conversations', body),
  messages: (id, params) => http.get(`/conversations/${id}/messages`, { params }),
  send: (id, body) => http.post(`/conversations/${id}/messages`, body),
};

export const orderApi = {
  list: (params) => http.get('/orders', { params }),
  detail: (id) => http.get(`/orders/${id}`),
  create: (body, idempotencyKey = idem()) => http.post('/orders', body, { idempotencyKey }),
  pay: (id, idempotencyKey = idem()) => http.post(`/orders/${id}/pay`, {}, { idempotencyKey }),
  cancel: (id, body) => http.post(`/orders/${id}/cancel`, body),
  ship: (id, body) => http.post(`/orders/${id}/ship`, body),
  confirm: (id, idempotencyKey = idem()) => http.post(`/orders/${id}/confirm`, {}, { idempotencyKey }),
  refundRequest: (id, body) => http.post(`/orders/${id}/refund-request`, body),
  returnRequest: (id, body) => http.post(`/orders/${id}/return-request`, body),
  agreeRefund: (id, body) => http.post(`/orders/${id}/refund/agree`, body),
  rejectRefund: (id, body) => http.post(`/orders/${id}/refund/reject`, body),
  dispute: (id, body) => http.post(`/orders/${id}/dispute`, body),
  arbitrate: (id, body, schoolId) => http.post(`/orders/${id}/arbitrate`, body, { params: schoolId ? { schoolId } : {} }),
};

export const walletApi = {
  account: () => http.get('/wallet'),
  transactions: (params) => http.get('/wallet/transactions', { params }),
  recharge: (body, idempotencyKey = idem()) => http.post('/wallet/recharge', body, { idempotencyKey }),
  withdraw: (body, idempotencyKey = idem()) => http.post('/wallet/withdraw', body, { idempotencyKey }),
  withdrawals: (params) => http.get('/wallet/withdrawals', { params }),
};

export const notificationApi = {
  list: (params) => http.get('/notifications', { params }),
  unread: () => http.get('/notifications/unread-count'),
  markRead: (id) => http.post(`/notifications/${id}/read`),
  markAllRead: () => http.post('/notifications/read-all'),
};

export const wordApi = {
  check: (text, scene = 'thread') => http.post('/words/check', { text, scene }),
  list: (params, schoolId) => http.get('/admin/banned-words', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  create: (body, schoolId) => http.post('/admin/banned-words', body, { params: schoolId ? { schoolId } : {} }),
  update: (id, body, schoolId) => http.patch(`/admin/banned-words/${id}`, body, { params: schoolId ? { schoolId } : {} }),
  remove: (id, schoolId) => http.delete(`/admin/banned-words/${id}`, { params: schoolId ? { schoolId } : {} }),
  hits: (params, schoolId) => http.get('/admin/banned-words/hits', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
};

export const reportApi = {
  create: (body) => http.post('/reports', body),
  list: (params) => http.get('/reports', { params }),
  detail: (id) => http.get(`/reports/${id}`),
  accept: (id, body) => http.post(`/reports/${id}/accept`, body),
  proof: (id, body) => http.post(`/reports/${id}/proof`, body),
  decide: (id, body) => http.post(`/reports/${id}/decide`, body),
  stats: () => http.get('/reports/stats'),
  appeal: (body) => http.post('/appeals', body),
  appeals: (params) => http.get('/appeals', { params }),
  reviewAppeal: (id, body) => http.post(`/appeals/${id}/review`, body),
};

export const ticketApi = {
  create: (body) => http.post('/tickets', body),
  list: (params, schoolId) => http.get('/tickets', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  detail: (id, schoolId) => http.get(`/tickets/${id}`, { params: schoolId ? { schoolId } : {} }),
  claim: (id, schoolId) => http.post(`/tickets/${id}/claim`, {}, { params: schoolId ? { schoolId } : {} }),
  reply: (id, body, schoolId) => http.post(`/tickets/${id}/reply`, body, { params: schoolId ? { schoolId } : {} }),
  resolve: (id, body, schoolId) => http.post(`/tickets/${id}/resolve`, body, { params: schoolId ? { schoolId } : {} }),
  escalate: (id, body, schoolId) => http.post(`/tickets/${id}/escalate`, body, { params: schoolId ? { schoolId } : {} }),
  stats: (schoolId) => http.get('/tickets/stats', { params: schoolId ? { schoolId } : {} }),
};

export const kbApi = {
  articles: (params) => http.get('/kb/articles', { params }),
  detail: (id) => http.get(`/kb/articles/${id}`),
  create: (body) => http.post('/kb/articles', body),
  update: (id, body) => http.patch(`/kb/articles/${id}`, body),
};

export const chatApi = {
  start: (body) => http.post('/chat/sessions', body),
  session: (id) => http.get(`/chat/sessions/${id}`),
  send: (id, body) => http.post(`/chat/sessions/${id}/messages`, body),
  transfer: (id, body) => http.post(`/chat/sessions/${id}/transfer`, body),
};

export const adminApi = {
  dashboard: (schoolId) => http.get('/admin/dashboard', { params: schoolId ? { schoolId } : {} }),
  schools: () => http.get('/admin/schools'),
  createSchool: (body) => http.post('/admin/schools', body),
  updateSchool: (id, body) => http.patch(`/admin/schools/${id}`, body),
  users: (params, schoolId) => http.get('/admin/users', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  banUser: (id, body, schoolId) => http.post(`/admin/users/${id}/ban`, body, { params: schoolId ? { schoolId } : {} }),
  unbanUser: (id, body, schoolId) => http.post(`/admin/users/${id}/unban`, body, { params: schoolId ? { schoolId } : {} }),
  userRisk: (id, schoolId) => http.get(`/admin/users/${id}/risk`, { params: schoolId ? { schoolId } : {} }),
  orders: (params, schoolId) => http.get('/admin/orders', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  contents: (params, schoolId) => http.get('/admin/contents', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  reviewContent: (type, id, body, schoolId) => http.post(`/admin/contents/${type}/${id}/review`, body, { params: schoolId ? { schoolId } : {} }),
  configs: (params, schoolId) => http.get('/admin/configs', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
  setConfig: (key, body) => http.put(`/admin/configs/${key}`, body),
  auditLogs: (params, schoolId) => http.get('/admin/audit-logs', { params: { ...params, ...(schoolId ? { schoolId } : {}) } }),
};

export default {
  authApi, schoolApi, userApi, verificationApi, paymentAccountApi, uploadApi, bookApi, threadApi,
  messageApi, orderApi, walletApi, notificationApi, wordApi, reportApi, ticketApi, kbApi, chatApi, adminApi,
};


