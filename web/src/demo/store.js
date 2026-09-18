// 演示版内存数据库：以种子数据为初始值，所有写操作只作用于浏览器内存（可持久化到 localStorage）
// 注意：这里的数据结构与真实 MySQL 表一致（字段名相同），便于页面代码零改动复用
import { createDataset } from './dataset.js';
import { AppError, ERR } from './vendor.js';

const STORAGE_KEY = 'campus_book_demo_db_v1';

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed?.tables) return parsed;
    }
  } catch {
    // 本地缓存损坏时直接重置
  }
  return createDataset();
}

export function db() {
  return state;
}

export function table(name) {
  if (!state.tables[name]) state.tables[name] = [];
  return state.tables[name];
}

export function nextId(name) {
  return table(name).reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1;
}

export function insert(name, row) {
  const record = { ...row };
  if (record.id === undefined) record.id = nextId(name);
  table(name).push(record);
  return record;
}

export function find(name, predicate) {
  return table(name).find(predicate) || null;
}

export function filter(name, predicate) {
  return table(name).filter(predicate);
}

export function nowIso() {
  return new Date().toISOString();
}

export function isoAgo(ms) {
  return new Date(Date.now() - ms).toISOString();
}

export function isoAfter(ms) {
  return new Date(Date.now() + ms).toISOString();
}

// 单号生成：与后端 generateNo 风格一致（前缀 + 时间戳 + 随机数）
export function generateNo(prefix) {
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(0, 14);
  return `${prefix}${stamp}${String(Math.floor(Math.random() * 100000)).padStart(5, '0')}`;
}

// ---------------- 规则配置读取（学校级优先，其次平台级） ----------------
export function configValue(key, schoolId = null) {
  const schoolScoped = schoolId ? state.schoolConfigs?.[schoolId]?.[key] : undefined;
  if (schoolScoped !== undefined) return structuredClone(schoolScoped);
  if (state.configs[key] !== undefined) return structuredClone(state.configs[key]);
  throw new AppError(ERR.CONFIG_MISSING, `规则配置缺失：${key}，请在管理后台初始化`, { configKey: key, schoolId });
}

export function setConfigValue(key, value, { scope = 'platform', schoolId = null, description = null } = {}) {
  if (scope === 'school') {
    if (!schoolId) throw new AppError(ERR.SCHOOL_REQUIRED, '学校级配置必须指定 schoolId');
    state.schoolConfigs[schoolId] = state.schoolConfigs[schoolId] || {};
    state.schoolConfigs[schoolId][key] = value;
    return { key, scope, schoolId, value, description };
  }
  state.configs[key] = value;
  return { key, scope: 'platform', schoolId: null, value, description };
}

// ---------------- 持久化 ----------------
let saveTimer = null;

export function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 超出配额或隐私模式：忽略即可，不影响当前会话
    }
  }, 50);
}

export function resetDemoData() {
  state = createDataset();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // 忽略
  }
  return state;
}

// 备份/恢复：便于“导出当前演示数据”
export function snapshot() {
  return JSON.parse(JSON.stringify(state));
}
