// 种子数据：3 所高校 / 每校 3 名学生 / 10 本教材 / 5 个帖子及评论 /
//           2 笔不同状态的托管订单 / 1 个进行中的客服工单 / 1 个待审核的学生认证
// 用法：node src/db/seed.js
import path from 'node:path';
import mysql from 'mysql2/promise';
import { config } from '../config/index.js';
import { logger } from '../lib/logger.js';
import { encrypt, hmac, hashPassword, generateNo } from '../lib/crypto.js';
import { maskStudentNo, maskBankCard, maskName } from '../lib/mask.js';
import { normalizeText } from '../lib/normalize.js';
import { writeDemoImages } from '../lib/demo-images.js';

const PASSWORD = 'Test@123456';

// ---------------- 规则阈值：全部落库，代码不硬编码 ----------------
const CONFIG_ENTRIES = [
  ['credit.tiers', {
    tiers: [
      { key: 'excellent', min: 90, label: '优秀' },
      { key: 'good', min: 70, label: '良好' },
      { key: 'limited', min: 50, label: '受限' },
      { key: 'high_risk', min: 30, label: '高风险' },
      { key: 'banned', min: 0, label: '禁止交易' },
    ],
  }, '信誉分档位'],
  ['credit.rules', {
    ship_on_time: 2, good_review: 1, no_dispute_streak_10: 5,
    late_ship: -5, mismatch_confirmed: -10, report_light: -5,
    banned_word: -3, fake_trade: -30,
  }, '信誉分加减分规则'],
  ['credit.tier_permissions', {
    excellent: { maxBooks: 999, withdrawDelayHours: 0, canPublish: true, canTrade: true },
    good: { maxBooks: 50, withdrawDelayHours: 0, canPublish: true, canTrade: true },
    limited: { maxBooks: 3, withdrawDelayHours: 24, canPublish: true, canTrade: true },
    high_risk: { maxBooks: 0, withdrawDelayHours: 24, canPublish: false, canTrade: true },
    banned: { maxBooks: 0, withdrawDelayHours: 24, canPublish: false, canTrade: false },
  }, '档位联动权限'],
  ['credit.light_violation_expire_months', 12, '轻度违规滚动过期月数'],
  ['credit.clean_months_clear_count', 6, '连续无违规月数可消除 1 次计数'],
  ['credit.bounds', { min: 0, max: 100 }, '信誉分上下限'],
  ['penalty.escalation', {
    steps: [
      { times: 1, type: 'warning', days: 0, scoreDelta: 0, label: '站内警告' },
      { times: 2, type: 'warning', days: 0, scoreDelta: 0, label: '站内警告' },
      { times: 3, type: 'mute', days: 3, scoreDelta: -5, label: '禁言 3 天' },
      { times: 4, type: 'trade_ban', days: 7, scoreDelta: 0, label: '限制交易 7 天' },
      { times: 5, type: 'login_ban', days: 7, scoreDelta: 0, label: '封禁 7 天' },
      { times: 6, type: 'login_ban', days: 15, scoreDelta: 0, label: '封禁 15 天' },
      { times: 7, type: 'login_ban', days: 20, scoreDelta: 0, label: '封禁 20 天' },
      { times: 8, type: 'login_ban', days: 25, scoreDelta: 0, label: '封禁 25 天' },
      { times: 9, type: 'login_ban', days: 30, scoreDelta: 0, label: '封禁 30 天' },
      { times: 10, type: 'permanent_ban', days: null, scoreDelta: 0, label: '永久封禁' },
    ],
    severeInstantBan: true,
  }, '处罚梯度'],
  ['order.state_machine', {
    initial: 'pending_payment',
    terminal: ['completed', 'cancelled', 'refunded', 'arbitrated_refund', 'arbitrated_release'],
    transitions: {
      pending_payment: ['paid', 'cancelled'],
      paid: ['shipped', 'refund_requested', 'disputed'],
      shipped: ['completed', 'return_requested', 'disputed'],
      refund_requested: ['refunded', 'paid', 'disputed'],
      return_requested: ['refunded', 'shipped', 'disputed'],
      disputed: ['arbitrated_refund', 'arbitrated_release'],
      completed: [], cancelled: [], refunded: [], arbitrated_refund: [], arbitrated_release: [],
    },
  }, '订单状态机'],
  ['order.auto_confirm_days', 7, '发货后自动确认收货天数'],
  ['order.ship_deadline_days', 3, '卖家发货时限（天），逾期扣分'],
  ['order.service_fee_bps', 200, '平台服务费比例（万分比）'],
  ['order.report_proof_hours', 48, '被投诉人举证时限（小时）'],
  ['report.appeal_days', 3, '裁定后申诉期（天）'],
  ['banned_word.normalize', { fullWidth: true, traditional: true, pinyin: true, stripSymbols: true }, '归一化开关'],
  ['banned_word.penalty', {
    L1: { action: 'mask', scoreDelta: 0, violation: 0 },
    L2: { action: 'block', scoreDelta: 0, violation: 0 },
    L3: { action: 'block', scoreDelta: -3, violation: 1 },
    L4: { action: 'delete', ticket: true, ban: true, violation: 1 },
  }, '违禁词级别处置'],
  ['banned_word.escalation', {
    L1_hint_per_day: 3, L1_mute_days: 1,
    L2L3_mute_hits: 3, L2L3_mute_days: 7,
    L2L3_post_ban_hits: 5, L2L3_post_ban_days: 30,
  }, '违禁词命中累计升级'],
  ['ticket.sla', {
    normal: { firstResponseHours: 24, resolveHours: 72 },
    urgent: { firstResponseHours: 4, resolveHours: 24 },
  }, '工单 SLA'],
  ['ticket.auto_escalate', true, '超时自动升级'],
  ['ai.escalate_rules', {
    unresolvedRounds: 2, confidenceThreshold: 0.55,
    fundKeywords: ['退款', '退钱', '钱没到', '放款', '仲裁', '投诉', '骗'],
    keywords: ['转人工', '人工客服', '找客服'],
  }, 'AI 转人工条件'],
  ['rate_limit.default', { windowSeconds: 60, max: 300 }, '默认限流'],
  ['rate_limit.sensitive', { login: 10, sms: 3, order: 20, withdraw: 5, publish: 30 }, '敏感接口限流'],
  ['upload.image', { maxSidePx: 1080, maxSizeMb: 5, allowTypes: ['image/jpeg', 'image/png', 'image/webp'] }, '图片限制'],
  ['retention', { chatMonths: 24, evidenceMonths: 36, auditMonths: 60, verificationMonths: 36 }, '敏感数据保存期限'],
  ['content.categories', ['教材', '教辅', '考研', '英语', '计算机', '经管', '理工'], '可发布品类'],
  ['order.ship_modes', ['meetup', 'mail'], '支持的交付方式'],
];

// ---------------- 违禁词四级词库 ----------------
const BANNED_WORDS = [
  ['手机号', '1[3-9]\\d{9}', 'L1', '联系方式', 'regex', 'mask', 0, 0],
  ['QQ号', '(?:qq)[：: ]?\\d{5,12}', 'L1', '联系方式', 'regex', 'mask', 0, 0],
  ['微信号', '(?:微信|wx|vx|weixin)[：:号 ]?[a-zA-Z][-_a-zA-Z0-9]{5,19}', 'L1', '联系方式', 'regex', 'mask', 0, 0],
  ['加微信', '加微信', 'L1', '联系方式', 'keyword', 'mask', 0, 0],
  ['加我', '加我', 'L1', '联系方式', 'keyword', 'mask', 0, 0],
  ['微信', '微信', 'L1', '联系方式', 'keyword', 'mask', 0, 0],
  ['私聊', '私聊', 'L1', '联系方式', 'keyword', 'mask', 0, 0],
  ['外链', 'https?://\\S+', 'L2', '引流广告', 'regex', 'block', 0, 0],
  ['二维码', '二维码', 'L2', '引流广告', 'keyword', 'block', 0, 0],
  ['扫码', '扫码', 'L2', '引流广告', 'keyword', 'block', 0, 0],
  ['加群', '加群', 'L2', '引流广告', 'keyword', 'block', 0, 0],
  ['代理', '代理', 'L2', '引流广告', 'keyword', 'block', 0, 0],
  ['盗版', '盗版', 'L3', '违规交易', 'keyword', 'block', -3, 1],
  ['答案', '答案', 'L3', '违规交易', 'keyword', 'block', -3, 1],
  ['代写', '代写', 'L3', '违规交易', 'keyword', 'block', -3, 1],
  ['代考', '代考', 'L3', '违规交易', 'keyword', 'block', -3, 1],
  ['替考', '替考', 'L3', '违规交易', 'keyword', 'block', -3, 1],
  ['刷单', '刷单', 'L3', '违规交易', 'keyword', 'block', -3, 1],
  ['赌博', '赌博', 'L4', '涉黄赌诈', 'keyword', 'delete', 0, 1],
  ['博彩', '博彩', 'L4', '涉黄赌诈', 'keyword', 'delete', 0, 1],
  ['诈骗', '诈骗', 'L4', '涉黄赌诈', 'keyword', 'delete', 0, 1],
  ['色情', '色情', 'L4', '涉黄赌诈', 'keyword', 'delete', 0, 1],
  ['辱骂', '傻逼', 'L4', '辱骂', 'keyword', 'delete', 0, 1],
  ['辱骂', 'nmsl', 'L4', '辱骂', 'keyword', 'delete', 0, 1],
];

// 白名单：避免教材书名误伤
const WHITELIST_WORDS = [
  ['答案', 'L3', '违规交易'],
  ['代理', 'L2', '引流广告'],
];

const SCHOOLS = [
  {
    name: '江南大学', province: '江苏省', city: '无锡市', code: 'JNU-320200', status: 'active',
    sections: [{ key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' }, { key: 'exam', name: '考研交流' }],
    serviceFeeBps: 200, requireVerification: 1, crossSchool: 1, crossSchoolMode: 'mail',
  },
  {
    name: '郑州轻工业大学', province: '河南省', city: '郑州市', code: 'ZZULI-410100', status: 'active',
    sections: [{ key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' }],
    serviceFeeBps: 150, requireVerification: 1, crossSchool: 0, crossSchoolMode: 'off',
  },
  {
    name: '成都理工大学', province: '四川省', city: '成都市', code: 'CDUT-510100', status: 'active',
    sections: [{ key: 'textbook', name: '教材转让' }, { key: 'seek', name: '求书专区' }],
    serviceFeeBps: 250, requireVerification: 0, crossSchool: 0, crossSchoolMode: 'off',
  },
];

// [学校下标, 学号, 手机号, 昵称, 认证状态, 信誉分]
const STUDENTS = [
  [0, '2021010101', '13800000001', '林晓（江南）', 'approved', 100],
  [0, '2021010102', '13800000002', '陈默（江南）', 'approved', 96],
  [0, '2021010103', '13800000003', '王雨（江南）', 'pending', 100],
  [1, '2022010101', '13800000004', '赵磊（郑轻）', 'approved', 100],
  [1, '2022010102', '13800000005', '孙晴（郑轻）', 'approved', 95],
  [1, '2022010103', '13800000006', '周航（郑轻）', 'approved', 100],
  [2, '2023010101', '13800000007', '李文（成理）', 'approved', 100],
  [2, '2023010102', '13800000008', '郑一（成理）', 'approved', 74],
  [2, '2023010103', '13800000009', '高远（成理）', 'approved', 100],
];

// 成色中文名（用于生成演示封面图）
const CONDITION_LABELS = { new: '全新', like_new: '九成新', good: '八成新', fair: '七成新', poor: '五成新' };

// [学校下标, 校内卖家下标, 书名, 作者, 出版社, ISBN, 课程, 成色, 原价(分), 售价(分), 备注]
const BOOKS = [
  [0, 0, '高等数学（上册）第七版', '同济大学数学系', '高等教育出版社', '9787040396638', '高等数学A', 'like_new', 4980, 2000, '只翻过前两章，无笔记'],
  [0, 0, '线性代数（第六版）', '同济大学数学系', '高等教育出版社', '9787040396614', '线性代数', 'good', 3200, 1200, '有少量铅笔笔记，可擦除'],
  [0, 1, '数据结构（C 语言版）', '严蔚敏', '清华大学出版社', '9787302147510', '数据结构', 'good', 4500, 2200, '考研用书，附习题册'],
  [0, 1, '计算机网络（第 7 版）', '谢希仁', '电子工业出版社', '9787121302954', '计算机网络', 'fair', 5900, 2500, '封面有折痕，内容完整'],
  [0, 2, '大学英语综合教程 2', '李荫华', '上海外语教育出版社', '9787544653046', '大学英语', 'new', 3800, 1800, '全新未拆封'],
  [1, 0, '机械设计基础（第七版）', '杨可桢', '高等教育出版社', '9787040435949', '机械设计基础', 'like_new', 5200, 2600, '含课程设计指导'],
  [1, 1, '电工学（第七版）上册', '秦曾煌', '高等教育出版社', '9787040264425', '电工学', 'good', 4200, 1500, '笔记完整，可赠送复习提纲'],
  [1, 2, '概率论与数理统计（第四版）', '盛骤', '高等教育出版社', '9787040238969', '概率论', 'good', 3600, 1400, '考完出，无破损'],
  [2, 0, '地质学基础（第四版）', '舒良树', '地质出版社', '9787116041536', '地质学基础', 'like_new', 6800, 3200, '配套野外实习手册'],
  [2, 1, '工程测量学（第三版）', '张正禄', '武汉大学出版社', '9787307192669', '工程测量', 'fair', 4800, 1600, '书角磨损，内页干净'],
];

// [学校下标, 校内作者下标, 类型, 标题, 内容, 版块]
const THREADS = [
  [0, 0, 'seek', '求《大学物理》下册 马文蔚版', '下学期要用，谁有闲置的？可以面交，价格好商量。', 'seek'],
  [0, 1, 'sell', '出《数据结构》严蔚敏 + 习题册', '考研换书出，笔记做得很全，附赠历年真题打印版。', 'textbook'],
  [0, 2, 'seek', '求考研英语真题（近十年）', '有没有考完的学长学姐出真题册？求九成新以上。', 'exam'],
  [0, 0, 'sell', '《计算机网络》谢希仁 第 7 版转让', '上学期用的，只在目录做了标记，其余全新。', 'textbook'],
  [0, 2, 'sell', '《大学英语综合教程 2》全新未拆', '买重了，原价出，可小刀。', 'textbook'],
];

// [帖子下标, 校内作者下标, 内容]
const REPLIES = [
  [0, 0, '我有一本，八成新，15 块可以吗？'],
  [0, 2, '同求，有的话也联系我一下'],
  [1, 2, '笔记能拍照看看吗？'],
  [1, 0, '可以，我私信发你'],
  [3, 1, '请问还有吗？我要了'],
  [4, 0, '这个版本和第三版内容差别大吗？'],
];

const KB_ARTICLES = [
  ['交易规则', '平台服务费怎么收？', '平台按订单成交金额收取服务费，比例由学校配置（默认 2%）。服务费在买家确认收货、货款放给卖家时扣取，订单详情页可看到具体金额。', '服务费,手续费,扣费'],
  ['交易规则', '为什么下单后钱没有直接给卖家？', '平台对交易资金进行托管：买家付款后资金进入托管冻结，卖家发货、买家确认收货后才放款给卖家；出现争议时资金冻结，由客服仲裁。', '托管,冻结,放款'],
  ['交易规则', '发货后多久会自动确认收货？', '卖家发货后 7 天内买家未确认收货，系统将自动确认并放款。若期间发起争议，自动确认倒计时会暂停，直到客服裁定。', '自动确认,7天,倒计时'],
  ['退款售后', '怎么申请退款？', '在订单详情页点击申请退款并说明原因。卖家同意后，托管资金全额退回你的账户余额；卖家拒绝可发起争议，由人工客服仲裁。', '退款,退货,争议'],
  ['账号与认证', '为什么我不能发布教材？', '发布教材需要完成学生认证，且信誉分需在 50 分以上（低于 30 分仅可浏览）。认证入口在个人中心，支持学生证或校园邮箱两种方式。', '认证,发布,信誉分'],
  ['账号与认证', '收款方式解绑后为什么不能马上重新绑定？', '为防止账号被盗后转移资金，解绑与换绑需要短信二次验证，并设置 24 小时冷却期。', '解绑,换绑,冷却'],
  ['违规与申诉', '收到处罚后可以申诉吗？', '可以。处罚生效后有 3 天申诉期，在个人中心的违规记录里提交申诉；复审通过将撤销处罚并回滚信誉分。', '申诉,处罚,信誉分'],
  ['违规与申诉', '哪些内容会被判定违规？', '盗版教材、考试答案、代写代考、刷单等属于违规内容；涉黄涉赌涉诈、辱骂等属于严重违规，将直接删除并可能永久封禁。', '违禁词,违规,封禁'],
];

async function main() {
  const conn = await mysql.createConnection({
    host: config.db.host, port: config.db.port, user: config.db.user,
    password: config.db.password, database: config.db.database,
    charset: 'utf8mb4', multipleStatements: true,
  });

  const passwordHash = await hashPassword(PASSWORD);
  const now = Date.now();
  const days = (n) => new Date(now + n * 86400000);
  const hours = (n) => new Date(now + n * 3600000);

  try {
    await conn.beginTransaction();

    // 清空业务数据（保留表结构），保证种子可重复执行
    const tables = ['word_hits', 'banned_words', 'notifications', 'ticket_logs', 'tickets',
      'chat_messages', 'chat_sessions', 'appeals', 'penalties', 'reports', 'credit_logs',
      'wallet_transactions', 'withdraw_requests', 'wallet_accounts', 'order_status_log', 'orders',
      'messages', 'conversations', 'replies', 'thread_images', 'threads',
      'book_images', 'books', 'payment_accounts', 'user_verifications', 'users',
      'school_applications', 'schools', 'configs', 'kb_articles', 'audit_logs', 'idempotency_records'];
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const t of tables) await conn.query(`TRUNCATE TABLE ${t}`);
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    // 1) 配置（规则阈值全部落库）
    for (const [key, value, desc] of CONFIG_ENTRIES) {
      await conn.query(
        `INSERT INTO configs (scope, school_id, config_key, config_value, description, version)
         VALUES ('platform', NULL, ?, CAST(? AS JSON), ?, 1)`,
        [key, JSON.stringify(value), desc],
      );
    }

    // 2) 学校
    const schoolIds = [];
    for (const s of SCHOOLS) {
      const [r] = await conn.query(
        `INSERT INTO schools (name, province, city, code, status, forum_sections, service_fee_bps,
           allowed_categories, require_student_verification, cross_school_enabled, cross_school_mode)
         VALUES (?, ?, ?, ?, ?, CAST(? AS JSON), ?, CAST(? AS JSON), ?, ?, ?)`,
        [s.name, s.province, s.city, s.code, s.status, JSON.stringify(s.sections), s.serviceFeeBps,
          JSON.stringify(['教材', '教辅', '考研', '英语', '计算机', '经管', '理工']),
          s.requireVerification, s.crossSchool, s.crossSchoolMode],
      );
      schoolIds.push(r.insertId);
    }

    // 3) 用户：9 名学生 + 校管 + 客服 + 平台管理员（服务费账户）
    const studentIds = [];
    for (const [schoolIdx, studentNo, phone, nickname, verification, credit] of STUDENTS) {
      const [r] = await conn.query(
        `INSERT INTO users (school_id, student_no, student_no_mask, phone_enc, phone_last4, phone_hash,
           password_hash, nickname, bio, real_name_enc, real_name_mask, role, status,
           verification_status, credit_score, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'student', 'active', ?, ?, ?)`,
        [schoolIds[schoolIdx], studentNo, maskStudentNo(studentNo), encrypt(phone), phone.slice(-4),
          hmac(phone), passwordHash, nickname, '在校学生，闲置教材循环利用',
          encrypt(`${nickname[0]}同学`), maskName(`${nickname[0]}同学`), verification, credit, hours(-2)],
      );
      studentIds.push(r.insertId);
    }
    // 学校 -> 该校学生在 STUDENTS 中的全局下标（种子数据按学校连续排列）
    const studentIndexBySchool = new Map();
    STUDENTS.forEach((s, idx) => {
      if (!studentIndexBySchool.has(s[0])) studentIndexBySchool.set(s[0], []);
      studentIndexBySchool.get(s[0]).push(idx);
    });
    const globalStudentIndexOf = (schoolIdx, localIdx) => studentIndexBySchool.get(schoolIdx)[localIdx];
    const [adminRes] = await conn.query(
      `INSERT INTO users (school_id, phone_enc, phone_last4, phone_hash, password_hash, nickname, role, status, verification_status, credit_score)
       VALUES (?, ?, '0001', ?, ?, '江南大学校园大使', 'school_admin', 'active', 'approved', 100)`,
      [schoolIds[0], encrypt('13900000001'), hmac('13900000001'), passwordHash],
    );
    const [supportRes] = await conn.query(
      `INSERT INTO users (school_id, phone_enc, phone_last4, phone_hash, password_hash, nickname, role, status, verification_status, credit_score)
       VALUES (NULL, ?, '0002', ?, ?, '人工客服小助手', 'support', 'active', 'approved', 100)`,
      [encrypt('13900000002'), hmac('13900000002'), passwordHash],
    );
    const [platformRes] = await conn.query(
      `INSERT INTO users (school_id, phone_enc, phone_last4, phone_hash, password_hash, nickname, role, status, verification_status, credit_score)
       VALUES (NULL, ?, '0003', ?, ?, '平台运营（服务费账户）', 'platform_admin', 'active', 'approved', 100)`,
      [encrypt('13900000003'), hmac('13900000003'), passwordHash],
    );
    const adminId = adminRes.insertId;
    const supportId = supportRes.insertId;
    const platformId = platformRes.insertId;

    // 4) 学生认证：1 条待审核（王雨），其余已通过
    for (let i = 0; i < studentIds.length; i += 1) {
      const status = STUDENTS[i][4];
      await conn.query(
        `INSERT INTO user_verifications (user_id, school_id, method, student_card_image_url, status, reviewer_id, review_note, reviewed_at)
         VALUES (?, ?, 'student_card', ?, ?, ?, ?, ?)`,
        [studentIds[i], schoolIds[STUDENTS[i][0]], `/static/demo/verification-${i + 1}.svg`, status,
          status === 'pending' ? null : adminId,
          status === 'pending' ? null : '信息与学生证一致',
          status === 'pending' ? null : hours(-24)],
      );
    }

    // 5) 收款绑定（仅脱敏信息）
    await conn.query(
      `INSERT INTO payment_accounts (user_id, school_id, type, account_name_mask, account_no_last4, account_no_hash, is_default)
       VALUES (?, ?, 'alipay', ?, '8821', ?, 1)`,
      [studentIds[0], schoolIds[0], maskName('林晓'), hmac('alipay-13800000001')],
    );
    await conn.query(
      `INSERT INTO payment_accounts (user_id, school_id, type, account_name_mask, account_no_last4, account_no_hash, bank_name, is_default)
       VALUES (?, ?, 'bank', ?, ?, ?, '招商银行', 1)`,
      [studentIds[1], schoolIds[0], maskName('陈默'), maskBankCard('6225880123456789').slice(-4), hmac('bank-13800000002')],
    );

    // 6) 图书 + 图片
    // 生成演示封面图片文件（与库中 URL 对应，避免封面 404）
    writeDemoImages({
      dir: path.resolve(process.cwd(), config.upload.dir, 'demo'),
      books: BOOKS.map((b) => ({ title: b[2], author: b[3], publisher: b[4], course: b[6], condition: CONDITION_LABELS[b[7]] || b[7] })),
      threadTitle: THREADS[1][3],
    });
    const bookIds = [];
    for (let i = 0; i < BOOKS.length; i += 1) {
      const [schoolIdx, localSeller, title, author, publisher, isbn, course, condition, original, price, remark] = BOOKS[i];
      const sellerId = studentIds[globalStudentIndexOf(schoolIdx, localSeller)];
      const [r] = await conn.query(
        `INSERT INTO books (school_id, seller_id, title, author, publisher, isbn, course_name, category,
           condition_level, original_price_cents, price_cents, remark, status, cross_school, view_count, published_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '教材', ?, ?, ?, ?, 'on_sale', ?, ?, ?)`,
        [schoolIds[schoolIdx], sellerId, title, author, publisher, isbn, course,
          condition, original, price, remark, schoolIdx === 0 ? 1 : 0, 10 + i * 3, hours(-48 + i)],
      );
      bookIds.push(r.insertId);
      for (let k = 1; k <= 2; k += 1) {
        await conn.query(
          `INSERT INTO book_images (book_id, school_id, url, sort_order, width, height, size_bytes, ocr_status)
           VALUES (?, ?, ?, ?, 1080, 810, 210000, 'skipped')`,
          [r.insertId, schoolIds[schoolIdx], `/static/demo/book-${i + 1}-${k}.svg`, k],
        );
      }
    }

    // 7) 论坛帖子 + 评论
    const threadIds = [];
    for (let i = 0; i < THREADS.length; i += 1) {
      const [schoolIdx, localAuthor, type, title, content, category] = THREADS[i];
      const authorId = studentIds[globalStudentIndexOf(schoolIdx, localAuthor)];
      const [r] = await conn.query(
        `INSERT INTO threads (school_id, author_id, type, title, content, category, status, view_count, reply_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'published', ?, 0, ?)`,
        [schoolIds[schoolIdx], authorId, type, title, content, category, 30 + i * 7, hours(-36 + i * 2)],
      );
      threadIds.push(r.insertId);
    }
    const floorCounter = {};
    for (const [threadIdx, localAuthor, content] of REPLIES) {
      const threadId = threadIds[threadIdx];
      floorCounter[threadId] = (floorCounter[threadId] || 0) + 1;
      const [schoolIdx] = THREADS[threadIdx];
      const authorId = studentIds[globalStudentIndexOf(schoolIdx, localAuthor)];
      await conn.query(
        `INSERT INTO replies (school_id, thread_id, author_id, floor_no, content, status)
         VALUES (?, ?, ?, ?, ?, 'published')`,
        [schoolIds[schoolIdx], threadId, authorId, floorCounter[threadId], content],
      );
    }
    for (const [threadId, count] of Object.entries(floorCounter)) {
      await conn.query('UPDATE threads SET reply_count = ? WHERE id = ?', [count, threadId]);
    }
    await conn.query(
      `INSERT INTO thread_images (thread_id, school_id, url, sort_order) VALUES (?, ?, ?, 1)`,
      [threadIds[1], schoolIds[0], '/static/demo/thread-2-1.svg'],
    );

    // 8) 私信：买家（陈默）就《高等数学》联系卖家（林晓）
    const [conv] = await conn.query(
      `INSERT INTO conversations (school_id, buyer_id, seller_id, book_id, context_key, last_message_at, last_message_preview)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [schoolIds[0], studentIds[1], studentIds[0], bookIds[0],
        `${Math.min(studentIds[0], studentIds[1])}-${Math.max(studentIds[0], studentIds[1])}-${bookIds[0]}-0`,
        hours(-5), '好的，明天下午图书馆门口面交可以吗？'],
    );
    const convId = conv.insertId;
    const chatPairs = [
      [studentIds[1], '你好，这本《高等数学》还在吗？', hours(-6)],
      [studentIds[0], '在的，九成新，没有笔记', hours(-5.6)],
      [studentIds[1], '20 元可以吗？', hours(-5.3)],
      [studentIds[0], '好的，明天下午图书馆门口面交可以吗？', hours(-5)],
    ];
    for (const [senderId, content, t] of chatPairs) {
      const receiverId = senderId === studentIds[0] ? studentIds[1] : studentIds[0];
      await conn.query(
        `INSERT INTO messages (school_id, conversation_id, sender_id, receiver_id, content, is_read, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`,
        [schoolIds[0], convId, senderId, receiverId, content, t],
      );
    }

    // 9) 订单（资金托管）：A = 已付款（托管中）；B = 已完成（已放款并扣服务费）
    const feeBpsA = SCHOOLS[0].serviceFeeBps;
    const priceA = BOOKS[0][9];
    const feeA = Math.floor((priceA * feeBpsA) / 10000);
    const orderNoA = generateNo('OD');
    const [orderA] = await conn.query(
      `INSERT INTO orders (order_no, school_id, book_id, buyer_id, seller_id, amount_cents, service_fee_bps,
         service_fee_cents, seller_income_cents, status, escrow_status, ship_mode, paid_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', 'held', 'meetup', ?, ?)`,
      [orderNoA, schoolIds[0], bookIds[0], studentIds[1], studentIds[0], priceA, feeBpsA, feeA, priceA - feeA,
        hours(-4), hours(-5)],
    );
    await conn.query('UPDATE books SET status = ? WHERE id = ?', ['locked', bookIds[0]]);

    const feeBpsB = SCHOOLS[1].serviceFeeBps;
    const priceB = BOOKS[6][9];
    const feeB = Math.floor((priceB * feeBpsB) / 10000);
    const orderNoB = generateNo('OD');
    const [orderB] = await conn.query(
      `INSERT INTO orders (order_no, school_id, book_id, buyer_id, seller_id, amount_cents, service_fee_bps,
         service_fee_cents, seller_income_cents, status, escrow_status, ship_mode, express_company, express_no,
         paid_at, shipped_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', 'released', 'mail', '顺丰速运', 'SF1234567890',
         ?, ?, ?, ?)`,
      [orderNoB, schoolIds[1], bookIds[6], studentIds[4], studentIds[3], priceB, feeBpsB, feeB, priceB - feeB,
        days(-6), days(-5), days(-3), days(-7)],
    );
    await conn.query('UPDATE books SET status = ? WHERE id = ?', ['sold', bookIds[6]]);

    const orderLogs = [
      [orderA.insertId, schoolIds[0], null, 'pending_payment', 'create', studentIds[1], '买家下单'],
      [orderA.insertId, schoolIds[0], 'pending_payment', 'paid', 'pay', studentIds[1], '模拟支付成功，资金进入托管'],
      [orderB.insertId, schoolIds[1], null, 'pending_payment', 'create', studentIds[4], '买家下单'],
      [orderB.insertId, schoolIds[1], 'pending_payment', 'paid', 'pay', studentIds[4], '模拟支付成功，资金进入托管'],
      [orderB.insertId, schoolIds[1], 'paid', 'shipped', 'ship', studentIds[3], '卖家发货 顺丰速运 SF1234567890'],
      [orderB.insertId, schoolIds[1], 'shipped', 'completed', 'confirm', studentIds[4], '买家确认收货，放款给卖家'],
    ];
    for (const [orderId, schoolId, from, to, action, operatorId, reason] of orderLogs) {
      await conn.query(
        `INSERT INTO order_status_log (order_id, school_id, from_status, to_status, action, operator_id, operator_role, reason)
         VALUES (?, ?, ?, ?, ?, ?, 'student', ?)`,
        [orderId, schoolId, from, to, action, operatorId, reason],
      );
    }

    // 10) 资金流水（append-only）；余额缓存由流水聚合生成，保证完全一致
    const ledger = [
      [schoolIds[1], studentIds[4], null, 'balance', 'in', 20000, 'recharge', '模拟充值 200 元'],
      [schoolIds[0], studentIds[1], null, 'balance', 'in', 20000, 'recharge', '模拟充值 200 元'],
      [schoolIds[0], studentIds[1], orderA.insertId, 'balance', 'out', priceA, 'pay', '订单支付（转入托管）'],
      [schoolIds[0], studentIds[1], orderA.insertId, 'frozen', 'in', priceA, 'escrow_hold', '资金托管冻结'],
      [schoolIds[1], studentIds[4], orderB.insertId, 'balance', 'out', priceB, 'pay', '订单支付（转入托管）'],
      [schoolIds[1], studentIds[4], orderB.insertId, 'frozen', 'in', priceB, 'escrow_hold', '资金托管冻结'],
      [schoolIds[1], studentIds[4], orderB.insertId, 'frozen', 'out', priceB, 'escrow_release', '确认收货，释放托管'],
      [schoolIds[1], studentIds[3], orderB.insertId, 'balance', 'in', priceB - feeB, 'settle', '订单完成放款（已扣服务费）'],
      [schoolIds[1], platformId, orderB.insertId, 'balance', 'in', feeB, 'fee', '平台服务费'],
    ];
    for (const [schoolId, userId, orderId, account, direction, amount, bizType, remark] of ledger) {
      await conn.query(
        `INSERT INTO wallet_transactions (tx_no, school_id, user_id, order_id, account, direction, amount_cents,
           biz_type, status, idempotency_key, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?)`,
        [generateNo('TX'), schoolId, userId, orderId, account, direction, amount, bizType,
          `seed-${bizType}-${userId}-${orderId ?? 0}`, remark],
      );
    }
    await conn.query(`
      INSERT INTO wallet_accounts (user_id, school_id, balance_cents, frozen_cents)
      SELECT user_id, MIN(school_id),
        COALESCE(SUM(CASE WHEN account = 'balance' THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0),
        COALESCE(SUM(CASE WHEN account = 'frozen'  THEN (CASE WHEN direction = 'in' THEN amount_cents ELSE -amount_cents END) ELSE 0 END), 0)
      FROM wallet_transactions WHERE status = 'success' GROUP BY user_id`);
    await conn.query(`
      UPDATE wallet_accounts wa
      JOIN users u ON u.id = wa.user_id
      SET wa.school_id = COALESCE(u.school_id, wa.school_id)`);

    // 11) 信誉分流水（含正常加分与被投诉扣分）
    const creditLogs = [
      [studentIds[0], schoolIds[0], 2, 'ship_on_time', '按时发货', 'order', orderA.insertId],
      [studentIds[3], schoolIds[1], 1, 'good_review', '收到好评', 'order', orderB.insertId],
      [studentIds[4], schoolIds[1], -5, 'report_light', '投诉成立（轻度）：描述不符', 'report', null],
      [studentIds[7], schoolIds[2], -2, 'adjust', '管理员调整：历史纠纷补偿', 'penalty', null],
    ];
    for (const [userId, schoolId, delta, ruleKey, reason, relType, relId] of creditLogs) {
      const [u] = await conn.query('SELECT credit_score FROM users WHERE id = ?', [userId]);
      const after = Math.max(0, Math.min(100, Number(u[0].credit_score) + delta));
      await conn.query(
        `INSERT INTO credit_logs (user_id, school_id, delta, score_after, rule_key, reason, related_type, related_id, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, schoolId, delta, after, ruleKey, reason, relType, relId, delta < 0 ? days(365) : null],
      );
      await conn.query('UPDATE users SET credit_score = ? WHERE id = ?', [after, userId]);
    }

    // 12) 违禁词库（四级）+ 白名单 + 一条命中留痕
    // 词条格式：[展示名, 关键词或正则, 级别, 分类, 匹配方式, 处置动作, 扣分, 违规次数]
    // 正则词条的 word 存展示名（如「手机号」），normalized 存正则，避免给用户展示正则原文
    for (const [label, pattern, level, cat, matchType, action, scoreDelta, violation] of BANNED_WORDS) {
      await conn.query(
        `INSERT INTO banned_words (word, normalized, level, category, match_type, action, score_delta, violation_count, scope, status, remark)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'global', 'active', ?)`,
        [matchType === 'regex' ? label : pattern,
          matchType === 'regex' ? pattern : normalizeText(pattern),
          level, cat, matchType, action, scoreDelta, violation,
          `${level} ${cat}`],
      );
    }
    for (const [word, level, cat] of WHITELIST_WORDS) {
      await conn.query(
        `INSERT INTO banned_words (word, normalized, level, category, match_type, action, score_delta, violation_count, scope, school_id, status, remark)
         VALUES (?, ?, ?, ?, 'keyword', 'hint', 0, 0, 'school', ?, 'whitelist', '教材书名白名单（避免误伤）')`,
        [word, normalizeText(word), level, cat, schoolIds[0]],
      );
    }
    await conn.query(
      `INSERT INTO word_hits (school_id, user_id, word_id, word, level, scene, target_type, target_id, matched_text, position, action_taken)
       VALUES (?, ?, (SELECT id FROM banned_words WHERE word = '答案' AND scope = 'global' LIMIT 1), '答案', 'L3', 'thread', 'thread', ?, '答案', 12, 'block')`,
      [schoolIds[0], studentIds[2], threadIds[2]],
    );

    // 13) 举报 / 处罚 / 申诉
    const [report1] = await conn.query(
      `INSERT INTO reports (report_no, school_id, reporter_id, target_type, target_id, target_user_id, reason, description,
         status, severity, handler_id, accepted_at, proof_deadline_at, decision, decision_note, decided_at, appeal_deadline_at)
       VALUES (?, ?, ?, 'book', ?, ?, '描述不符', '收到的书缺页，与描述不符', 'decided', 'light', ?, ?, ?, 'valid', '核实成立，扣 5 分并警告', ?, ?)`,
      [generateNo('RP'), schoolIds[1], studentIds[4], bookIds[6], studentIds[3], supportId,
        days(-4), days(-3.5), days(-3), days(-1)],
    );
    await conn.query(
      `INSERT INTO penalties (user_id, school_id, report_id, type, severity, effective_count, reason, start_at, status, appeal_status, operator_id, source)
       VALUES (?, ?, ?, 'warning', 'light', 1, '投诉成立（轻度）：描述不符', ?, 'active', 'none', ?, 'report')`,
      [studentIds[3], schoolIds[1], report1.insertId, days(-3), supportId],
    );
    await conn.query(
      `INSERT INTO reports (report_no, school_id, reporter_id, target_type, target_id, target_user_id, reason, description, status, severity)
       VALUES (?, ?, ?, 'thread', ?, ?, '广告引流', '帖子正文疑似引流到站外', 'pending', 'light')`,
      [generateNo('RP'), schoolIds[0], studentIds[0], threadIds[3], studentIds[0]],
    );

    // 14) 客服工单（进行中）+ 流转日志
    const [ticket] = await conn.query(
      `INSERT INTO tickets (ticket_no, school_id, source, type, priority, subject, description, related_order_id,
         related_user_id, reporter_id, assignee_id, status, first_response_at, first_response_due_at, resolve_due_at)
       VALUES (?, ?, 'user', 'refund', 'urgent', '买家反馈书缺页要求退款', '订单已发货但内容与描述不符，申请退货退款',
         ?, ?, ?, ?, 'processing', ?, ?, ?)`,
      [generateNo('TK'), schoolIds[1], orderB.insertId, studentIds[3], studentIds[4], supportId,
        hours(-3), hours(1), hours(21)],
    );
    const ticketId = ticket.insertId;
    const ticketLogs = [
      ['create', studentIds[4], 'user', null, 'pending', '用户创建工单：买家反馈书缺页要求退款'],
      ['auto_escalate', null, 'system', 'pending', 'escalated', '资金类工单，自动升级为加急'],
      ['claim', supportId, 'staff', 'pending', 'processing', '客服接单，联系买家核实'],
    ];
    for (const [action, operatorId, opType, from, to, note] of ticketLogs) {
      await conn.query(
        `INSERT INTO ticket_logs (ticket_id, school_id, action, operator_id, operator_type, from_status, to_status, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [ticketId, schoolIds[1], action, operatorId, opType, from, to, note],
      );
    }

    // 15) 知识库（AI 客服 FAQ 数据来源）
    for (const [category, question, answer, keywords] of KB_ARTICLES) {
      await conn.query(
        `INSERT INTO kb_articles (school_id, category, question, answer, keywords, status)
         VALUES (NULL, ?, ?, ?, ?, 'published')`,
        [category, question, answer, keywords],
      );
    }

    // 16) 通知
    const notifications = [
      [schoolIds[0], studentIds[0], 'order', '订单已付款', `买家已付款，资金已进入托管：${orderNoA}`, 'order', orderA.insertId],
      [schoolIds[0], studentIds[1], 'order', '订单待发货', '卖家尚未发货，超时将影响信誉分', 'order', orderA.insertId],
      [schoolIds[1], studentIds[4], 'order', '订单已完成', `订单 ${orderNoB} 已完成，感谢使用`, 'order', orderB.insertId],
      [schoolIds[1], studentIds[3], 'penalty', '违规处理通知', '因描述不符投诉成立，已扣 5 分并警告，可在 3 天内申诉', 'report', report1.insertId],
      [schoolIds[1], studentIds[4], 'ticket', '工单已受理', '您的退款工单已加急处理，客服将在 4 小时内响应', 'ticket', ticketId],
      [schoolIds[0], studentIds[2], 'verification', '认证审核中', '学生认证已提交，审核结果将通过站内信通知', 'user_verification', null],
    ];
    for (const [schoolId, userId, type, title, content, relType, relId] of notifications) {
      await conn.query(
        `INSERT INTO notifications (school_id, user_id, type, title, content, related_type, related_id, is_read)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
        [schoolId, userId, type, title, content, relType, relId],
      );
    }

    // 17) 学校开通申请（待审核）
    await conn.query(
      `INSERT INTO school_applications (school_name, province, city, applicant_name, applicant_phone_enc, applicant_phone_last4, applicant_phone_hash, note, status)
       VALUES ('西南财经大学', '四川省', '成都市', '张同学', ?, '0010', ?, '本校二手教材交易需求大，希望开通平台', 'pending')`,
      [encrypt('13700000010'), hmac('13700000010')],
    );

    // 18) 审计日志
    await conn.query(
      `INSERT INTO audit_logs (school_id, actor_id, actor_role, action, target_type, target_id, detail, ip)
       VALUES (?, ?, 'support', 'ticket.claim', 'ticket', ?, CAST(? AS JSON), '127.0.0.1')`,
      [schoolIds[1], supportId, ticketId, JSON.stringify({ note: '客服接单' })],
    );

    await conn.commit();
    logger.info('种子数据写入完成', {
      schools: schoolIds.length, students: studentIds.length, books: bookIds.length,
      threads: threadIds.length, orders: 2, tickets: 1, verificationsPending: 1,
    });
    logger.info(`测试账号密码统一为：${PASSWORD}`);
  } catch (err) {
    await conn.rollback();
    logger.error('种子数据写入失败', { error: err.message, code: err.code });
    throw err;
  } finally {
    await conn.end();
  }
}

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
