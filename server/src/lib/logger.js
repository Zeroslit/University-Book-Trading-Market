// 轻量结构化日志（生产可替换为 pino/winston）
import { config } from '../config/index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const currentLevel = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function write(level, message, meta) {
  if (LEVELS[level] < currentLevel) return;
  const line = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta && typeof meta === 'object' ? meta : { extra: meta }),
  };
  const text = JSON.stringify(line);
  if (level === 'error') console.error(text);
  else if (level === 'warn') console.warn(text);
  else console.log(text);
}

export const logger = {
  debug: (msg, meta) => write('debug', msg, meta),
  info: (msg, meta) => write('info', msg, meta),
  warn: (msg, meta) => write('warn', msg, meta),
  error: (msg, meta) => write('error', msg, meta),
  config: () => config.env,
};
