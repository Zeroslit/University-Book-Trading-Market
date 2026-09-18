// 生成前端演示版数据集：从种子数据库导出真实结构的数据，写入 web/src/demo/dataset.js
// 用法：node scripts/build-demo-dataset.mjs
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(path.resolve('server/package.json'));
const mysql = require('mysql2/promise');

const DB = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3307),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root123456',
  database: process.env.DB_NAME || 'campus_book',
};

const OUT = path.resolve('web/src/demo/dataset.js');

// 需要脱敏/剔除的字段：演示版不携带任何可还原的敏感信息
const DROP = {
  users: ['password_hash', 'phone_enc', 'real_name_enc', 'phone_hash'],
  payment_accounts: ['account_no_hash'],
  reports: ['evidence_enc'],
  school_applications: ['applicant_phone_enc', 'applicant_phone_hash'],
};

const TABLES = [
  'schools', 'users', 'user_verifications', 'payment_accounts', 'books', 'book_images',
  'threads', 'thread_images', 'replies', 'conversations', 'messages', 'orders',
  'order_status_log', 'wallet_accounts', 'wallet_transactions', 'credit_logs',
  'reports', 'penalties', 'appeals', 'tickets', 'ticket_logs', 'chat_sessions',
  'chat_messages', 'kb_articles', 'banned_words', 'word_hits', 'notifications',
  'audit_logs', 'school_applications', 'withdraw_requests',
];

function clean(table, rows) {
  const drop = DROP[table] || [];
  return rows.map((row) => {
    const out = {};
    for (const [k, v] of Object.entries(row)) {
      if (drop.includes(k)) continue;
      out[k] = v instanceof Date ? v.toISOString() : v;
    }
    // 演示环境：保留手机号用于登录（真实部署绝不会下发该字段）
    if (table === 'users' && row.phone_enc) out.phone = decrypt(row.phone_enc);
    return out;
  });
}

// 演示登录需要手机号：读取 server/.env 的密钥后解密种子手机号（仅用于演示环境登录）
for (const line of fs.readFileSync(path.resolve('server/.env'), 'utf8').split('\n')) {
  const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
}
const { decrypt } = await import(pathToFileURL(path.resolve('server/src/lib/crypto.js')).href);

const conn = await mysql.createConnection(DB);
const data = {};
const stats = [];
for (const table of TABLES) {
  const [rows] = await conn.query(`SELECT * FROM \`${table}\``);
  data[table] = clean(table, rows);
  stats.push(`${table}=${rows.length}`);
}

// 规则配置：平台级为基准，学校级覆盖单独存一份
const [configRows] = await conn.query('SELECT scope, school_id, config_key, config_value, description FROM configs');
const configs = {};
const schoolConfigs = {};
for (const row of configRows) {
  const value = typeof row.config_value === 'string' ? JSON.parse(row.config_value) : row.config_value;
  if (row.scope === 'school' && row.school_id) {
    schoolConfigs[row.school_id] = schoolConfigs[row.school_id] || {};
    schoolConfigs[row.school_id][row.config_key] = value;
  } else {
    configs[row.config_key] = value;
  }
}

// 演示用补充数据：1 条生效中的“站内警告”处罚，便于展示处罚与申诉链路（不影响信誉分，与档位规则一致）
const penaltySeed = [{
  id: 9001, user_id: 8, school_id: 3, report_id: null,
  type: 'warning', severity: 'light', effective_count: 1,
  reason: '投诉成立（轻度）：教材描述与实际不符',
  start_at: new Date(Date.now() - 2 * 86400000).toISOString(),
  end_at: null, status: 'active', appeal_status: 'none',
  operator_id: 10, source: 'report',
  created_at: new Date(Date.now() - 2 * 86400000).toISOString(),
}];

await conn.end();

const header = `// 本文件由 scripts/build-demo-dataset.mjs 自动生成，请勿手工修改
// 数据来源：种子数据库（3 所高校 / 12 个账号 / 10 本教材 / 5 个帖子 / 2 笔托管订单 …）
// 已剔除手机号密文、密码哈希、银行卡哈希等敏感字段；演示版仅用于界面与流程展示
`;
const body = `export const meta = ${JSON.stringify({
  generatedAt: new Date().toISOString(),
  tables: stats,
  note: '演示数据集：登录态、下单、支付、放款等操作仅在浏览器内存中进行，不会写入真实数据库',
}, null, 2)};

export const configs = ${JSON.stringify(configs, null, 2)};

export const schoolConfigs = ${JSON.stringify(schoolConfigs, null, 2)};

// 演示补充数据：1 条生效中的“站内警告”处罚，用于展示处罚与申诉链路（不影响信誉分）
export const extraPenalties = ${JSON.stringify(penaltySeed, null, 2).replace(/"([a-z_]+)":/g, '"$1":')};

// 每次调用返回一份全新的深拷贝，便于“重置演示数据”
export function createDataset() {
  const tables = structuredClone(rawTables);
  tables.penalties = structuredClone(extraPenalties);
  return { tables, configs: structuredClone(configs), schoolConfigs: structuredClone(schoolConfigs) };
}
`;const rawTablesDecl = `export const rawTables = ${JSON.stringify(data, null, 2)};`;

const script = `${header}\n${rawTablesDecl}\n\n${body}`;
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, script, 'utf8');

// 演示封面图：由 server/src/lib/demo-images.js 在种子阶段生成（server/uploads/demo），
// 这里同步一份到 web/public/static/demo，供纯静态演示版（GitHub Pages）直接引用
const IMG_SRC = path.resolve('server/uploads/demo');
const IMG_DST = path.resolve('web/public/static/demo');
if (fs.existsSync(IMG_SRC)) {
  fs.mkdirSync(IMG_DST, { recursive: true });
  const names = fs.readdirSync(IMG_SRC).filter((n) => n.endsWith('.svg'));
  for (const name of names) fs.copyFileSync(path.join(IMG_SRC, name), path.join(IMG_DST, name));
  console.log('synced ' + names.length + ' demo images -> ' + IMG_DST);
} else {
  console.warn('未找到 ' + IMG_SRC + '，请先执行 cd server && npm run db:reset');
}
console.log(`written ${OUT} (${(fs.statSync(OUT).size / 1024).toFixed(1)} KB)`);
console.log(stats.join('\n'));
