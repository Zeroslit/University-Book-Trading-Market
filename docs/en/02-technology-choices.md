[English](./02-technology-choices.md) | [简体中文](../02-技术选型说明.md)

# 02 Technology choices

## 1. Overview

| Layer | Choice | Version | Rationale |
| --- | --- | --- | --- |
| Front end | Vue 3 + Vite + Vue Router + Pinia | Vue 3.4 / Vite 5 | Composition API, fast builds; a single-page app that adapts to both desktop and mobile browsers |
| Back end | Node.js + Express | Node 20 / Express 4 | Mature ecosystem, clean layering, easy to split by module |
| Database | MySQL 8 | 8.0 | Transactions + row locks (`SELECT ... FOR UPDATE`) satisfy escrow and overselling protection; a generated-column unique index acts as a safety net |
| Cache / rate limiting | Redis 7 | 7.x | Verification codes, API rate limiting, config cache, sessions and idempotency locks |
| Images | Local directory or object storage, storing only the URL | - | Compressed client-side to a long edge ≤ 1080px, easy to migrate to OSS/COS |
| Authentication | JWT (access + refresh) | - | Stateless and easy to scale; `jti` supports a logout blacklist in Redis |
| Validation | Zod | 3.x | Declarative schema validation, errors mapped uniformly to business error codes |
| Testing | node:test (built into Node) + supertest | Node 20 | No extra test-framework dependency, low CI cost |
| Deployment | Docker Compose | - | Brings up MySQL + Redis + API + Web in one command |

## 2. Key trade-offs

### 2.1 Using a generated-column unique index to enforce "one active order per textbook"
MySQL has no partial unique index with a `WHERE` clause, yet this rule is a **financial safety** red line. The approach: define a STORED generated column
`active_book_id` on `orders`, which equals `book_id` only while the order is in an active state and is `NULL` otherwise, then build a unique index on `active_book_id`.
MySQL unique indexes allow multiple `NULL`s, which is equivalent to a partial unique index. Combined with `SELECT ... FROM books WHERE id = ? AND school_id = ? FOR UPDATE` inside the ordering transaction,
this yields **row lock + unique index** double protection (only one of several concurrent orders can succeed; the others receive a business error code).

### 2.2 Balances are derived from the ledger; the balance column is only a cache
The requirement states plainly that the balance field must never be edited directly. Implementation: `wallet_transactions` is the single source of truth (append-only);
`wallet_accounts.balance_cents / frozen_cents` are updated only **within the same transaction** as the ledger entry and serve as a read-performance cache;
`wallet.service.assertConsistency()` checks that "sum of ledger entries == account balance" and is called by both integration tests and periodic inspection jobs.

### 2.3 All rule thresholds live in the database
Credit tiers, penalty escalation, banned-word actions, SLA deadlines, service fee rates, the category allowlist and the state machine transition table all live in the `configs` table.
Lookup order is "school override → platform default → throw", with **no hard-coded fallback**, so rules can change without a release.

### 2.4 Three layers of multi-school isolation
1. **Middleware**: `schoolScope` resolves and pins `req.schoolId` (taken from the JWT for students and from an explicit parameter plus permission checks for admin roles);
2. **Data access layer**: repository function signatures require `schoolId`, every SQL statement is `AND school_id = ?`, and `assertSameSchool()` is provided;
3. **Database**: `school_id` is indexed on core tables and participates in composite unique keys (for example `users(school_id, student_no)`).

### 2.5 Permission boundary of the AI assistant
The AI is wired only to **read-only tools** (order lookup, shipment lookup, credit lookup, knowledge-base search) and **request-creating tools** (file a refund request, create a ticket).
Payout, refund, penalties and other money-moving or disciplinary actions are **not registered at all** in the tool registry of `ai-cs.service.js`, which guarantees at the code level that "the AI has no authority to pay out or refund directly".

## 3. Dependency direction

```
routes → service → repository(SQL) → db
        ↘ lib (errors / crypto / normalize / state-machine)
all modules ⇢ services/config.service (thresholds) · services/notify.service (notifications) · services/audit.service (trail)
```
Dependencies are one-way: repositories must never call services, and SQL must never be written directly in routes.

## 4. Security and compliance baseline
- Passwords use `bcryptjs` (cost 10); phone numbers, names and payout accounts use AES-256-GCM encryption plus HMAC-SHA256 blind indexes (for uniqueness and lookup).
- JWT access 2h / refresh 7d; the `jti` blacklist lives in Redis so a "login ban" can force an immediate logout.
- Site-wide rate limiting: 300 req/min/IP by default; sensitive endpoints such as login, verification codes, ordering and withdrawal use stricter thresholds stored in `configs.rate_limit`.
- Every write operation is recorded in `audit_logs` (who, when, on what, what they did, IP).
