-- ============================================================
-- 高校教材循环交易平台 - 初始化结构
-- 约定：
--   1) 业务表全部带 school_id（schools 自身除外），跨校共享表用 school_id NULL 表示平台级
--   2) 金额字段统一 *_cents（分），禁止浮点
--   3) 敏感字段：*_enc（AES-256-GCM 密文）/*_last4/*_mask（脱敏展示）/*_hash（HMAC 盲索引）
--   4) 状态列用 VARCHAR + 应用层枚举校验，便于通过 configs 扩展状态机
-- ============================================================
SET NAMES utf8mb4;

-- ------------------------------------------------------------
-- 1. 学校主数据与配置
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS schools (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL COMMENT '学校名称',
  province VARCHAR(60) NOT NULL COMMENT '省份',
  city VARCHAR(60) NOT NULL COMMENT '城市',
  code VARCHAR(40) NOT NULL COMMENT '学校编码',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending 待开通 / active 已开通 / suspended 停用',
  forum_sections JSON NULL COMMENT '论坛版块配置',
  service_fee_bps INT UNSIGNED NOT NULL DEFAULT 200 COMMENT '平台服务费比例（万分比，200=2%）',
  allowed_categories JSON NULL COMMENT '可发布品类',
  require_student_verification TINYINT(1) NOT NULL DEFAULT 1 COMMENT '是否需要学生认证',
  cross_school_enabled TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否开启跨校专区',
  cross_school_mode VARCHAR(10) NOT NULL DEFAULT 'off' COMMENT 'off 关闭 / mail 仅邮寄',
  remark VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_school_code (code),
  KEY idx_province_city (province, city),
  KEY idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学校主数据';

CREATE TABLE IF NOT EXISTS school_applications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_name VARCHAR(120) NOT NULL,
  province VARCHAR(60) NOT NULL,
  city VARCHAR(60) NOT NULL,
  applicant_name VARCHAR(60) NOT NULL,
  applicant_phone_enc VARBINARY(255) NOT NULL,
  applicant_phone_last4 CHAR(4) NOT NULL,
  applicant_phone_hash CHAR(64) NOT NULL,
  note VARCHAR(500) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/rejected',
  reviewer_id BIGINT UNSIGNED NULL,
  review_note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_status (status),
  KEY idx_phone_hash (applicant_phone_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学校开通申请';

-- ------------------------------------------------------------
-- 2. 用户与账号安全
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NULL COMMENT '学生/校管必填；客服与平台管理员可为空（跨校角色）',
  student_no VARCHAR(32) NULL COMMENT '学号（同校唯一）',
  student_no_mask VARCHAR(32) NULL COMMENT '脱敏学号',
  phone_enc VARBINARY(255) NOT NULL COMMENT '手机号密文',
  phone_last4 CHAR(4) NOT NULL COMMENT '手机号后四位',
  phone_hash CHAR(64) NOT NULL COMMENT '手机号盲索引（全平台唯一）',
  password_hash VARCHAR(100) NULL,
  wechat_openid VARCHAR(64) NULL,
  alipay_user_id VARCHAR(64) NULL,
  nickname VARCHAR(60) NOT NULL,
  avatar_url VARCHAR(500) NULL,
  bio VARCHAR(500) NULL COMMENT '个人简介（需过违禁词检测）',
  real_name_enc VARBINARY(255) NULL,
  real_name_mask VARCHAR(60) NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'student' COMMENT 'student/school_admin/support/platform_admin',
  status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active/banned',
  verification_status VARCHAR(20) NOT NULL DEFAULT 'unverified' COMMENT 'unverified/pending/approved/rejected',
  credit_score INT NOT NULL DEFAULT 100 COMMENT '信誉分缓存（事实来源为 credit_logs）',
  mute_until DATETIME(3) NULL COMMENT '禁言截止（封禁开关 1）',
  trade_ban_until DATETIME(3) NULL COMMENT '禁止交易截止（封禁开关 2）',
  login_ban_until DATETIME(3) NULL COMMENT '禁止登录截止（封禁开关 3）',
  banned_permanently TINYINT(1) NOT NULL DEFAULT 0,
  last_login_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_phone (phone_hash),
  UNIQUE KEY uk_school_student (school_id, student_no),
  UNIQUE KEY uk_wechat (wechat_openid),
  KEY idx_school_role_status (school_id, role, status),
  KEY idx_verification (school_id, verification_status),
  KEY idx_school_credit (school_id, credit_score),
  CONSTRAINT fk_users_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='用户（学生/校管/客服/平台管理员）';

CREATE TABLE IF NOT EXISTS user_verifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  method VARCHAR(20) NOT NULL DEFAULT 'student_card' COMMENT 'student_card/campus_email',
  student_card_image_url VARCHAR(500) NULL,
  campus_email VARCHAR(120) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/rejected',
  reviewer_id BIGINT UNSIGNED NULL,
  review_note VARCHAR(255) NULL,
  submitted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  reviewed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_school_status (school_id, status),
  KEY idx_user (user_id, status),
  CONSTRAINT fk_verify_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_verify_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='学生认证记录（可多次提交）';

CREATE TABLE IF NOT EXISTS payment_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(20) NOT NULL COMMENT 'wechat/alipay/bank',
  account_name_mask VARCHAR(60) NOT NULL COMMENT '户名脱敏',
  account_no_last4 CHAR(4) NOT NULL COMMENT '账号后四位（禁止保存完整卡号）',
  account_no_hash CHAR(64) NOT NULL COMMENT '账号盲索引',
  bank_name VARCHAR(60) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active/unbound/cooling',
  is_default TINYINT(1) NOT NULL DEFAULT 0,
  bound_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  unbind_at DATETIME(3) NULL,
  cooldown_until DATETIME(3) NULL COMMENT '换绑/解绑 24 小时冷却期',
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_type_hash (user_id, type, account_no_hash),
  KEY idx_school_user (school_id, user_id),
  KEY idx_cooldown (cooldown_until),
  CONSTRAINT fk_pay_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_pay_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='收款绑定（脱敏存储）';

CREATE TABLE IF NOT EXISTS sms_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  phone_hash CHAR(64) NOT NULL,
  scene VARCHAR(30) NOT NULL COMMENT 'register/login/reset/bind/unbind',
  status VARCHAR(20) NOT NULL DEFAULT 'sent' COMMENT 'sent/verified/failed',
  ip VARCHAR(64) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_phone_scene (phone_hash, scene, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='短信发送留痕（验证码本体存 Redis）';

-- ------------------------------------------------------------
-- 3. 图书库与论坛
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS books (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  seller_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(200) NOT NULL,
  author VARCHAR(120) NULL,
  publisher VARCHAR(120) NULL,
  isbn VARCHAR(20) NULL,
  course_name VARCHAR(120) NULL,
  category VARCHAR(40) NULL,
  condition_level VARCHAR(20) NOT NULL DEFAULT 'good' COMMENT 'new/like_new/good/fair/poor',
  original_price_cents INT UNSIGNED NOT NULL DEFAULT 0,
  price_cents INT UNSIGNED NOT NULL,
  remark VARCHAR(1000) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'on_sale' COMMENT 'draft/on_sale/locked/sold/off_shelf/banned',
  cross_school TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否允许跨校交易',
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  banned_reason VARCHAR(255) NULL,
  published_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_school_course (school_id, course_name),
  KEY idx_seller (seller_id, status),
  KEY idx_school_price (school_id, price_cents),
  FULLTEXT KEY ft_books (title, author, course_name, isbn) WITH PARSER ngram,
  CONSTRAINT fk_books_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='教材图书';

CREATE TABLE IF NOT EXISTS book_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  book_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  url VARCHAR(500) NOT NULL COMMENT '仅存 URL',
  sort_order INT NOT NULL DEFAULT 0,
  width INT NULL,
  height INT NULL,
  size_bytes INT NULL,
  ocr_status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/skipped/done/failed',
  ocr_text TEXT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_book (book_id, sort_order),
  KEY idx_school_ocr (school_id, ocr_status),
  CONSTRAINT fk_book_img_book FOREIGN KEY (book_id) REFERENCES books (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='图书图片';

CREATE TABLE IF NOT EXISTS threads (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(10) NOT NULL DEFAULT 'sell' COMMENT 'seek 求书 / sell 转让',
  title VARCHAR(200) NOT NULL,
  content TEXT NOT NULL,
  category VARCHAR(40) NULL COMMENT '对应 ForumSections 版块',
  status VARCHAR(20) NOT NULL DEFAULT 'published' COMMENT 'published/hidden/deleted',
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  reply_count INT UNSIGNED NOT NULL DEFAULT 0,
  word_hit_level VARCHAR(4) NULL COMMENT '最近一次违禁词命中级别',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_school_type (school_id, type, created_at),
  KEY idx_author (author_id),
  FULLTEXT KEY ft_threads (title, content) WITH PARSER ngram,
  CONSTRAINT fk_threads_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='论坛帖子';

CREATE TABLE IF NOT EXISTS thread_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  thread_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  url VARCHAR(500) NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_thread (thread_id, sort_order),
  CONSTRAINT fk_thread_img_thread FOREIGN KEY (thread_id) REFERENCES threads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='帖子图片';

CREATE TABLE IF NOT EXISTS replies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  thread_id BIGINT UNSIGNED NOT NULL,
  author_id BIGINT UNSIGNED NOT NULL,
  parent_id BIGINT UNSIGNED NULL COMMENT '楼中楼',
  floor_no INT UNSIGNED NOT NULL DEFAULT 1,
  content VARCHAR(2000) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'published' COMMENT 'published/hidden/deleted',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  deleted_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_thread (thread_id, status, floor_no),
  KEY idx_school_author (school_id, author_id),
  CONSTRAINT fk_replies_thread FOREIGN KEY (thread_id) REFERENCES threads (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='帖子评论/回复';

-- ------------------------------------------------------------
-- 4. 私信
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  buyer_id BIGINT UNSIGNED NOT NULL,
  seller_id BIGINT UNSIGNED NOT NULL,
  book_id BIGINT UNSIGNED NULL COMMENT '关联图书',
  thread_id BIGINT UNSIGNED NULL COMMENT '关联帖子',
  context_key VARCHAR(80) NOT NULL COMMENT '小id-大id-图书id-帖子id，用于会话复用',
  last_message_at DATETIME(3) NULL,
  last_message_preview VARCHAR(200) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active/closed',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_school_context (school_id, context_key),
  KEY idx_school_buyer (school_id, buyer_id, last_message_at),
  KEY idx_school_seller (school_id, seller_id, last_message_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='私信会话';

CREATE TABLE IF NOT EXISTS messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  conversation_id BIGINT UNSIGNED NOT NULL,
  sender_id BIGINT UNSIGNED NOT NULL,
  receiver_id BIGINT UNSIGNED NOT NULL,
  content VARCHAR(2000) NULL,
  image_url VARCHAR(500) NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) NULL,
  word_hit_level VARCHAR(4) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'sent' COMMENT 'sent/blocked/deleted',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_conversation (conversation_id, id),
  KEY idx_school_receiver (school_id, receiver_id, is_read),
  CONSTRAINT fk_msg_conv FOREIGN KEY (conversation_id) REFERENCES conversations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='私信消息';

-- ------------------------------------------------------------
-- 5. 交易与资金托管
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  book_id BIGINT UNSIGNED NOT NULL,
  buyer_id BIGINT UNSIGNED NOT NULL,
  seller_id BIGINT UNSIGNED NOT NULL,
  amount_cents INT UNSIGNED NOT NULL COMMENT '成交金额（=图书售价快照）',
  service_fee_bps INT UNSIGNED NOT NULL COMMENT '下单时的服务费比例快照',
  service_fee_cents INT UNSIGNED NOT NULL DEFAULT 0,
  seller_income_cents INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '卖家实收 = amount - fee',
  status VARCHAR(30) NOT NULL DEFAULT 'pending_payment'
    COMMENT 'pending_payment/paid/shipped/completed/cancelled/refund_requested/refunded/return_requested/disputed/arbitrated_refund/arbitrated_release',
  escrow_status VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT 'none/held/released/refunded',
  ship_mode VARCHAR(10) NOT NULL DEFAULT 'meetup' COMMENT 'meetup 面交 / mail 邮寄',
  express_company VARCHAR(60) NULL,
  express_no VARCHAR(60) NULL,
  paid_at DATETIME(3) NULL,
  shipped_at DATETIME(3) NULL,
  auto_confirm_at DATETIME(3) NULL COMMENT '发货后 N 天自动确认收货；争议时置空暂停',
  completed_at DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  refunded_at DATETIME(3) NULL,
  refund_amount_cents INT UNSIGNED NOT NULL DEFAULT 0,
  dispute_reason VARCHAR(500) NULL,
  dispute_at DATETIME(3) NULL,
  arbitration_result VARCHAR(30) NULL COMMENT 'release/refund',
  arbitrated_at DATETIME(3) NULL,
  arbitrator_id BIGINT UNSIGNED NULL,
  cancel_reason VARCHAR(255) NULL,
  remark VARCHAR(500) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 0,
  -- 生成列 + 唯一索引 = MySQL 的部分唯一索引：保证「同一本书同一时刻只有一个有效订单」
  active_book_id BIGINT UNSIGNED GENERATED ALWAYS AS (
    CASE WHEN status IN ('pending_payment','paid','shipped','refund_requested','return_requested','disputed')
         THEN book_id ELSE NULL END
  ) STORED,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_order_no (order_no),
  UNIQUE KEY uk_active_book (active_book_id),
  KEY idx_school_buyer (school_id, buyer_id, status, created_at),
  KEY idx_school_seller (school_id, seller_id, status, created_at),
  KEY idx_auto_confirm (status, auto_confirm_at),
  KEY idx_book (book_id),
  CONSTRAINT fk_orders_school FOREIGN KEY (school_id) REFERENCES schools (id),
  CONSTRAINT fk_orders_book FOREIGN KEY (book_id) REFERENCES books (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单（资金托管）';

CREATE TABLE IF NOT EXISTS order_status_log (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  order_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  from_status VARCHAR(30) NULL,
  to_status VARCHAR(30) NOT NULL,
  action VARCHAR(40) NOT NULL COMMENT 'create/pay/ship/confirm/cancel/refund/dispute/arbitrate/auto_confirm',
  operator_id BIGINT UNSIGNED NULL COMMENT '为空表示系统操作',
  operator_role VARCHAR(20) NULL,
  reason VARCHAR(500) NULL,
  snapshot JSON NULL COMMENT '操作时的订单快照（证据链）',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_order (order_id, id),
  KEY idx_school (school_id, created_at),
  CONSTRAINT fk_osl_order FOREIGN KEY (order_id) REFERENCES orders (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='订单状态流转日志';

CREATE TABLE IF NOT EXISTS wallet_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  balance_cents INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '派生缓存：必须等于流水求和',
  frozen_cents INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '冻结（托管中/提现中）',
  version INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_user (user_id),
  KEY idx_school (school_id),
  CONSTRAINT fk_wallet_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='钱包账户（余额为流水派生缓存）';

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  tx_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  order_id BIGINT UNSIGNED NULL COMMENT '关联订单，可按订单号追溯每一笔钱',
  withdraw_id BIGINT UNSIGNED NULL,
  account VARCHAR(10) NOT NULL DEFAULT 'balance' COMMENT 'balance 可用 / frozen 冻结',
  direction VARCHAR(3) NOT NULL COMMENT 'in 入账 / out 出账',
  amount_cents INT UNSIGNED NOT NULL,
  biz_type VARCHAR(30) NOT NULL COMMENT 'recharge/pay/escrow_hold/escrow_release/refund/withdraw_freeze/withdraw_paid/withdraw_reject/fee/settle/adjust',
  status VARCHAR(20) NOT NULL DEFAULT 'success' COMMENT 'pending/success/failed',
  balance_after_cents BIGINT NOT NULL DEFAULT 0,
  frozen_after_cents BIGINT NOT NULL DEFAULT 0,
  idempotency_key VARCHAR(120) NULL COMMENT '幂等键（唯一），防重复扣款',
  remark VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_tx_no (tx_no),
  UNIQUE KEY uk_idem (idempotency_key),
  KEY idx_user_time (user_id, created_at),
  KEY idx_school_time (school_id, created_at),
  KEY idx_order (order_id),
  KEY idx_biz (biz_type, status),
  CONSTRAINT fk_wt_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='资金流水（append-only，禁止修改）';

CREATE TABLE IF NOT EXISTS withdraw_requests (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  withdraw_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  payment_account_id BIGINT UNSIGNED NOT NULL,
  amount_cents INT UNSIGNED NOT NULL,
  fee_cents INT UNSIGNED NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/processing/paid/rejected',
  arrival_type VARCHAR(20) NOT NULL DEFAULT 'instant' COMMENT 'instant 即时到账 / delayed 延迟到账',
  expect_at DATETIME(3) NULL COMMENT '预计到账时间（受限档位 +24h）',
  reviewed_by BIGINT UNSIGNED NULL,
  reviewed_at DATETIME(3) NULL,
  reject_reason VARCHAR(255) NULL,
  idempotency_key VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_withdraw_no (withdraw_no),
  UNIQUE KEY uk_idem (idempotency_key),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_user (user_id, created_at),
  CONSTRAINT fk_wr_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='提现申请（一期为模拟打款）';

-- ------------------------------------------------------------
-- 6. 风控：信誉分 / 举报 / 处罚 / 申诉 / 违禁词
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  delta INT NOT NULL COMMENT '正数为加分，负数为扣分',
  score_after INT NOT NULL,
  rule_key VARCHAR(60) NOT NULL COMMENT '规则键，来自 configs.credit.rules',
  reason VARCHAR(255) NOT NULL,
  related_type VARCHAR(30) NULL COMMENT 'order/report/penalty/word_hit',
  related_id BIGINT UNSIGNED NULL,
  expires_at DATETIME(3) NULL COMMENT '轻度违规滚动过期时间',
  rolled_back TINYINT(1) NOT NULL DEFAULT 0 COMMENT '申诉成功后的回滚标记',
  operator_id BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_user_time (user_id, created_at),
  KEY idx_school_time (school_id, created_at),
  KEY idx_expire (expires_at),
  KEY idx_rule (rule_key),
  CONSTRAINT fk_cl_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='信誉分流水（append-only）';

CREATE TABLE IF NOT EXISTS reports (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  report_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  reporter_id BIGINT UNSIGNED NOT NULL,
  target_type VARCHAR(20) NOT NULL COMMENT 'book/thread/reply/message/user/order',
  target_id BIGINT UNSIGNED NOT NULL,
  target_user_id BIGINT UNSIGNED NULL COMMENT '被投诉人',
  reason VARCHAR(60) NOT NULL,
  description VARCHAR(1000) NULL,
  evidence_enc VARBINARY(4000) NULL COMMENT '证据 JSON 密文（分级授权访问）',
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/accepted/rejected/proving/decided/appealed/closed',
  severity VARCHAR(20) NOT NULL DEFAULT 'light' COMMENT 'light/serious/severe',
  handler_id BIGINT UNSIGNED NULL,
  accepted_at DATETIME(3) NULL,
  proof_deadline_at DATETIME(3) NULL COMMENT '受理后 48 小时举证截止',
  proof_content VARCHAR(1000) NULL,
  decision VARCHAR(20) NULL COMMENT 'valid 成立 / invalid 不成立',
  decision_note VARCHAR(500) NULL,
  decided_at DATETIME(3) NULL,
  appeal_deadline_at DATETIME(3) NULL COMMENT '裁定后 3 天申诉期',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_report_no (report_no),
  UNIQUE KEY uk_reporter_target (school_id, reporter_id, target_type, target_id),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_target_user (school_id, target_user_id, status),
  CONSTRAINT fk_reports_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='举报/投诉';

CREATE TABLE IF NOT EXISTS penalties (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  report_id BIGINT UNSIGNED NULL,
  type VARCHAR(20) NOT NULL COMMENT 'warning/mute/trade_ban/login_ban/permanent_ban',
  severity VARCHAR(20) NOT NULL DEFAULT 'light' COMMENT 'light/serious/severe',
  effective_count INT UNSIGNED NOT NULL DEFAULT 1 COMMENT '累计成立次数（含本次）',
  reason VARCHAR(500) NOT NULL,
  start_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  end_at DATETIME(3) NULL COMMENT '为空表示永久',
  status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active/expired/revoked',
  appeal_status VARCHAR(20) NOT NULL DEFAULT 'none' COMMENT 'none/pending/approved/rejected',
  operator_id BIGINT UNSIGNED NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'report' COMMENT 'report/word_hit/system/admin',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_user_time (user_id, created_at),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_expire (status, end_at),
  CONSTRAINT fk_pen_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='处罚记录';

CREATE TABLE IF NOT EXISTS appeals (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  appeal_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  penalty_id BIGINT UNSIGNED NULL,
  report_id BIGINT UNSIGNED NULL,
  reason VARCHAR(1500) NOT NULL,
  evidence_enc VARBINARY(4000) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/rejected',
  reviewer_id BIGINT UNSIGNED NULL,
  review_note VARCHAR(500) NULL,
  reviewed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_appeal_no (appeal_no),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_user (user_id, created_at),
  CONSTRAINT fk_appeals_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='申诉';

CREATE TABLE IF NOT EXISTS banned_words (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  word VARCHAR(120) NOT NULL,
  normalized VARCHAR(120) NOT NULL COMMENT '归一化后的匹配串（regex 类型存正则）',
  level VARCHAR(4) NOT NULL COMMENT 'L1 提示 / L2 拦截 / L3 违规 / L4 严重',
  category VARCHAR(40) NULL COMMENT '联系方式/引流/违规交易/涉黄赌诈/辱骂',
  match_type VARCHAR(10) NOT NULL DEFAULT 'keyword' COMMENT 'keyword/regex',
  action VARCHAR(20) NOT NULL DEFAULT 'hint' COMMENT 'hint/mask/block/delete',
  score_delta INT NOT NULL DEFAULT 0 COMMENT '命中扣分（负数）',
  violation_count INT NOT NULL DEFAULT 0 COMMENT '是否计入违规次数',
  scope VARCHAR(10) NOT NULL DEFAULT 'global' COMMENT 'global/school',
  school_id BIGINT UNSIGNED NULL COMMENT 'school 作用域时必填',
  status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active/disabled/whitelist',
  remark VARCHAR(255) NULL,
  created_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_word_scope (word, scope, school_id),
  KEY idx_scope_status (scope, school_id, status),
  KEY idx_level (level)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='违禁词库（四级）';

CREATE TABLE IF NOT EXISTS word_hits (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  word_id BIGINT UNSIGNED NULL,
  word VARCHAR(120) NOT NULL,
  level VARCHAR(4) NOT NULL,
  scene VARCHAR(20) NOT NULL COMMENT 'book/thread/reply/message/bio/image_ocr/chat',
  target_type VARCHAR(30) NULL,
  target_id BIGINT UNSIGNED NULL,
  matched_text VARCHAR(200) NOT NULL COMMENT '原文命中的片段（用于证据反查）',
  position INT NOT NULL DEFAULT 0 COMMENT '原文起始下标',
  action_taken VARCHAR(30) NOT NULL COMMENT 'hint/mask/block/delete/ticket/penalty',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_school_user (school_id, user_id, created_at),
  KEY idx_level_time (level, created_at),
  KEY idx_target (target_type, target_id),
  CONSTRAINT fk_wh_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='违禁词命中留痕';

-- ------------------------------------------------------------
-- 7. 通知 / 客服 / 系统配置
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  type VARCHAR(40) NOT NULL COMMENT 'order/verification/report/penalty/ban/ticket/word/withdraw/system',
  title VARCHAR(200) NOT NULL,
  content VARCHAR(1000) NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'inbox' COMMENT 'inbox/wechat/sms',
  related_type VARCHAR(30) NULL,
  related_id BIGINT UNSIGNED NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  read_at DATETIME(3) NULL,
  sent_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  status VARCHAR(20) NOT NULL DEFAULT 'sent' COMMENT 'pending/sent/failed',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_user_read (user_id, is_read, created_at),
  KEY idx_school_time (school_id, created_at),
  CONSTRAINT fk_notify_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='站内信/通知';

CREATE TABLE IF NOT EXISTS tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  source VARCHAR(20) NOT NULL DEFAULT 'user' COMMENT 'user/ai/report/word_hit/system',
  type VARCHAR(20) NOT NULL DEFAULT 'other' COMMENT 'order/refund/account/content/other',
  priority VARCHAR(20) NOT NULL DEFAULT 'normal' COMMENT 'normal/urgent（资金类为 urgent）',
  subject VARCHAR(200) NOT NULL,
  description VARCHAR(2000) NULL,
  related_order_id BIGINT UNSIGNED NULL,
  related_user_id BIGINT UNSIGNED NULL COMMENT '涉及用户（被投诉人/申诉人）',
  reporter_id BIGINT UNSIGNED NULL,
  assignee_id BIGINT UNSIGNED NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending' COMMENT 'pending/processing/resolved/closed/escalated',
  first_response_at DATETIME(3) NULL,
  first_response_due_at DATETIME(3) NULL COMMENT 'SLA 首次响应时限',
  resolve_due_at DATETIME(3) NULL COMMENT 'SLA 处理时限',
  escalated TINYINT(1) NOT NULL DEFAULT 0,
  escalated_at DATETIME(3) NULL,
  resolution VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ticket_no (ticket_no),
  KEY idx_school_status (school_id, status, created_at),
  KEY idx_assignee (assignee_id, status),
  KEY idx_priority_due (priority, first_response_due_at),
  KEY idx_resolve_due (status, resolve_due_at),
  CONSTRAINT fk_tickets_school FOREIGN KEY (school_id) REFERENCES schools (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客服工单';

CREATE TABLE IF NOT EXISTS ticket_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ticket_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  action VARCHAR(40) NOT NULL COMMENT 'create/claim/reply/escalate/resolve/close/auto_escalate/transfer',
  operator_id BIGINT UNSIGNED NULL,
  operator_type VARCHAR(20) NOT NULL DEFAULT 'system' COMMENT 'user/ai/staff/system',
  from_status VARCHAR(20) NULL,
  to_status VARCHAR(20) NULL,
  note VARCHAR(1000) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_ticket (ticket_id, id),
  KEY idx_school_time (school_id, created_at),
  CONSTRAINT fk_tlog_ticket FOREIGN KEY (ticket_id) REFERENCES tickets (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='工单流转日志';

CREATE TABLE IF NOT EXISTS chat_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_no VARCHAR(40) NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  user_id BIGINT UNSIGNED NOT NULL,
  channel VARCHAR(20) NOT NULL DEFAULT 'ai' COMMENT 'ai/human',
  ticket_id BIGINT UNSIGNED NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'active' COMMENT 'active/transferred/closed',
  context JSON NULL COMMENT '会话上下文（最近订单、意图栈等）',
  unresolved_rounds INT UNSIGNED NOT NULL DEFAULT 0 COMMENT '连续未解决轮数（>=2 转人工）',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_session_no (session_no),
  KEY idx_school_user (school_id, user_id, status),
  CONSTRAINT fk_cs_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客服会话';

CREATE TABLE IF NOT EXISTS chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  session_id BIGINT UNSIGNED NOT NULL,
  school_id BIGINT UNSIGNED NOT NULL,
  role VARCHAR(10) NOT NULL COMMENT 'user/ai/staff/system',
  content VARCHAR(2000) NOT NULL,
  intent VARCHAR(40) NULL COMMENT 'faq/order_query/refund_request/create_ticket/other',
  confidence DECIMAL(4,3) NULL,
  tool_calls JSON NULL COMMENT 'AI 调用的工具与结果（留痕）',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_session (session_id, id),
  KEY idx_school_time (school_id, created_at),
  CONSTRAINT fk_cm_session FOREIGN KEY (session_id) REFERENCES chat_sessions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客服消息与会话留痕';

CREATE TABLE IF NOT EXISTS kb_articles (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NULL COMMENT 'NULL 表示平台通用知识',
  category VARCHAR(40) NOT NULL DEFAULT '通用',
  question VARCHAR(300) NOT NULL,
  answer TEXT NOT NULL,
  keywords VARCHAR(300) NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'published' COMMENT 'published/draft/offline',
  view_count INT UNSIGNED NOT NULL DEFAULT 0,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_scope_status (school_id, status),
  FULLTEXT KEY ft_kb (question, answer, keywords) WITH PARSER ngram
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='客服知识库';

CREATE TABLE IF NOT EXISTS configs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope VARCHAR(10) NOT NULL DEFAULT 'platform' COMMENT 'platform/school',
  school_id BIGINT UNSIGNED NULL COMMENT 'scope=school 时必填',
  config_key VARCHAR(80) NOT NULL,
  config_value JSON NOT NULL,
  description VARCHAR(255) NULL,
  version INT UNSIGNED NOT NULL DEFAULT 1,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_config (scope, school_id, config_key),
  KEY idx_key (config_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='规则阈值配置（禁止硬编码）';

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NULL,
  actor_id BIGINT UNSIGNED NULL,
  actor_role VARCHAR(20) NULL,
  action VARCHAR(60) NOT NULL,
  target_type VARCHAR(30) NULL,
  target_id BIGINT UNSIGNED NULL,
  detail JSON NULL,
  ip VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  KEY idx_actor (actor_id, created_at),
  KEY idx_school_time (school_id, created_at),
  KEY idx_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='审计日志（敏感操作与跨校访问留痕）';

CREATE TABLE IF NOT EXISTS idempotency_records (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  school_id BIGINT UNSIGNED NULL,
  user_id BIGINT UNSIGNED NULL,
  scope VARCHAR(60) NOT NULL,
  idem_key VARCHAR(120) NOT NULL,
  request_hash CHAR(64) NOT NULL,
  response_snapshot JSON NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'processing' COMMENT 'processing/done',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (id),
  UNIQUE KEY uk_idem (scope, idem_key),
  KEY idx_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='接口幂等记录';

CREATE TABLE IF NOT EXISTS job_locks (
  job_name VARCHAR(60) NOT NULL,
  locked_until DATETIME(3) NOT NULL,
  locked_by VARCHAR(80) NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (job_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci COMMENT='定时任务分布式锁';

CREATE TABLE IF NOT EXISTS schema_migrations (
  version VARCHAR(60) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (version)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
