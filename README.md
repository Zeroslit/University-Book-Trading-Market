**简体中文** | [English](./README.en.md)

# 校园教材循环 · 全国高校教材循环交易平台

面向全国高校的大学生教材循环交易平台，包含**多校隔离、图书库、论坛、私信、交易资金托管、钱包、通知、信誉分与违规处罚、四级违禁词风控、AI+人工客服工单、管理后台**等完整能力。

> 一期为**可运行演示环境**：短信验证码、支付、微信授权均为**模拟实现**，**不接入真实支付与真实银行卡鉴权**，平台**不存储完整卡号、CVV 或支付密码**。

---

## 零、在线演示（无需安装，打开即用）

**👉 <https://zeroslit.github.io/University-Book-Trading-Market/>** —— 进入后点「进入在线演示」

直达演示应用：**<https://zeroslit.github.io/University-Book-Trading-Market/web/>**

- 这是**纯静态演示版**：前端 +「浏览器内模拟后端」（`web/src/demo/`），不需要 Node / MySQL / Redis，数据为种子数据库快照。
- 能力与真实部署一致：多校隔离、图书库、论坛、私信、下单资金托管、放款与退款、信誉分与处罚梯度、四级违禁词、工单 SLA、AI 客服、管理后台都可点、可走通。
- 所有写操作只作用于浏览器内存（localStorage），**不会写入任何数据库**；支付、短信、微信授权均为模拟实现。
- 登录页提供「演示环境 · 一键切换角色」：三所高校的学生、学校管理员、人工客服、平台管理员。
- 分享链接可直接进入指定角色，例如 `/web/login?demo=13800000001`（学生）、`?demo=13900000003`（平台管理员）。
- 顶部「重置演示数据」可恢复初始种子状态。

> 模拟后端的路径、参数、错误码与真实后端**一一对应**（直接复用 `server/src/lib/` 的文本归一化、违禁词匹配、状态机、分页与错误码），
> 因此页面代码零改动即可在「真实后端」与「纯静态演示」两种模式下运行：`web/src/api/client.js` 依据 `VITE_DEMO` 切换请求通道。

---

## 一、技术栈与架构

| 层 | 技术 |
| --- | --- |
| 前端 | Vue 3 + Vite（响应式，移动优先；无第三方 UI 库，轻量设计系统） |
| 后端 | Node.js 20 + Express 4，RESTful JSON，统一响应体与错误码 |
| 数据库 | MySQL 8（utf8mb4，事务 + 行锁 + 生成列唯一索引） |
| 缓存 | Redis 7（缓存、限流、短信验证码、幂等锁；不可用时开发环境自动降级为内存实现） |
| 图片 | 前端压缩到长边 ≤1080px 后上传，落盘 `server/uploads/<日期>/`，库中只存 URL |
| 部署 | Docker Compose 一键启动（MySQL + Redis + API + Web/Nginx） |

### 分层结构

```
请求 → requestId → 安全头 → CORS → JSON 解析
     → authenticate（JWT）→ schoolScope（学校过滤唯一来源）→ rateLimit
     → guards（认证/发布/交易准入）→ validate（zod）→ 业务路由（SQL 全部带 school_id）
     → 统一响应 { code, message, data, requestId }
     → errorHandler（业务错误码 → HTTP 状态码，含死锁重试与敏感信息脱敏）
```

后端目录：`server/src/{config,lib,db,middleware,services,modules,jobs}`，前端目录：`web/src/{api,stores,router,components,views,utils,styles}`。
演示版目录：`web/src/demo/{server.js,store.js,rules.js,words.js,handlers/*,dataset.js}`（浏览器内模拟后端，与真实接口同契约）。
完整目录说明见 `docs/03-目录结构.md`。

---

## 二、启动步骤

### 方式一：Docker Compose（推荐）

```bash
cp .env.example .env          # 按需修改密钥与端口
docker compose up -d --build  # 首次会自动执行建表 + 种子数据
```

- Web： http://localhost:8080
- API： http://localhost:3000/api/v1 （健康检查 `GET /health`）
- 之后如需重置演示数据：`docker compose run --rm db-init`

### 方式二：本地开发（Windows / macOS / Linux）

```bash
# 1) 准备 MySQL 8 与 Redis（Redis 可缺省，后端会降级为内存实现）
# 2) 后端
cd server
npm install
cp .env.example .env          # 按实际数据库地址修改 DB_HOST/DB_PORT/DB_PASSWORD
npm run db:reset              # 建表 + 种子数据（幂等，可重复执行）
npm run dev                   # http://127.0.0.1:3000

# 3) 前端（另开终端，Vite 已把 /api、/static 代理到 3000）
cd web
npm install
npm run dev                   # http://127.0.0.1:5173
```

辅助脚本：`scripts/init-db.ps1`（Windows）、`scripts/init-db.sh`（macOS/Linux）。

### 测试与构建

```bash
cd server && npm test         # 57 项单元 + 集成测试（需 MySQL）
cd web && npm run build       # 生产构建
```

### 纯静态演示版构建与发布

演示模式由环境变量开关控制，不影响本地开发与生产构建：

```bash
cd web

# 1) 本地预览演示版（浏览器内模拟后端，不需要启动 Node / MySQL）
VITE_DEMO=true npm run dev
#    Windows PowerShell: $env:VITE_DEMO='true'; npm run dev

# 2) 构建 GitHub Pages 子路径演示版（base 必须指向站点子路径，否则路由与静态资源会 404）
VITE_DEMO=true VITE_BASE=/University-Book-Trading-Market/web/ npm run build
#    PowerShell: $env:VITE_DEMO='true'; $env:VITE_BASE='/University-Book-Trading-Market/web/'; npm run build
#    产物：web/dist（自动包含 web/public/static/demo 下的演示封面图）

# 3) 刷新演示数据集：从种子数据库导出到 web/src/demo/dataset.js，并同步演示封面图
node scripts/build-demo-dataset.mjs   # 需先执行 cd server && npm run db:reset
```

发布方式：把 `web/dist` 的内容放到 `gh-pages` 分支的 `web/` 目录，并在分支根目录放置 `.nojekyll`（否则以 `_` 开头的文件名会被 Jekyll 忽略）；仓库 Pages 发布源指向 `gh-pages` 分支根目录。分支根目录的 `404.html` 是 SPA 兜底页，用于让 `/web/login` 这类深链接可直接打开。


#### 国内镜像站部署（Cloudflare Pages / Netlify）

GitHub Pages（`*.github.io`）在国内访问时通时不通，属网络可达性问题，与代码无关。仓库内置一套「同代码、零改动」镜像方案：

```powershell
# 1) 构建镜像产物（base=/web/，落到 deploy/dist）
.\deploy\build-mirror.ps1

# 2) 网页方式：把 deploy/dist 整个文件夹拖到 Cloudflare Pages 的 Upload assets
#    或命令行方式（需 Cloudflare API Token，见 deploy/README-mirror-deploy.md）
.\deploy\deploy-cloudflare.ps1
```

得到形如 `https://campus-book-demo.pages.dev/`（落地页）与 `https://campus-book-demo.pages.dev/web/`（演示应用）的地址，
国内可达性明显好于 `github.io`。完整步骤、Netlify / 腾讯云 EdgeOne 备选方案与常见问题见 [`deploy/README-mirror-deploy.md`](deploy/README-mirror-deploy.md)。

### 种子数据与演示账号

密码统一 `Test@123456`；开发环境短信验证码固定 `123456`。

| 角色 | 账号 | 说明 |
| --- | --- | --- |
| 学生 | `13800000001` ~ `13800000009` | 三所高校各 3 名（江南大学 / 郑州轻工业大学 / 成都理工大学） |
| 学校管理员 | `13900000001` | 江南大学，只能管理本校数据 |
| 人工客服 | `13900000002` | 跨校，需在导航栏选择学校后操作 |
| 平台管理员 | `13900000003` | 平台级：学校开通、规则阈值、审计日志、永久封禁 |

种子规模：3 所学校、12 个用户、10 本教材、5 个帖子 + 6 条评论、2 笔托管订单（一笔 `paid` 托管中、一笔 `completed` 已放款）、1 个进行中的客服工单、1 个待审核的学生认证、1 条待审核的学校开通申请、26 条违禁词、8 条知识库 FAQ、25 项规则配置。

---

## 三、接口文档

- 统一前缀 `/api/v1`；统一响应体 `{ code, message, data, requestId }`，分页数据为 `{ list, total, page, pageSize, hasMore }`。
- 鉴权：`Authorization: Bearer <accessToken>`；资金/下单等写操作建议携带 `Idempotency-Key`。
- 完整接口清单（含参数、错误码、示例）：`docs/05-接口清单.md`。前端调用点统一收敛在 `web/src/api/index.js`。

| 模块 | 主要接口 |
| --- | --- |
| 认证 | `POST /auth/sms/send`、`POST /auth/register`、`POST /auth/login`、`POST /auth/login/wechat`、`GET /auth/me`、`POST /auth/password/reset` |
| 学校 | `GET /schools`（省市/关键词搜索）、`GET /schools/provinces`、`POST /schools/applications`（申请开通）、`GET /schools/applications/list`、`POST /schools/applications/:id/review` |
| 用户 | `GET/PATCH /users/me/profile`、`GET /users/me/credit`、`GET /users/me/credit/logs`、`GET /users/:id/public` |
| 学生认证 | `POST /verifications`、`GET /verifications/me`、`GET /verifications`、`POST /verifications/:id/review` |
| 收款绑定 | `GET/POST /payment-accounts`、`POST /payment-accounts/:id/unbind/code`、`POST /payment-accounts/:id/unbind`、`POST /payment-accounts/:id/default` |
| 上传 | `POST /uploads/image`（仅存 URL） |
| 图书库 | `GET /books`、`GET /books/:id`、`POST /books`、`PATCH /books/:id`、`POST /books/:id/off-shelf`、`POST /books/:id/relist` |
| 论坛 | `GET/POST /threads`、`GET/PATCH/DELETE /threads/:id`、`POST /threads/:id/replies`、`DELETE /replies/:id` |
| 私信 | `GET/POST /conversations`、`GET/POST /conversations/:id/messages` |
| 订单 | `GET/POST /orders`、`GET /orders/:id`、`POST /orders/:id/{pay,cancel,ship,confirm,refund-request,return-request,refund/agree,refund/reject,dispute,arbitrate}` |
| 钱包 | `GET /wallet`、`GET /wallet/transactions`、`POST /wallet/recharge`、`POST /wallet/withdraw`、`GET /wallet/withdrawals` |
| 通知 | `GET /notifications`、`GET /notifications/unread-count`、`POST /notifications/:id/read`、`POST /notifications/read-all` |
| 风控 | `POST /words/check`、`GET/POST/PATCH/DELETE /admin/banned-words`、`GET /admin/banned-words/hits` |
| 投诉申诉 | `POST /reports`、`GET /reports`、`POST /reports/:id/{accept,proof,decide}`、`POST /appeals`、`GET /appeals`、`POST /appeals/:id/review` |
| 客服 | `POST /chat/sessions`、`GET /chat/sessions/:id`、`POST /chat/sessions/:id/messages`、`POST /chat/sessions/:id/transfer`、`GET/POST /tickets`、`GET /tickets/stats`、`POST /tickets/:id/{claim,reply,resolve,escalate}`、`GET /kb/articles` |
| 管理后台 | `GET /admin/dashboard`、`GET/POST/PATCH /admin/schools`、`GET /admin/users`、`POST /admin/users/:id/{ban,unban}`、`GET /admin/users/:id/risk`、`GET /admin/contents`、`POST /admin/contents/:type/:id/review`、`GET /admin/orders`、`GET /admin/configs`、`PUT /admin/configs/:key`、`GET /admin/audit-logs` |

### 关键错误码

| 码 | 含义 | HTTP |
| --- | --- | --- |
| 40302 | 跨校角色未显式指定 `schoolId` | 403 |
| 40304 | 未通过学生认证（仅可浏览） | 403 |
| 40306 | 被限制交易 | 403 |
| 40308 | 信誉档位禁止发布/交易 | 403 |
| 40402/40403 | 跨校读取教材/订单统一返回「不存在」 | 404 |
| 40904 | 教材已被下单/已有进行中订单 | 409 |
| 40906 | 余额不足 | 409 |
| 40907 | 幂等重复请求（已忽略或返回首次结果） | 409 |
| 42201/42202 | 内容被拦截（L2/L3） | 422 |
| 42203 | L1 提示词已打码（允许发布） | 200 |

---

## 四、数据表说明

共 35 张表（`server/src/db/migrations/001_init.sql`），全部业务表都带 `school_id`：

| 分组 | 表 | 说明 |
| --- | --- | --- |
| 主数据 | `schools`、`school_applications` | 学校主数据（服务费、跨校开关、论坛版块、是否需要认证）与开通申请 |
| 账号 | `users`、`user_verifications`、`payment_accounts`、`sms_logs` | 用户（`school_id + student_no` 联合唯一、手机号全平台唯一）、学生认证、收款绑定（只存后四位 + 盲索引）、短信日志 |
| 图书 | `books`、`book_images` | 教材与图片（`book_images.url` 只存 URL） |
| 论坛 | `threads`、`thread_images`、`replies` | 求书帖/转让帖、帖图、评论与楼中楼 |
| 沟通 | `conversations`、`messages` | 可关联图书或帖子的会话与消息 |
| 交易 | `orders`、`order_status_log` | 订单（`active_book_id` 生成列 + 唯一索引保证同一本书同一时刻只有一个有效订单）、状态流转日志 |
| 资金 | `wallet_accounts`、`wallet_transactions`、`withdraw_requests` | 钱包账户快照、**全部资金流水（唯一真相）**、提现申请 |
| 信誉 | `credit_logs` | 信誉分变动明细（含过期时间与回滚标记） |
| 风控 | `reports`、`penalties`、`appeals` | 举报-举证-裁定、处罚记录（含申诉状态与回滚）、申诉 |
| 违禁词 | `banned_words`、`word_hits` | 四级词库（支持正则与白名单）、命中留痕（词、位置、匹配文本、处置） |
| 通知 | `notifications` | 站内信 + 微信订阅消息（模拟）投递记录 |
| 客服 | `tickets`、`ticket_logs`、`chat_sessions`、`chat_messages`、`kb_articles` | 工单与流转日志、AI/人工会话与消息、知识库 FAQ |
| 平台 | `configs`、`audit_logs`、`idempotency_records`、`job_locks`、`schema_migrations` | 规则阈值、审计留痕、幂等记录、定时任务分布式锁、迁移记录 |

---

## 五、规则配置说明（全部配置化，禁止写死）

所有阈值存于 `configs` 表：`scope='platform'` 为全局默认，`scope='school'` 为学校覆盖（学校级优先）。
读取入口统一为 `server/src/services/config.service.js`（带缓存与失效），后台可通过 `GET /admin/configs`、`PUT /admin/configs/:key` 调整。

| Key | 作用 |
| --- | --- |
| `credit.tiers` / `credit.bounds` / `credit.tier_permissions` | 信誉分档位（90/70/50/30 分界）、分值上下限、档位联动权限（挂书数量、提现时效、能否发布/交易） |
| `credit.rules` | 加减分规则：按时发货 +2、完成好评 +1、连续 10 单无纠纷 +5、逾期未发货 −5、描述不符 −10、投诉成立（轻）−5、违禁词 −3、刷单 −30 |
| `credit.light_violation_expire_months` / `credit.clean_months_clear_count` | 轻度违规滚动过期月数与连续无违规消除次数口径 |
| `penalty.escalation` | 处罚梯度：第 1–2 次警告、第 3 次禁言 3 天 + 扣 5 分、第 4 次限制交易 7 天、第 5 次封禁 7 天、第 6–9 次逐次加重、第 10 次永久封禁；严重违规一票永久封禁 |
| `banned_word.penalty` / `banned_word.normalize` / `banned_word.escalation` | L1–L4 处置动作与扣分、归一化开关（去噪/全半角/繁简/拼音谐音）、累计禁言阈值（L1 同日 3 次禁言 1 天；L2/L3 累计 3 次禁言 7 天、5 次禁发帖 30 天） |
| `order.state_machine` / `order.auto_confirm_days` / `order.ship_modes` / `order.service_fee_bps` / `order.ship_deadline_days` | 订单状态机、发货后自动确认天数（默认 7 天，争议时暂停）、交付方式、服务费比例（基点）、发货时限 |
| `order.report_proof_hours` / `report.appeal_days` | 被投诉人举证时限（48 小时）、申诉期（3 天） |
| `ticket.sla` / `ticket.auto_escalate` | 工单 SLA（普通 24 小时首响、资金类 4 小时）与超时自动升级 |
| `ai.escalate_rules` | AI 客服转人工条件（用户要求、连续 2 轮未解决、资金争议关键词、置信度低于阈值、被处罚用户申诉） |
| `rate_limit.default` / `rate_limit.sensitive` | 接口限流阈值 |
| `retention` | 敏感数据保存期限（到期由定时任务清理） |
| `content.categories` | 可发布品类 |
| `upload.image` | 图片尺寸与体积约束 |

---

## 六、多校隔离实现说明

1. **学校是数据归属的唯一维度**：`books`、`threads`、`replies`、`conversations`、`messages`、`orders`、`order_status_log`、`wallet_transactions`、`reports`、`penalties`、`tickets`、`notifications`、`word_hits` 等一律带 `school_id`，并建立 `(school_id, status, created_at)` 类索引。
2. **服务端强制注入，客户端无法越权**：`server/src/middleware/school-scope.js`
   - 学生 / 学校管理员：`schoolId` **只取登录态**，忽略 query/body/params 传入的 `schoolId`（改包也无效）。
   - 客服 / 平台管理员（跨校角色）：**必须显式传 `schoolId`**，否则返回 `40302`；跨校访问自动写入审计日志 `cross_school_access`。
   - 平台级全局接口（`/admin/schools`、`/admin/configs`、`/admin/audit-logs`）不隶属任何学校，平台管理员无需传 `schoolId`，由 RBAC 兜底。
3. **查询强制带过滤**：所有 SQL 都形如 `WHERE school_id = ?`，`req.schoolId` 由中间件注入；跨校读取统一返回 **404（不泄露存在性）**，而非 403。
4. **校管只治理本校**：`requireSchoolModerator()` 额外校验 `school_admin` 的 `user.schoolId === req.schoolId`。
5. **跨校专区**：学校级开关 `cross_school_enabled` / `cross_school_mode`，默认关闭；开启后仅当前端显式 `crossSchool=true` 才把 `cross_school=1` 的教材并入结果集（首期仅支持邮寄）。
6. **登录即入校**：`GET /auth/me` 同时返回用户与学校配置，前端据此直接进入本校图书库与论坛，无需二次选择。
7. **验证方式**：`server/tests/integration/isolation.test.js` 覆盖跨校 404、传参无效、客服必须显式 schoolId、审计留痕、脱敏与配置化阈值。

---

## 七、验证方法（按阶段）

| 阶段 | 验证方法 |
| --- | --- |
| 多校与账号 | 用 `13800000001` 登录 → 只看到江南大学数据；用 `13900000002` 不传 `schoolId` 调 `/admin/users` → 返回 40302；注册时学校必须下拉选择 |
| 图书库 | `npm test` 中 `books` 相关用例；页面发布教材（含 9 张图压缩上传）→ 列表可见；未认证账号发布 → 40304 |
| 论坛 | 发求书帖/转让帖、评论与回复；含 L2 词（如微信引流）被拦截并提示具体违规词与位置 |
| 私信 | 图书详情页「联系卖家」→ 生成会话并复用；消息含违规词被拦截 |
| 交易托管 | `tests/integration/order-concurrency.test.js`（20 并发下单仅 1 单成功、无超卖）、`escrow.test.js`（支付托管、放款、退款、退货退款、争议冻结与暂停自动确认、仲裁、幂等） |
| 通知 | 下单/支付/发货/放款/处罚/认证结果均产生站内信；`/notifications/unread-count` 有未读数 |
| 信誉分与违规 | `tests/integration/penalty-rules.test.js`（10 级梯度、严重一票封禁、申诉回滚、过期与消除口径、封禁不锁资金）、`credit-tier.test.js`（5 档映射与联动权限） |
| 违禁词 | `tests/unit/normalize.test.js`（全半角/繁简/拼音谐音/零宽字符）、`tests/integration/word-rules.test.js`（四级处置、绕过、白名单、L1 累计禁言） |
| 客服工单 | 学生端「客服中心」→ AI 会话查询订单/信誉分、要求转人工生成工单；客服端抢单、快捷回复、一屏查看订单快照与用户风控历史、强制放款/退款 |
| 管理后台 | 平台管理员开通学校（自动生成论坛版块）、调整规则阈值、查看审计日志；校管/客服审核内容、审核认证、执行处罚 |

---

## 八、关键业务约束的实现位置

| 约束 | 实现 |
| --- | --- |
| 资金操作事务化 + 幂等 | `server/src/db/tx.js`（`withTransaction` + 死锁重试）、`server/src/lib/idempotency.js`（`idempotency_records` 唯一键） |
| 余额禁止直接改，全部走流水 | `server/src/services/wallet.service.js`（`record()` 写 `wallet_transactions` 并同步快照，可 `assertConsistency` 对账） |
| 防超卖 | `orders.active_book_id` 生成列 + 唯一索引；下单 `SELECT ... FOR UPDATE` 行锁 + 事务内二次校验 |
| 自动确认收货 | `server/src/jobs/scheduler.js`（分布式锁 `job_locks`），发货后 N 天自动确认；争议时置空 `auto_confirm_at` 暂停倒计时 |
| 处罚可申诉、可回滚 | `server/src/services/penalty.service.js`（`revoke()` 回滚信誉分）、`reports.routes.js` 申诉复审 |
| 敏感信息脱敏与分级 | `server/src/lib/mask.js`、`lib/crypto.js`（AES-256-GCM + HMAC 盲索引）、`audit_logs` 记录敏感读取、`jobs/retention.job.js` 按 `retention` 配置清理 |

---

## 九、后续接入真实支付与小程序上线的合规建议

### 1) 接入真实支付（微信支付 / 支付宝）

- **资金结算资质**：平台托管买家货款属于「代收代付」场景，需评估是否触及《非银行支付机构条例》与「二清」风险。建议与持牌支付机构/银行合作，采用**平台分账（服务商模式）**或**银行存管**，避免平台自有账户沉淀大量用户资金；服务费单独走平台商户号收取。
- **商户与实名**：学生卖家提现属于个人收款，需完成个人实名（姓名 + 身份证 + 收款账户一致性校验），并对接支付机构的**个人提现/分账**能力；提现需保留 24 小时冷却与短信/人脸二次验证。
- **对账与差错处理**：以支付机构账单为准做**日终对账**，`wallet_transactions` 增加渠道流水号与对账状态字段；退款走原路退回并保留凭证，争议资金在存管账户内冻结而非平台自持。
- **合规展示**：订单页明示「平台托管、买家确认收货前不向卖家放款」「服务费比例与收取主体」，提供电子协议与开票入口。
- **风控**：接入支付机构的风控与实名核验能力，防范洗钱、刷单套现与信用卡套现；对高频提现、异常设备、异地登录做限额与人工复核。

### 2) 小程序上线

- **主体与类目**：需企业主体（个人主体无法开通电商/交易类目）。选择「电商平台 / 二手交易」等相关类目，提交**增值电信业务经营许可证（ICP 许可证）**或平台服务资质说明（依微信最新要求）；涉及「出版物流通」应说明为个人闲置教材转让。
- **内容合规**：教材属于出版物，禁止销售盗版、影印版；违禁词库需覆盖「盗版、答案、代写、代考」等，并对出版物做关键词与图片 OCR 复核；建立**侵权投诉-下架-申诉**通道（通知-删除规则）。
- **用户协议与隐私**：提供《用户服务协议》《隐私政策》《未成年人保护条款》，明示收集的学号、手机号、收款账号的**目的、范围、保存期限**；学生证照片等敏感个人信息单独授权，支持导出与删除。
- **实名与年龄**：落实账号实名（手机号 + 学生认证 + 收款实名）；对未成年人（含未满 16 周岁）限制交易与收款，或要求监护人同意。
- **支付与订阅消息**：小程序内支付必须使用微信支付；通知优先用**订阅消息**（订单状态变更、认证结果、处罚与举报结果），需引导用户主动订阅。
- **数据与安全**：域名 HTTPS、接口鉴权与限流、敏感字段加密与脱敏展示、日志脱敏；按《个人信息保护法》做个人信息保护影响评估（PIA），并保留数据出境合规评估结论（如使用境外服务）。
- **审核注意**：提审时提供**测试账号**（本仓库种子账号即可）、完整功能路径说明；避免出现「代写、代考、答案」等违规内容与关键词；不得诱导站外交易（平台内闭环交易）。

### 3) 上线前检查清单

- [ ] 替换全部密钥（`JWT_SECRET`、`AES_KEY`、`HMAC_SECRET`）并接入密钥管理服务
- [ ] 关闭开发环境固定验证码（`SMS_DEV_CODE`），接入真实短信通道并做签名与频控
- [ ] 接入支付渠道并完成日终对账、退款、提现与差错处理流程
- [ ] 配置 `retention` 保存期限与定时清理，确认审计日志留存周期
- [ ] 补齐内容审核与举报处置的值班与 SLA 报警（工单超时、资金类 4 小时未响应）
- [ ] 完成压测（并发下单、限流、连接池）、备份恢复演练与灰度发布方案

---

## 十、免责与说明

- 本项目为教学/演示用途，短信、支付、微信授权与 OCR 均为模拟或规则实现。
- 请在合规前提下接入真实第三方服务，禁止用于任何违法用途。
- 设计文档见 `docs/`：需求拆解、技术选型、目录结构、数据库 ER、接口清单、多校隔离、规则配置、分阶段交付与验证、支付与小程序合规建议。
