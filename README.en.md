**English** | [简体中文](./README.md)

# Campus Textbook Circle · Nationwide University Textbook Recommerce Platform

A textbook recommerce platform for university students across China, covering **per-school data isolation, textbook library, campus forum, direct messaging, escrow-based payments, wallet, notifications, credit score and violation penalties, a 4-level prohibited-word risk engine, AI + human customer support ticketing, and an admin console**.

> Phase 1 is a **runnable demo environment**: SMS verification codes, payments and WeChat authorization are all **simulated**. It **does not integrate real payment channels or real bank-card authentication**, and the platform **never stores full card numbers, CVV codes or payment passwords**.

---

## 0. Live demo (no installation required)

**👉 <https://zeroslit.github.io/University-Book-Trading-Market/>** — click "进入在线演示" (Enter live demo)

Direct link to the demo app: **<https://zeroslit.github.io/University-Book-Trading-Market/web/>**

- A **pure static demo**: the front end plus an "in-browser mock backend" (`web/src/demo/`). No Node / MySQL / Redis needed; the data is a snapshot of the seeded database.
- Feature parity with a real deployment: per-school isolation, textbook library, forum, direct messages, escrow orders, payout and refund, credit tiers and penalty escalation, 4-level prohibited words, ticket SLA, AI support and the admin console are all clickable and end-to-end walkable.
- All writes affect only browser memory (localStorage) and **never touch any database**; payments, SMS and WeChat authorization are simulated.
- The login page offers "Demo · one-click role switch": students from three universities, a school admin, a human support agent and a platform admin.
- Shareable deep links jump straight into a role, e.g. `/web/login?demo=13800000001` (student) or `?demo=13900000003` (platform admin).
- The "Reset demo data" button in the header restores the initial seeded state.

> The mock backend mirrors the real backend **one-to-one** in routes, parameters and error codes (it reuses the text normalization, prohibited-word matcher, state machine, pagination and error codes from `server/src/lib/`).
> As a result, the page code runs unchanged in both modes: `web/src/api/client.js` switches the request channel based on `VITE_DEMO`.

---

## 1. Tech stack and architecture

| Layer | Technology |
| --- | --- |
| Front end | Vue 3 + Vite (responsive, mobile-first; no third-party UI library, lightweight in-house design system) |
| Back end | Node.js 20 + Express 4, RESTful JSON, unified response envelope and error codes |
| Database | MySQL 8 (utf8mb4, transactions + row locks + generated-column unique index) |
| Cache | Redis 7 (cache, rate limiting, SMS codes, idempotency locks; falls back to an in-memory implementation in development when unavailable) |
| Images | Compressed client-side to a long edge ≤ 1080px before upload, stored under `server/uploads/<date>/`; only the URL is persisted |
| Deployment | One-command startup with Docker Compose (MySQL + Redis + API + Web/Nginx) |

### Request pipeline

```
request → requestId → security headers → CORS → JSON parsing
        → authenticate (JWT) → schoolScope (single source of school filtering) → rateLimit
        → guards (verification / publishing / trading admission) → validate (zod) → business routes (every SQL carries school_id)
        → unified response { code, message, data, requestId }
        → errorHandler (business error code → HTTP status, with deadlock retry and sensitive-data masking)
```

Back-end layout: `server/src/{config,lib,db,middleware,services,modules,jobs}`; front-end layout: `web/src/{api,stores,router,components,views,utils,styles}`.
Demo layout: `web/src/demo/{server.js,store.js,rules.js,words.js,handlers/*,dataset.js}` (in-browser mock backend sharing the same contract as the real API).
See `docs/en/03-directory-structure.md` for the full directory reference.

---

## 2. Getting started

### Option 1: Docker Compose (recommended)

```bash
cp .env.example .env          # adjust secrets and ports as needed
docker compose up -d --build  # schema creation and seed data run automatically on first boot
```

- Web: http://localhost:8080
- API: http://localhost:3000/api/v1 (health check `GET /health`)
- To reset the demo data later: `docker compose run --rm db-init`

### Option 2: Local development (Windows / macOS / Linux)

```bash
# 1) Prepare MySQL 8 and Redis (Redis is optional; the backend degrades to in-memory)
# 2) Backend
cd server
npm install
cp .env.example .env          # set DB_HOST/DB_PORT/DB_PASSWORD for your environment
npm run db:reset              # schema + seed data (idempotent, safe to re-run)
npm run dev                   # http://127.0.0.1:3000

# 3) Frontend (separate terminal; Vite proxies /api and /static to port 3000)
cd web
npm install
npm run dev                   # http://127.0.0.1:5173
```

Helper scripts: `scripts/init-db.ps1` (Windows) and `scripts/init-db.sh` (macOS/Linux).

### Tests and builds

```bash
cd server && npm test         # 57 unit + integration tests (requires MySQL)
cd web && npm run build       # production build
```

### Building and publishing the pure static demo

Demo mode is controlled by an environment variable and does not affect local development or production builds:

```bash
cd web

# 1) Preview the demo locally (in-browser mock backend; no Node / MySQL needed)
VITE_DEMO=true npm run dev
#    Windows PowerShell: $env:VITE_DEMO='true'; npm run dev

# 2) Build the GitHub Pages sub-path demo (base must match the site sub-path, otherwise routing and assets 404)
VITE_DEMO=true VITE_BASE=/University-Book-Trading-Market/web/ npm run build
#    PowerShell: $env:VITE_DEMO='true'; $env:VITE_BASE='/University-Book-Trading-Market/web/'; npm run build
#    Output: web/dist (demo cover images under web/public/static/demo are included automatically)

# 3) Refresh the demo dataset: export the seeded database into web/src/demo/dataset.js and sync the cover images
node scripts/build-demo-dataset.mjs   # run `cd server && npm run db:reset` first
```

Publishing: put the contents of `web/dist` into the `web/` directory of the `gh-pages` branch, and place `.nojekyll` at the branch root (otherwise Jekyll ignores files starting with `_`); the repository Pages source points at the `gh-pages` branch root. The `404.html` at the branch root is the SPA fallback page so that deep links such as `/web/login` can be opened directly.

#### Mirror hosting for mainland China (Cloudflare Pages / Netlify)

`*.github.io` is intermittently reachable from mainland China; this is a network reachability issue, not a code issue. The repository ships a "same code, zero change" mirror setup:

```powershell
# 1) Build the mirror bundle (base=/web/, output in deploy/dist)
.\deploy\build-mirror.ps1

# 2) Web UI: drag the whole deploy/dist folder into Cloudflare Pages "Upload assets"
#    or use the CLI (a Cloudflare API token is required, see deploy/README-mirror-deploy.md)
.\deploy\deploy-cloudflare.ps1
```

You get addresses such as `https://campus-book-demo.pages.dev/` (landing page) and `https://campus-book-demo.pages.dev/web/` (demo app), with clearly better reachability from mainland China. Full steps, Netlify / Tencent Cloud EdgeOne alternatives and an FAQ are in [`deploy/README-mirror-deploy.md`](deploy/README-mirror-deploy.md).

### Seed data and demo accounts

All accounts share the password `Test@123456`; in development the SMS verification code is fixed to `123456`.

| Role | Account | Notes |
| --- | --- | --- |
| Student | `13800000001` ~ `13800000009` | Three students per university (Jiangnan University / Zhengzhou University of Light Industry / Chengdu University of Technology) |
| School admin | `13900000001` | Jiangnan University; can only manage this school's data |
| Human support | `13900000002` | Cross-school; pick a school in the navbar before acting |
| Platform admin | `13900000003` | Platform-wide: school onboarding, rule thresholds, audit logs, permanent bans |

Seed scale: 3 schools, 12 users, 10 textbooks, 5 threads + 6 replies, 2 escrow orders (one `paid` and held, one `completed` and released), 1 in-progress support ticket, 1 pending student verification, 1 pending school onboarding application, 26 banned words, 8 knowledge-base FAQs and 25 rule configs.

---

## 3. API documentation

- Unified prefix `/api/v1`; unified response envelope `{ code, message, data, requestId }`; paginated payloads use `{ list, total, page, pageSize, hasMore }`.
- Authentication: `Authorization: Bearer <accessToken>`; write operations involving money or orders should carry an `Idempotency-Key`.
- The complete API reference (parameters, error codes, examples) lives in `docs/en/05-api-reference.md`. Front-end call sites are centralized in `web/src/api/index.js`.

| Module | Main endpoints |
| --- | --- |
| Auth | `POST /auth/sms/send`, `POST /auth/register`, `POST /auth/login`, `POST /auth/login/wechat`, `GET /auth/me`, `POST /auth/password/reset` |
| Schools | `GET /schools` (province/city/keyword search), `GET /schools/provinces`, `POST /schools/applications`, `GET /schools/applications/list`, `POST /schools/applications/:id/review` |
| Users | `GET/PATCH /users/me/profile`, `GET /users/me/credit`, `GET /users/me/credit/logs`, `GET /users/:id/public` |
| Student verification | `POST /verifications`, `GET /verifications/me`, `GET /verifications`, `POST /verifications/:id/review` |
| Payout accounts | `GET/POST /payment-accounts`, `POST /payment-accounts/:id/unbind/code`, `POST /payment-accounts/:id/unbind`, `POST /payment-accounts/:id/default` |
| Uploads | `POST /uploads/image` (stores the URL only) |
| Textbook library | `GET /books`, `GET /books/:id`, `POST /books`, `PATCH /books/:id`, `POST /books/:id/off-shelf`, `POST /books/:id/relist` |
| Forum | `GET/POST /threads`, `GET/PATCH/DELETE /threads/:id`, `POST /threads/:id/replies`, `DELETE /replies/:id` |
| Direct messages | `GET/POST /conversations`, `GET/POST /conversations/:id/messages` |
| Orders | `GET/POST /orders`, `GET /orders/:id`, `POST /orders/:id/{pay,cancel,ship,confirm,refund-request,return-request,refund/agree,refund/reject,dispute,arbitrate}` |
| Wallet | `GET /wallet`, `GET /wallet/transactions`, `POST /wallet/recharge`, `POST /wallet/withdraw`, `GET /wallet/withdrawals` |
| Notifications | `GET /notifications`, `GET /notifications/unread-count`, `POST /notifications/:id/read`, `POST /notifications/read-all` |
| Risk control | `POST /words/check`, `GET/POST/PATCH/DELETE /admin/banned-words`, `GET /admin/banned-words/hits` |
| Reports and appeals | `POST /reports`, `GET /reports`, `POST /reports/:id/{accept,proof,decide}`, `POST /appeals`, `GET /appeals`, `POST /appeals/:id/review` |
| Customer support | `POST /chat/sessions`, `GET /chat/sessions/:id`, `POST /chat/sessions/:id/messages`, `POST /chat/sessions/:id/transfer`, `GET/POST /tickets`, `GET /tickets/stats`, `POST /tickets/:id/{claim,reply,resolve,escalate}`, `GET /kb/articles` |
| Admin console | `GET /admin/dashboard`, `GET/POST/PATCH /admin/schools`, `GET /admin/users`, `POST /admin/users/:id/{ban,unban}`, `GET /admin/users/:id/risk`, `GET /admin/contents`, `POST /admin/contents/:type/:id/review`, `GET /admin/orders`, `GET /admin/configs`, `PUT /admin/configs/:key`, `GET /admin/audit-logs` |

### Key error codes

| Code | Meaning | HTTP |
| --- | --- | --- |
| 40302 | Cross-school role did not explicitly pass `schoolId` | 403 |
| 40304 | Student verification not approved (browse-only) | 403 |
| 40306 | Trading is restricted | 403 |
| 40308 | Credit tier forbids publishing / trading | 403 |
| 40402/40403 | Cross-school reads of books/orders return "not found" | 404 |
| 40904 | Textbook already ordered / an active order exists | 409 |
| 40906 | Insufficient balance | 409 |
| 40907 | Idempotent duplicate request (ignored or first result returned) | 409 |
| 42201/42202 | Content blocked (L2 / L3) | 422 |
| 42203 | L1 prompt word masked (publishing allowed) | 200 |

---

## 4. Data model

35 tables in total (`server/src/db/migrations/001_init.sql`); every business table carries `school_id`:

| Group | Tables | Notes |
| --- | --- | --- |
| Master data | `schools`, `school_applications` | School master data (service fee, cross-school switch, forum sections, verification requirement) and onboarding applications |
| Accounts | `users`, `user_verifications`, `payment_accounts`, `sms_logs` | Users (`school_id + student_no` unique per school, phone number unique platform-wide), student verification, payout binding (last 4 digits + blind index only), SMS logs |
| Textbooks | `books`, `book_images` | Textbooks and images (`book_images.url` stores the URL only) |
| Forum | `threads`, `thread_images`, `replies` | Wanted/for-sale threads, thread images, replies and nested replies |
| Messaging | `conversations`, `messages` | Conversations and messages linked to a book or thread |
| Trading | `orders`, `order_status_log` | Orders (`active_book_id` generated column + unique index guarantee a single active order per textbook) and status transition log |
| Money | `wallet_accounts`, `wallet_transactions`, `withdraw_requests` | Wallet snapshot, **the full ledger (single source of truth)**, withdrawal requests |
| Credit | `credit_logs` | Credit score entries (with expiry and rollback flags) |
| Risk | `reports`, `penalties`, `appeals` | Report → evidence → ruling chain, penalty records (with appeal state and rollback), appeals |
| Banned words | `banned_words`, `word_hits` | 4-level word library (regex and allowlist aware) and hit trail (word, position, matched text, action taken) |
| Notifications | `notifications` | In-app messages + WeChat subscription messages (simulated) delivery records |
| Support | `tickets`, `ticket_logs`, `chat_sessions`, `chat_messages`, `kb_articles` | Tickets and transition logs, AI/human sessions and messages, knowledge-base FAQs |
| Platform | `configs`, `audit_logs`, `idempotency_records`, `job_locks`, `schema_migrations` | Rule thresholds, audit trail, idempotency records, distributed locks for scheduled jobs, migration history |

---

## 5. Rule configuration (fully configurable, never hard-coded)

All thresholds live in the `configs` table: `scope='platform'` holds the global default, `scope='school'` overrides it (school-level wins).
Reads go through `server/src/services/config.service.js` (cached with invalidation); admins adjust values via `GET /admin/configs` and `PUT /admin/configs/:key`.

| Key | Purpose |
| --- | --- |
| `credit.tiers` / `credit.bounds` / `credit.tier_permissions` | Credit tiers (boundaries at 90/70/50/30), score bounds, and tier-driven permissions (listing limit, withdrawal delay, publish/trade rights) |
| `credit.rules` | Score deltas: on-time shipping +2, positive review +1, 10 dispute-free orders +5, late shipping −5, description mismatch −10, upheld (minor) complaint −5, banned word −3, fake orders −30 |
| `credit.light_violation_expire_months` / `credit.clean_months_clear_count` | Rolling expiry window for minor violations and how many months of clean behaviour clear one violation |
| `penalty.escalation` | Penalty ladder: warnings for #1–2, 3-day mute + −5 for #3, 7-day trading restriction for #4, 7-day ban for #5, escalating bans for #6–9, permanent ban for #10; severe violations are banned permanently on the first offence |
| `banned_word.penalty` / `banned_word.normalize` / `banned_word.escalation` | L1–L4 actions and score deductions, normalization toggles (noise stripping / full-width / simplified-traditional / pinyin homophones), and cumulative mute thresholds (L1: 3 hits in a day → 1-day mute; L2/L3: 3 hits → 7-day mute, 5 hits → 30-day posting ban) |
| `order.state_machine` / `order.auto_confirm_days` / `order.ship_modes` / `order.service_fee_bps` / `order.ship_deadline_days` | Order state machine, auto-confirm days after shipping (default 7, paused on dispute), delivery modes, service fee (basis points), shipping deadline |
| `order.report_proof_hours` / `report.appeal_days` | Evidence window for the accused (48 hours) and appeal window (3 days) |
| `ticket.sla` / `ticket.auto_escalate` | Ticket SLA (24h first response for standard, 4h for money-related) and auto-escalation on breach |
| `ai.escalate_rules` | Conditions for handing an AI conversation to a human (user request, 2 unresolved turns, money-dispute keywords, confidence below threshold, appeal by a penalized user) |
| `rate_limit.default` / `rate_limit.sensitive` | Rate-limit thresholds |
| `retention` | Retention periods for sensitive data (scheduled jobs purge on expiry) |
| `content.categories` | Publishable categories |
| `upload.image` | Image dimension and size constraints |

---

## 6. Per-school data isolation

1. **The school is the single ownership dimension**: `books`, `threads`, `replies`, `conversations`, `messages`, `orders`, `order_status_log`, `wallet_transactions`, `reports`, `penalties`, `tickets`, `notifications`, `word_hits` and others all carry `school_id`, with indexes such as `(school_id, status, created_at)`.
2. **Injected server-side, unforgeable by clients**: `server/src/middleware/school-scope.js`
   - Students / school admins: `schoolId` is taken **from the session only**; any `schoolId` in query, body or params is ignored (tampering with the payload is useless).
   - Support / platform admins (cross-school roles): **must pass `schoolId` explicitly**, otherwise the API returns `40302`; cross-school access is automatically written to the audit log as `cross_school_access`.
   - Platform-wide endpoints (`/admin/schools`, `/admin/configs`, `/admin/audit-logs`) belong to no school, so the platform admin passes no `schoolId` and RBAC covers authorization.
3. **Filtering is mandatory in queries**: every SQL statement is shaped like `WHERE school_id = ?`, with `req.schoolId` injected by the middleware; cross-school reads uniformly return **404 (existence is not leaked)** rather than 403.
4. **School admins govern their own school only**: `requireSchoolModerator()` additionally verifies `user.schoolId === req.schoolId` for `school_admin`.
5. **Cross-school zone**: school-level switches `cross_school_enabled` / `cross_school_mode`, off by default; when enabled, textbooks flagged `cross_school=1` join the result set only if the client explicitly passes `crossSchool=true` (phase 1 supports mail delivery only).
6. **Login lands in the school directly**: `GET /auth/me` returns the user and the school configuration together, so the front end enters that school's book library and forum without a second selection step.
7. **How it is verified**: `server/tests/integration/isolation.test.js` covers cross-school 404s, ignored parameters, the mandatory explicit `schoolId` for support staff, audit trail and masked, configurable thresholds.

---

## 7. Verification by phase

| Phase | How to verify |
| --- | --- |
| Multi-school and accounts | Log in as `13800000001` → only Jiangnan University data is visible; call `/admin/users` as `13900000002` without `schoolId` → returns 40302; registration requires picking a school from the dropdown |
| Textbook library | `books` test cases in `npm test`; publish a textbook in the UI (with 9 compressed images) → it appears in the list; publishing as an unverified account → 40304 |
| Forum | Post a wanted/for-sale thread, comment and reply; content containing an L2 word (e.g. off-platform solicitation) is blocked with the exact offending word and position |
| Direct messages | "Contact seller" on a book detail page creates (and reuses) a conversation; messages containing banned words are blocked |
| Escrow trading | `tests/integration/order-concurrency.test.js` (20 concurrent orders, exactly 1 succeeds, no overselling) and `escrow.test.js` (escrow on payment, payout, refund, return-and-refund, dispute freezing with paused auto-confirm, arbitration, idempotency) |
| Notifications | Order creation/payment/shipping/payout, penalties and verification results all produce in-app messages; `/notifications/unread-count` reports an unread count |
| Credit and penalties | `tests/integration/penalty-rules.test.js` (10-step ladder, instant permanent ban for severe violations, appeal rollback, expiry and clearing rules, bans that never freeze funds) and `credit-tier.test.js` (5-tier mapping and linked permissions) |
| Banned words | `tests/unit/normalize.test.js` (full-width/half-width, simplified/traditional, pinyin homophones, zero-width characters) and `tests/integration/word-rules.test.js` (4-level actions, evasion attempts, allowlist, cumulative L1 mutes) |
| Support tickets | "Support center" on the student side → query orders and credit through the AI session, request a human to open a ticket; on the agent side: claim a ticket, use quick replies, see the order snapshot and the user's risk history on one screen, force payout/refund |
| Admin console | Platform admin onboards a school (forum sections are generated automatically), adjusts rule thresholds, reviews audit logs; school admins and support agents review content, approve verifications and apply penalties |

---

## 8. Where the hard business constraints are implemented

| Constraint | Implementation |
| --- | --- |
| Money operations are transactional and idempotent | `server/src/db/tx.js` (`withTransaction` + deadlock retry), `server/src/lib/idempotency.js` (unique key on `idempotency_records`) |
| Balances are never edited directly; everything goes through the ledger | `server/src/services/wallet.service.js` (`record()` writes `wallet_transactions` and syncs the snapshot; `assertConsistency` reconciles) |
| Overselling prevention | `orders.active_book_id` generated column + unique index; `SELECT ... FOR UPDATE` row lock on order creation plus a second check inside the transaction |
| Automatic receipt confirmation | `server/src/jobs/scheduler.js` (distributed lock via `job_locks`), auto-confirm N days after shipping; on dispute `auto_confirm_at` is cleared to pause the countdown |
| Penalties are appealable and reversible | `server/src/services/penalty.service.js` (`revoke()` rolls back the credit score), appeal re-review in `reports.routes.js` |
| Sensitive data masking and tiered access | `server/src/lib/mask.js`, `lib/crypto.js` (AES-256-GCM + HMAC blind index), `audit_logs` records sensitive reads, `jobs/retention.job.js` purges according to `retention` |

---

## 9. Compliance notes for real payments and mini-program launch

### 1) Integrating real payments (WeChat Pay / Alipay)

- **Settlement qualification**: holding buyer funds in escrow is a "collection and disbursement on behalf of others" scenario, so exposure to the Regulations on Non-Bank Payment Institutions and "second-tier clearing" risk must be assessed. Work with a licensed payment institution or bank using **platform profit sharing (service-provider model)** or **bank custody**, so the platform's own account never pools large user balances; collect the service fee through a dedicated platform merchant account.
- **Merchants and real-name checks**: student payouts are personal receipts, so personal real-name verification (name + ID + payout account consistency) is required, plus the provider's **personal payout / profit-sharing** capability; keep the 24-hour cooldown and SMS or face verification on withdrawals.
- **Reconciliation and error handling**: run **end-of-day reconciliation** against the provider's statements and add channel transaction IDs and reconciliation status to `wallet_transactions`; refunds go back to the original payment method with receipts retained, and disputed funds are frozen inside the custody account rather than held by the platform.
- **Compliant disclosure**: the order page must state "funds are held by the platform and are not released to the seller before the buyer confirms receipt" and who charges the service fee, with an e-contract and invoicing entry point.
- **Risk controls**: use the provider's risk and identity-verification capabilities to prevent money laundering, fake-order cash-out and credit-card cash-out; apply limits and manual review to frequent withdrawals, unusual devices and logins from unexpected locations.

### 2) Mini-program launch

- **Entity and category**: a corporate entity is required (individuals cannot open e-commerce/trading categories). Choose a category such as "e-commerce platform / second-hand trading" and submit an **ICP value-added telecom business licence** or platform service qualification description per WeChat's latest requirements; textbook circulation should be described as the resale of personal idle textbooks.
- **Content compliance**: textbooks are publications, so pirated or photocopied editions must be prohibited; the banned-word library must cover "pirated, answer keys, ghostwriting, exam sitting" and publications should be re-checked by keywords and image OCR; build a **takedown-and-appeal channel** for infringement complaints (notice-and-takedown).
- **User agreement and privacy**: provide Terms of Service, a Privacy Policy and minor-protection clauses, and disclose the **purpose, scope and retention period** for collected student IDs, phone numbers and payout accounts; obtain separate consent for sensitive personal data such as student card photos, and support export and deletion.
- **Real-name and age**: enforce account real-name (phone + student verification + payout real-name); restrict trading and payouts for minors (including under 16) or require guardian consent.
- **Payments and subscription messages**: in-mini-program payments must use WeChat Pay; prefer **subscription messages** for notifications (order status changes, verification results, penalties and report outcomes) and prompt users to subscribe.
- **Data and security**: HTTPS domains, API authentication and rate limiting, encrypted and masked sensitive fields, masked logs; run a Personal Information Protection Impact Assessment (PIA) under the Personal Information Protection Law and keep the conclusion of any cross-border data transfer assessment (if overseas services are used).
- **Review tips**: provide **test accounts** (the seed accounts in this repository work) and a complete feature walkthrough when submitting for review; avoid non-compliant content and keywords such as ghostwriting, exam sitting or answer keys, and never steer users to off-platform transactions.

### 3) Pre-launch checklist

- [ ] Replace every secret (`JWT_SECRET`, `AES_KEY`, `HMAC_SECRET`) and move to a key-management service
- [ ] Disable the fixed development verification code (`SMS_DEV_CODE`), integrate a real SMS channel with signature and frequency controls
- [ ] Integrate payment channels and complete reconciliation, refund, withdrawal and error-handling flows
- [ ] Configure `retention` periods and scheduled cleanup, and confirm the audit-log retention window
- [ ] Set up on-call coverage and SLA alerting for content review and report handling (ticket timeouts, money-related tickets unanswered for 4 hours)
- [ ] Complete load testing (concurrent orders, rate limits, connection pool), backup/restore drills and a canary release plan

---

## 10. Disclaimer

- This project is for teaching and demonstration purposes; SMS, payments, WeChat authorization and OCR are simulated or rule-based.
- Integrate real third-party services only in compliance with applicable regulations, and never for unlawful purposes.
- Design documents live in `docs/` (English translations in `docs/en/`): requirements breakdown, technology choices, directory structure, database ER design, API reference, per-school isolation, rule configuration, phased delivery and verification, and payment / mini-program compliance notes.

---

[简体中文](./README.md) · [Design docs (English)](./docs/en/README.md)
