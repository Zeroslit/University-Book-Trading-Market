[English](./04-database-er-design.md) | [简体中文](../04-数据库ER设计.md)

# 04 Database ER design

## 1. General design rules
- Primary keys are uniformly `id BIGINT UNSIGNED AUTO_INCREMENT`; timestamps are `created_at / updated_at DATETIME(3)`.
- **Every business table carries `school_id`** (except `schools` itself) with `idx_school_*` indexes; cross-school shared tables (`configs`, `banned_words`, `kb_articles`) use `school_id NULL` to mean platform level.
- Money is always stored in `*_cents INT UNSIGNED` (cents); floating point is forbidden.
- Sensitive fields: `*_enc` (AES-256-GCM ciphertext), `*_last4` (masked display), `*_hash` (HMAC blind index used for unique constraints and lookups).
- Status columns are uniformly `VARCHAR(32)` with application-level enum validation (the state machine can be extended from configuration, avoiding table changes for ENUMs).

## 2. Entity relationships (text ER)

```
schools 1 ── N users 1 ── N books 1 ── N book_images
                  │             └── N orders (buyer_id / seller_id both point at users)
                  ├── N user_verifications (student verification, may be resubmitted)
                  ├── N payment_accounts (payout binding, masked)
                  ├── 1 wallet_accounts 1 ── N wallet_transactions
                  ├── N credit_logs (credit score ledger)
                  ├── N penalties ── N appeals
                  ├── N reports (reporter_id / target)
                  ├── N threads 1 ── N replies (self-referencing parent_id)
                  ├── N conversations (buyer_id / seller_id) 1 ── N messages
                  ├── N notifications
                  ├── N tickets 1 ── N ticket_logs
                  ├── N chat_sessions 1 ── N chat_messages
                  └── N word_hits
orders 1 ── N order_status_log (state transition snapshots, including the operator)
orders 1 ── N wallet_transactions (escrow, payout and refund money flows are traceable)
tickets N ── 1 orders / users (source and related object)
configs: platform level (school_id NULL) and school level, key-value JSON with a version
```

## 3. Table inventory (33 tables)

### 3.1 Schools and accounts

| Table | Key fields | Constraints / notes |
| --- | --- | --- |
| `schools` | `name, province, city, code, status(active/pending/suspended), forum_sections JSON, service_fee_bps, allowed_categories JSON, require_student_verification, cross_school_enabled, cross_school_mode(off/mail)` | `uk_code(code)`; `idx_province_city`; per-school configuration (service fee, categories, verification, cross-school) |
| `users` | `school_id, student_no, phone_enc, phone_last4, phone_hash, password_hash, nickname, avatar_url, real_name_enc, real_name_mask, role, status, verification_status, bio, mute_until, trade_ban_until, login_ban_until, banned_permanently, wechat_openid` | `uk_phone(phone_hash)` unique platform-wide; `uk_school_student(school_id, student_no)` unique within a school; `uk_wechat(wechat_openid)`; `school_id` may be NULL for `support` and `platform_admin` |
| `user_verifications` | `user_id, school_id, method(student_card/campus_email), student_card_image_url, campus_email, status, reviewer_id, review_note, submitted_at, reviewed_at` | Browsing only until approved; resubmission supported (history retained) |
| `payment_accounts` | `user_id, school_id, type(wechat/alipay/bank), account_name_mask, account_no_last4, account_no_hash, bank_name, status, is_default, bound_at, unbind_at, cooldown_until` | Only the last four digits and a hash; 24h cooldown after rebinding/unbinding; `uk_user_type_hash(user_id, type, account_no_hash)` |
| `school_applications` | `name, province, city, applicant_name, applicant_phone_enc/last4/hash, note, status, reviewer_id, review_note` | The "apply to onboard a school" entry point; approval creates the school and generates its forum sections automatically |

### 3.2 Textbooks and community

| Table | Key fields | Constraints / notes |
| --- | --- | --- |
| `books` | `school_id, seller_id, title, author, publisher, isbn, course_name, category, condition_level, original_price_cents, price_cents, remark, status(draft/on_sale/locked/sold/off_shelf/banned), view_count, published_at` | `idx_school_status(school_id, status)`; full-text index `ft_title_author(title, author, course_name)` |
| `book_images` | `book_id, school_id, url, sort_order, width, height, size_bytes, ocr_status, ocr_text` | Only URLs are stored; the client compresses to a long edge ≤ 1080px |
| `threads` | `school_id, author_id, type(seek/sell), title, content, category, status, view_count, reply_count, word_hit_level` | Wanted / for-sale threads; `ft_thread(title, content)` |
| `thread_images` | `thread_id, school_id, url, sort_order` | Thread images |
| `replies` | `school_id, thread_id, author_id, parent_id, floor_no, content, status` | Nested replies via the self-referencing `parent_id` |
| `conversations` | `school_id, buyer_id, seller_id, book_id, thread_id, context_key, last_message_at, last_message_preview, status` | `uk_context(school_id, context_key)` avoids duplicate conversations; `context_key = smaller-id-larger-id-bookId-threadId` |
| `messages` | `school_id, conversation_id, sender_id, content, image_url, is_read, read_at, word_hit_level, status` | Message trail; retention period defined in `jobs/retention.job.js` |

### 3.3 Trading and money

| Table | Key fields | Constraints / notes |
| --- | --- | --- |
| `orders` | `order_no, school_id, book_id, buyer_id, seller_id, amount_cents, service_fee_bps, service_fee_cents, seller_income_cents, status, escrow_status, active_book_id (generated column), paid_at, shipped_at, auto_confirm_at, completed_at, cancelled_at, refund_amount_cents, dispute_reason, arbitration_result, express_company, express_no, version` | `uk_order_no`; `uk_active_book(active_book_id)` as the overselling safety net; `escrow_status(held/released/refunded/none)` |
| `order_status_log` | `order_id, school_id, from_status, to_status, operator_id, operator_role, reason, snapshot JSON` | Evidence chain for state transitions (including order snapshots) |
| `wallet_accounts` | `user_id, school_id, balance_cents, frozen_cents, version` | Derived cache computed from the ledger, updated in the same transaction |
| `wallet_transactions` | `tx_no, school_id, user_id, order_id, direction(in/out), account(balance/frozen), amount_cents, biz_type(recharge/escrow_hold/escrow_release/refund/withdraw/withdraw_freeze/fee/settle/adjust), status, idempotency_key, balance_after_cents, remark` | `uk_tx_no` and `uk_idem(idempotency_key)` guarantee idempotency; append-only, amounts may never be UPDATEd |
| `withdraw_requests` | `user_id, school_id, payment_account_id, amount_cents, fee_cents, status(pending/processing/paid/rejected), arrival_type(instant/delayed), expect_at, reviewed_by, reject_reason` | Withdrawal requires a bound payout method plus verified identity; the restricted tier is delayed by 24h |

### 3.4 Risk control: credit, reports, penalties, appeals, banned words

| Table | Key fields | Constraints / notes |
| --- | --- | --- |
| `credit_logs` | `user_id, school_id, delta, score_after, rule_key, reason, related_type, related_id, expires_at, rolled_back` | Append-only; `expires_at` implements the 12-month rolling expiry of minor violations |
| `reports` | `report_no, school_id, reporter_id, target_type(book/thread/reply/message/user/order), target_id, reason, evidence_enc JSON, status(pending/accepted/rejected/proving/decided/appealed/closed), severity(light/serious/severe), handler_id, proof_deadline_at, decision_note, appeal_deadline_at` | Report evidence is encrypted and access is tiered; only upheld rulings count as violations |
| `penalties` | `user_id, school_id, report_id, type(warning/mute/trade_ban/login_ban/permanent_ban), severity, effective_count, start_at, end_at, status(active/expired/revoked), reason, operator_id, appeal_status` | Penalty trail; the three ban switches (mute / trade ban / login ban) are independent columns on `users` |
| `appeals` | `appeal_no, school_id, user_id, penalty_id, report_id, reason, evidence_enc, status(pending/approved/rejected), reviewer_id, review_note, reviewed_at` | 3-day appeal window; approval revokes the penalty and rolls back the credit score |
| `banned_words` | `word, normalized_word, level(L1-L4), category, action, score_delta, scope(global/school), school_id, status` | Four-level word library; `uk_word_scope(word, scope, school_id)` |
| `word_hits` | `school_id, user_id, word_id, word, level, scene(book/thread/reply/message/bio/image_ocr/chat), target_type, target_id, matched_text, position, action_taken` | Hits must be traceable, so the exact word and position can be retrieved |

### 3.5 Notifications, support and system

| Table | Key fields | Constraints / notes |
| --- | --- | --- |
| `notifications` | `school_id, user_id, type, title, content, channel(inbox/wechat/sms), related_type, related_id, is_read, read_at, status` | Covers order changes, complaints, penalties, bans, verification results, ticket progress and banned-word reminders |
| `tickets` | `ticket_no, school_id, source(user/ai/report/word_hit/system), type(order/refund/account/content/other), priority(normal/urgent), related_order_id, related_user_id, reporter_id, assignee_id, status(pending/processing/resolved/closed/escalated), first_response_at, first_response_due_at, resolve_due_at, escalated, resolution` | SLA: 24h response for standard, 4h for money-related; auto-escalation on breach |
| `ticket_logs` | `ticket_id, school_id, action, operator_id, operator_type(user/ai/staff/system), from_status, to_status, note` | Full ticket transition trail |
| `chat_sessions` | `session_no, school_id, user_id, channel(ai/human), ticket_id, status(active/closed/transferred), context JSON, unresolved_rounds` | AI sessions and human handover |
| `chat_messages` | `session_id, school_id, role(user/ai/staff/system), content, intent, confidence, tool_calls JSON` | AI replies are logged (including confidence and tools invoked) |
| `kb_articles` | `school_id (NULL = platform-wide), category, question, answer, keywords, status, view_count, updated_by` | Knowledge-base FAQ, one of the three AI support capabilities |
| `configs` | `scope(platform/school), school_id, config_key, config_value JSON, description, version, updated_by` | `uk_config(scope, school_id, config_key)`; the single source of rule thresholds |
| `audit_logs` | `school_id, actor_id, actor_role, action, target_type, target_id, detail JSON, ip` | Trail for admin actions and sensitive reads |
| `idempotency_records` | `scope, idem_key, request_hash, response_snapshot JSON, status` | `uk_idem(scope, idem_key)`; endpoint-level idempotency (orders, payments, withdrawals) |
| `job_locks` | `job_name, locked_until, locked_by` | Distributed mutual exclusion for scheduled jobs (safe with multiple instances) |

## 4. Indexing and performance notes
- High-frequency list queries always use the composite `(school_id, status, created_at)` index to avoid cross-school scans.
- Textbooks, threads and the knowledge base use MySQL 8 full-text indexes (ngram parser) for Chinese keyword search.
- `orders.auto_confirm_at`, `tickets.first_response_due_at`, `tickets.resolve_due_at` and `credit_logs.expires_at` are indexed so scheduled jobs can scan them.
- Every unique constraint is enforced by the database; application-level checks only provide friendly messages (protection against concurrent bypasses).
