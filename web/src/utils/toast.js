// 轻量全局提示：避免引入第三方 UI 库
import { reactive } from 'vue';

export const toasts = reactive([]);

let seq = 0;
export function showToast(message, type = 'info', timeout = 3200) {
  const id = ++seq;
  toasts.push({ id, message: String(message || ''), type });
  setTimeout(() => dismissToast(id), timeout);
  return id;
}

export function dismissToast(id) {
  const index = toasts.findIndex((t) => t.id === id);
  if (index >= 0) toasts.splice(index, 1);
}

export const toastOk = (msg) => showToast(msg, 'success');
export const toastError = (msg) => showToast(msg, 'error');
