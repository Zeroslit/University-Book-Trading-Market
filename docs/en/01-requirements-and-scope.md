[English](./01-requirements-and-scope.md) | [简体中文](../01-需求拆解与范围.md)

# 01 Requirements breakdown and scope

## 1. Business positioning
A **textbook recommerce platform** for universities across China. The platform operates in partitions by school (`school_id`): once students log in they land directly in their own school's book library and forum.
The platform side provides risk control (banned words, credit score, penalties and appeals) and customer support (AI + human tickets + financial arbitration).

## 2. Roles (RBAC)

| Role | `role` enum | Data visibility | Core capabilities |
| --- | --- | --- | --- |
| Student (buyer/seller) | `student` | Own school (plus the cross-school pool when the cross-school zone is enabled) | Register and verify, publish, search, post, comment, direct message, order, confirm receipt, withdraw, appeal |
| School admin / campus ambassador | `school_admin` | Own school | Content review, violation handling and dashboards for their own school |
| Human support agent | `support` | Cross-school as authorized by tickets | Ticket handling, order snapshots, violation history, complaint rulings, applying penalties, arbitration payout/refund |
| Platform admin | `platform_admin` | Global | School onboarding and configuration, word library and thresholds, cross-school rules, global bans, platform-wide dashboards |

> `support` / `platform_admin` may have `school_id = NULL` (their work spans schools). This is the **only** case where it may be null;
> their endpoints do not participate in "own-school filtering" and instead rely on explicit authorization plus audit trails (see `docs/en/06-multi-school-isolation.md`).

## 3. Functional scope

### 3.1 Delivered in phase 1 (In)
1. **Multi-school architecture**: school master data, search by province/city, school onboarding applications, per-school configuration (service fee rate, publishable categories, verification requirement, cross-school zone switch).
2. **Account system**: phone number + SMS code registration, password login and simulated WeChat login, `school_id + student_no` composite uniqueness, student verification (student card / campus email + manual review).
3. **Payout binding**: WeChat / Alipay / bank card, storing only the last four digits and a hash; rebinding or unbinding requires SMS two-factor confirmation and a 24-hour cooldown.
4. **Textbook library**: multi-image upload (compressed client-side to a long edge ≤ 1080px), book CRUD, filtering and sorting by keyword/course/price/condition, detail page (seller credit score, historical volume, contact seller, buy now).
5. **Forum**: wanted and for-sale threads, images, search, comments and replies, banned-word checks on both posting and commenting.
6. **Direct messages**: conversations started from a book or thread, conversation list, chat window, image messages, banned-word filtering.
7. **Trading and escrow**: a complete state machine, overselling protection, 7-day auto-confirm, dispute freezing, ledger trail, idempotency.
8. **Wallet**: balance/frozen amounts, simulated top-up, withdrawal (requires a bound payout method and verified identity), statements traceable by order number.
9. **Notifications**: in-app messages (guaranteed delivery) + WeChat subscription messages (simulated adapter).
10. **Credit score and violations**: starting at 100, score deltas, permissions linked to five tiers, detailed statement.
11. **Complaint → penalty → appeal**: report → acceptance → 48h evidence → ruling → penalty and score deduction → 3-day appeal window → re-review and rollback.
12. **Four-level banned-word system**: L1 masked prompt / L2 blocked / L3 blocked + score deduction + violation recorded / L4 deleted + escalated to a human + ban; normalized detection; hit trails and allowlists.
13. **Customer support**: AI assistant (FAQ + order lookup + action triggering), human-handover conditions, agent ticket queue (claim, quick replies, risk data on one screen, one-click penalties, arbitration), SLA breach escalation.
14. **Admin console**: school onboarding and configuration, content review, word library and thresholds, user management, order arbitration, ticket statistics, complaint and penalty dashboards.

### 3.2 Explicitly out of scope for phase 1 (Out)
- **No real payment integration**: payments, refunds and withdrawals are **simulated** inside the platform (`mock-pay`); they only produce ledger entries and state changes and never talk to WeChat/Alipay merchant accounts.
- **No real bank-card authentication**: no four-factor verification and no payout channel; only the last four digits and a hash are stored.
- **No real mini-program**: the front end is a responsive web app (Vue 3); see `docs/en/09-payment-and-mini-program-compliance.md` for mini-program conversion and compliance notes.
- **No real OCR**: image OCR runs through a pluggable adapter, `disabled` by default in phase 1 with manual spot checks; the interface and trails are already in place.
- **No real SMS**: SMS goes through the `sms.service.js` adapter, using the `console` driver in development; codes are stored in Redis (60s frequency control / 5-minute validity / attempt limit).
- **No real identity verification**: replaced by manual review of student cards / campus email, storing only masked fields.

## 4. Hard business constraints → where they are implemented

| Constraint | Implementation |
| --- | --- |
| Business data must carry `school_id`, with server-side filtering injected | `middleware/school-scope.js`; every SQL statement enforces `school_id = ?`; integration tests cover cross-school access blocking |
| Rule thresholds are configurable, never hard-coded | `configs` table + `services/config.service.js` (platform default → school override → cache); seed data writes the default thresholds |
| Money, penalties, tickets and word hits are all traceable | `wallet_transactions`, `penalties`, `ticket_logs`, `word_hits`, `audit_logs`, `order_status_log` |
| Money operations are transactional and idempotent | `db/tx.js` transaction wrapper + unique constraint on `wallet_transactions.idempotency_key` + `idempotency_records` |
| Sensitive data masked, access tiered, retention bounded | `lib/crypto.js` (AES-256-GCM), `lib/mask.js`, `audit_logs`, `jobs/retention.job.js` |
| Unit tests for critical flows | `server/tests/unit` + `server/tests/integration` |

## 5. Trading state machine

```
pending_payment ──pay──▶ paid (funds in escrow) ──ship──▶ shipped (awaiting receipt, 7-day auto-confirm countdown)
   │ cancel (unpaid)        │ refund_request ─▶ refund_requested ─agree─▶ refunded
   ▼                       │                                  └reject─▶ paid
cancelled                  │ dispute ─▶ disputed (payout frozen + auto-confirm paused)
                           │              └─arbitration─▶ arbitrated_refund / arbitrated_release
shipped ──confirm──▶ completed (payout to seller, platform service fee deducted)
shipped ──return_request──▶ return_requested ─agree─▶ refunded (return and refund, full escrow back to the buyer)
```
The transition table is configured in `configs.order_state_machine`; the code only validates and executes it and never hard-codes branches.

## 6. Credit tiers (defaults, all sourced from configuration and editable in the admin console)

| Tier | Score | Permission impact |
| --- | --- | --- |
| Excellent | 90–100 | Priority placement, instant withdrawal |
| Good | 70–89 | Normal |
| Restricted | 50–69 | At most 3 listed books, withdrawals delayed by 24 hours |
| High risk | 30–49 | Cannot publish new books |
| Critical | 0–29 | Trading disabled, browse only |

## 7. Acceptance criteria
Every phase ships: runnable endpoints + seed data + unit/integration tests + manual verification steps (see `docs/en/08-phased-delivery-and-verification.md`).
