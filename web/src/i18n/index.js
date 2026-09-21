// 轻量国际化：不引入第三方依赖，直接复用现有设计系统。
// 设计取舍：以「中文原文」作为词条 key，英文缺失时回落到中文原文，
// 因此任何未翻译的文案都不会空白或报错，可以随时增量补词条。
import { ref } from 'vue';
import { en } from './messages.en.js';

const STORAGE_KEY = 'app.locale';
export const SUPPORTED = ['zh', 'en'];

function detectLocale() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (SUPPORTED.includes(saved)) return saved;
  } catch { /* 隐私模式下 localStorage 不可用 */ }
  const nav = typeof navigator !== 'undefined' ? String(navigator.language || '').toLowerCase() : 'zh';
  if (nav.startsWith('zh')) return 'zh';
  return nav ? 'en' : 'zh';
}

export const locale = ref(detectLocale());

export function setLocale(next) {
  if (!SUPPORTED.includes(next)) return;
  locale.value = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* 忽略 */ }
  if (typeof document !== 'undefined') document.documentElement.lang = next === 'en' ? 'en' : 'zh-CN';
}

export function toggleLocale() {
  setLocale(locale.value === 'en' ? 'zh' : 'en');
}

/**
 * 取词条：中文环境返回原文；英文环境返回英文词条，缺失则回落中文。
 * 支持两种占位符写法：
 *   t('共 {n} 本', { n: total })      具名参数
 *   t('共 {0} 本', [total])           位置参数（模板里插值较多时更简洁）
 * 用 hasOwnProperty 判定命中，空字符串译文（英文里可省略的片段）同样生效。
 */
export function format(text, params) {
  if (!params) return text;
  if (Array.isArray(params)) {
    return params.reduce((acc, v, i) => acc.split(`{${i}}`).join(v == null ? '' : String(v)), text);
  }
  return Object.keys(params).reduce(
    (acc, key) => acc.split(`{${key}}`).join(params[key] == null ? '' : String(params[key])),
    text,
  );
}

export function t(zh, params) {
  let text = zh;
  if (locale.value === 'en' && Object.prototype.hasOwnProperty.call(en, zh)) text = en[zh];
  return format(text, params);
}

// 供 Options API 或模板中直接使用 $t / $locale
export function installI18n(app) {
  app.config.globalProperties.$t = t;
  app.config.globalProperties.$locale = locale;
  app.config.globalProperties.$setLocale = setLocale;
  if (typeof document !== 'undefined') document.documentElement.lang = locale.value === 'en' ? 'en' : 'zh-CN';
}
